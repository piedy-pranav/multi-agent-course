import { MemoryDoc, EMBEDDING_DIMS, SEARCH_INDEXES, newId } from '@lumina/contract';
import type { Memory } from '@lumina/contract';
import { memoriesCollection } from './collections.js';
import { embed } from './embed.js';
import { env } from './env.js';

const RECALL_LIMIT = 10;
const CONTEXT_MAX_CHARS = 4000;

export interface SaveMemoryResult {
  id: string;
  tokens: number;
}

/** No embedding returned over HTTP, ever (D11). */
function toMemory(doc: MemoryDoc): Memory {
  return {
    id: doc._id,
    text: doc.text,
    sourceThread: doc.sourceThread,
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : doc.createdAt.toISOString()
  };
}

export async function countMemories(userId: string): Promise<number> {
  return (await memoriesCollection<MemoryDoc>()).countDocuments({ userId });
}

/**
 * Trim → exact-text dedupe per user → embed → validate against the contract → insert. A
 * caller catches a thrown embed/parse/insert error and records it as a failed write
 * (D9/D9a) — this function itself never swallows a failure into a plausible-looking save.
 */
export async function saveMemory(
  userId: string,
  text: string,
  sourceThread?: string,
  signal?: AbortSignal
): Promise<SaveMemoryResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('save_memory: text is empty');

  const col = await memoriesCollection<MemoryDoc>();
  const existing = await col.findOne({ userId, text: trimmed });
  if (existing) return { id: existing._id, tokens: 0 };

  const { embedding, tokens } = await embed(trimmed, signal);

  const doc = MemoryDoc.parse({
    _id: newId('mem'),
    userId,
    text: trimmed,
    embedding,
    sourceThread,
    createdAt: new Date().toISOString()
  });

  await col.insertOne(doc);
  return { id: doc._id, tokens };
}

/** User-scoped, newest-first, no embedding ever leaves this function. */
export async function listMemories(userId: string): Promise<Memory[]> {
  const rows = await (await memoriesCollection<MemoryDoc>())
    .find({ userId }, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => toMemory(r as MemoryDoc));
}

/** Always 204-shaped: never throws on a missing/foreign/malformed id (D4/D13). */
export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  await (await memoriesCollection<MemoryDoc>()).deleteOne({ _id: memoryId, userId });
}

export interface RecallResult {
  memories: Memory[];
  tokens: number;
  usedFallback: 'none' | 'recency';
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function recencyFallback(userId: string): Promise<Memory[]> {
  const rows = await (await memoriesCollection<MemoryDoc>())
    .find({ userId }, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .limit(RECALL_LIMIT)
    .toArray();
  return rows.map((r) => toMemory(r as MemoryDoc));
}

/**
 * D1's pre-flight calls `countMemories` first and skips this entirely when a user has
 * none. When it does run: Atlas vector search filtered by userId inside the $vectorSearch
 * stage, or (VECTOR_BACKEND=mongo-cosine-scan) an in-Node cosine scan over that user's own
 * memories only — D11, never a cross-user comparison. If the vector path returns zero
 * while the user does have memories, fall back to a visible, trace-reported recency list
 * (D6/GAP-015) rather than reporting an empty recall that looks indistinguishable from
 * "nothing stored".
 */
export async function recallMemories(userId: string, query: string, signal?: AbortSignal): Promise<RecallResult> {
  const { embedding: queryEmbedding, tokens } = await embed(query, signal);
  const col = await memoriesCollection<MemoryDoc>();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    const rows = (await col.find({ userId }, { projection: {} }).toArray()) as MemoryDoc[];
    const scored = rows
      .map((r) => ({ doc: r, score: cosineSim(queryEmbedding, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_LIMIT)
      .map((s) => toMemory(s.doc));
    if (scored.length === 0 && rows.length > 0) {
      return { memories: await recencyFallback(userId), tokens, usedFallback: 'recency' };
    }
    return { memories: scored, tokens, usedFallback: 'none' };
  }

  const pipeline = [
    {
      $vectorSearch: {
        index: SEARCH_INDEXES.memoriesVector,
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: RECALL_LIMIT * 10,
        limit: RECALL_LIMIT,
        filter: { userId }
      }
    },
    { $project: { embedding: 0 } }
  ];
  const rows = (await col.aggregate(pipeline).toArray()) as MemoryDoc[];

  if (rows.length === 0 && (await countMemories(userId)) > 0) {
    return { memories: await recencyFallback(userId), tokens, usedFallback: 'recency' };
  }

  return { memories: rows.map(toMemory), tokens, usedFallback: 'none' };
}

/** D7: a separate labelled block, capped by count and chars, injected before the query. */
export function buildMemoryContextBlock(memories: Memory[]): string | null {
  if (memories.length === 0) return null;
  const capped = memories.slice(0, RECALL_LIMIT);
  let block =
    'Known stored preferences and facts about this user (saved explicitly; may be irrelevant):\n';
  for (const m of capped) {
    const line = `- ${m.text}\n`;
    if (block.length + line.length > CONTEXT_MAX_CHARS) break;
    block += line;
  }
  return block;
}

export { EMBEDDING_DIMS };
