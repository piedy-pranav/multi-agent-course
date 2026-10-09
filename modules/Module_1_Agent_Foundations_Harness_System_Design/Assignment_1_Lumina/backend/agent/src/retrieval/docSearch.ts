import { ChunkDoc, DocumentDoc, SEARCH_INDEXES, type Locator } from '@lumina/contract';
import { chunksCollection, documentsCollection } from '../collections.js';
import { embed } from '../embed.js';
import { env } from '../env.js';
import { reciprocalRankFusion } from './rrf.js';

/**
 * Phase 5 C9 / D13: hybrid document retrieval — dense `$vectorSearch` plus a lexical half,
 * fused with RRF.
 *
 * Both halves are scoped by `userId` AND `spaceId`, and on the Atlas path both filters live
 * INSIDE the search stage rather than in a later `$match` (AGENTS.md:87). That is not a
 * micro-optimisation: `$vectorSearch` returns its k nearest neighbours and only then would a
 * `$match` run, so filtering afterwards means another Space's chunks consume the k slots and
 * get discarded, quietly destroying recall (TECHNICAL.md:382).
 */

export interface DocHit {
  chunkId: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  ord: number;
  score: number;
  /** 1-based rank in each half that found it, so the trace can explain why it surfaced. */
  ranks: Record<string, number>;
}

export interface DocSearchResult {
  hits: DocHit[];
  /** Per-half counts. A silently-empty lexical half is the failure mode D13 warns about —
   * RRF would degrade to dense-only with no error anywhere — so the counts are returned,
   * logged, and asserted in verification rather than assumed. */
  vectorCount: number;
  lexicalCount: number;
  /** Which lexical implementation ran: real Atlas BM25, or the labelled dev fallback. */
  lexicalKind: 'atlas-bm25' | 'dev-lexical-overlap';
  indexedDocs: number;
  embeddingTokens: number;
}

export interface DocSearchArgs {
  userId: string;
  spaceId: string;
  query: string;
  signal?: AbortSignal;
}

interface ChunkRow {
  _id: string;
  docId: string;
  text: string;
  locator: Locator;
  ord: number;
}

const CHUNK_PROJECTION = { _id: 1, docId: 1, text: 1, locator: 1, ord: 1 } as const;

export async function searchDocuments(args: DocSearchArgs): Promise<DocSearchResult> {
  const { userId, spaceId, query, signal } = args;

  // Only `indexed` documents are retrievable. A document that failed partway through
  // ingestion can have left real chunks behind (the worker writes in batches and only
  // deletes them on the NEXT attempt), and citing those would attribute evidence to a
  // document whose ingestion never completed.
  const docs = await (await documentsCollection<DocumentDoc>())
    .find({ spaceId, userId, status: 'indexed' }, { projection: { _id: 1, title: 1 } })
    .toArray();

  const titleOf = new Map(docs.map((d) => [d._id, d.title]));
  const indexedDocIds = docs.map((d) => d._id);

  // A legitimate empty: a Space with nothing indexed yet. Not an error — the caller reports
  // `ok:true` with no results and the answer says there is no document evidence.
  if (indexedDocIds.length === 0) {
    return {
      hits: [],
      vectorCount: 0,
      lexicalCount: 0,
      lexicalKind: env.vectorBackend === 'atlas-vector-search' ? 'atlas-bm25' : 'dev-lexical-overlap',
      indexedDocs: 0,
      embeddingTokens: 0
    };
  }

  const { embedding, tokens } = await embed(query, signal);
  const col = await chunksCollection<ChunkDoc>();

  const dense =
    env.vectorBackend === 'atlas-vector-search'
      ? await denseAtlas(col, embedding, spaceId, userId, indexedDocIds)
      : await denseCosineScan(col, embedding, spaceId, userId, indexedDocIds);

  const lexical =
    env.vectorBackend === 'atlas-vector-search'
      ? { rows: await lexicalAtlas(col, query, spaceId, userId, indexedDocIds), kind: 'atlas-bm25' as const }
      : { rows: await lexicalDevFallback(col, query, spaceId, userId, indexedDocIds), kind: 'dev-lexical-overlap' as const };

  const fused = reciprocalRankFusion(
    { vector: { items: dense }, lexical: { items: lexical.rows } },
    (row) => row._id,
    env.docRrfK
  );

  const hits: DocHit[] = fused.slice(0, env.docFinalTopK).map((entry) => ({
    chunkId: entry.item._id,
    docId: entry.item.docId,
    title: titleOf.get(entry.item.docId) ?? entry.item.docId,
    text: entry.item.text,
    locator: entry.item.locator,
    ord: entry.item.ord,
    score: entry.score,
    ranks: entry.ranks
  }));

  return {
    hits,
    vectorCount: dense.length,
    lexicalCount: lexical.rows.length,
    lexicalKind: lexical.kind,
    indexedDocs: indexedDocIds.length,
    embeddingTokens: tokens
  };
}

// ---------------------------------------------------------------- dense

type ChunkCollection = Awaited<ReturnType<typeof chunksCollection<ChunkDoc>>>;

async function denseAtlas(
  col: ChunkCollection,
  queryVector: number[],
  spaceId: string,
  userId: string,
  indexedDocIds: string[]
): Promise<ChunkRow[]> {
  // Over-fetch before the `indexed` filter: that filter cannot live inside $vectorSearch
  // (the index declares only spaceId and userId as filter fields), so asking for exactly
  // top-k and then dropping rows would silently return fewer than k.
  const limit = env.docVectorTopK;
  const rows = await col
    .aggregate<ChunkRow>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.chunksVector,
          path: 'embedding',
          queryVector,
          numCandidates: Math.max(100, limit * 15),
          limit: limit * 2,
          // Tenancy filters INSIDE the stage. Never a later $match.
          filter: { spaceId, userId }
        }
      },
      { $match: { docId: { $in: indexedDocIds } } },
      { $project: CHUNK_PROJECTION },
      { $limit: limit }
    ])
    .toArray();
  return rows;
}

/** D14: the documented local-dev backend — exact cosine over the already-scoped chunks.
 * Honest for a few thousand chunks, useless beyond, and `/health` names which one is live. */
async function denseCosineScan(
  col: ChunkCollection,
  queryVector: number[],
  spaceId: string,
  userId: string,
  indexedDocIds: string[]
): Promise<ChunkRow[]> {
  const rows = await col
    .find(
      { spaceId, userId, docId: { $in: indexedDocIds } },
      { projection: { ...CHUNK_PROJECTION, embedding: 1 } }
    )
    .toArray();

  const scored = rows.map((r) => {
    const embedding = (r as unknown as { embedding: number[] }).embedding;
    return { row: r as unknown as ChunkRow, score: cosine(queryVector, embedding) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, env.docVectorTopK).map((s) => s.row);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------- lexical

/**
 * The BM25 half, via Atlas Search on `chunks_text`.
 *
 * `spaceId` and `userId` are mapped as **`token`** in that index (scripts/indexes.json), so
 * the scoping operator is `equals`, NOT `text`. A `text` operator against a token path
 * matches nothing, returns an empty list with no error, and RRF then degrades to dense-only
 * — "hybrid retrieval" that is really half a system, with no symptom to notice. That is why
 * `lexicalCount` is reported and asserted rather than trusted.
 *
 * A thrown error here is NOT caught: a missing or broken search index is a configuration
 * failure the caller must surface (`ok:false`), not something to paper over by quietly
 * returning fewer sources.
 */
async function lexicalAtlas(
  col: ChunkCollection,
  query: string,
  spaceId: string,
  userId: string,
  indexedDocIds: string[]
): Promise<ChunkRow[]> {
  const limit = env.docTextTopK;
  return col
    .aggregate<ChunkRow>([
      {
        $search: {
          index: SEARCH_INDEXES.chunksText,
          compound: {
            filter: [
              { equals: { path: 'spaceId', value: spaceId } },
              { equals: { path: 'userId', value: userId } }
            ],
            must: [{ text: { path: 'text', query } }]
          }
        }
      },
      { $limit: limit * 2 },
      { $match: { docId: { $in: indexedDocIds } } },
      { $project: CHUNK_PROJECTION },
      { $limit: limit }
    ])
    .toArray();
}

/**
 * D14: a dev-only lexical fallback for a plain `mongod`, which has no Atlas Search. Scored by
 * query-token overlap with a length penalty — deliberately crude.
 *
 * This is NOT BM25 and must never be called BM25: it has no IDF, no term saturation, and no
 * tuned length normalisation, so its ranking differs from the deployed path's. `/health`
 * reporting `mongo-cosine-scan` is what tells a grader a recall number came from here.
 */
async function lexicalDevFallback(
  col: ChunkCollection,
  query: string,
  spaceId: string,
  userId: string,
  indexedDocIds: string[]
): Promise<ChunkRow[]> {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const rows = await col
    .find({ spaceId, userId, docId: { $in: indexedDocIds } }, { projection: CHUNK_PROJECTION })
    .toArray();

  const scored = rows.map((r) => {
    const row = r as unknown as ChunkRow;
    const text = row.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (text.includes(t)) hits++;
    return { row, score: hits / Math.sqrt(Math.max(1, row.text.length / 500)) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, env.docTextTopK)
    .map((s) => s.row);
}
