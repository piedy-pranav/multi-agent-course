import { ChunkDoc, SEARCH_INDEXES } from '@lumina/contract';
import { chunksCollection } from '../collections.js';
import { env } from '../env.js';

/**
 * Phase 5 C8 / D12: the read-your-write probe — the thing that earns `indexed`.
 *
 * "Upserted" is not "searchable". Atlas Search indexes are eventually consistent, so a
 * document whose chunks have been inserted is not yet retrievable, and marking it `indexed`
 * at insert time produces the single most confusing bug in this phase: everything looks
 * ingested and every question finds nothing (TECHNICAL.md:372).
 *
 * Two deliberate properties:
 *
 * 1. **It queries by `docId` directly and does NOT reuse the retrieval path.** C9's retrieval
 *    excludes chunks whose document is not yet `indexed` — and at probe time this document is
 *    `embedding` by construction, so reusing it would make the probe unsatisfiable forever.
 * 2. **The tenancy filters live INSIDE `$vectorSearch`**, not in a later `$match`, exactly as
 *    the real retrieval does. The probe is also the first live proof that the index's filter
 *    fields work; probing without them would pass while retrieval was broken.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProbeTarget {
  userId: string;
  spaceId: string;
  docId: string;
  /** A chunk that was just written, and its own vector — the nearest possible query. */
  chunkId: string;
  embedding: number[];
}

/** One attempt. `true` only when a chunk of THIS document came back. */
export async function probeOnce(target: ProbeTarget): Promise<boolean> {
  const col = await chunksCollection<ChunkDoc>();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    // The local-dev backend scores in Node over the collection itself, so there is no index
    // and no lag to wait for — but the probe still has to prove the row is READABLE under the
    // same tenancy predicate retrieval will use, rather than being skipped as a formality.
    const row = await col.findOne({ _id: target.chunkId, docId: target.docId, spaceId: target.spaceId, userId: target.userId });
    return row !== null;
  }

  const hits = await col
    .aggregate([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.chunksVector,
          path: 'embedding',
          queryVector: target.embedding,
          numCandidates: 50,
          limit: 10,
          // INSIDE the stage (AGENTS.md:87). A later $match would return another Space's
          // chunks first and then hide them, which quietly breaks recall.
          filter: { spaceId: target.spaceId, userId: target.userId }
        }
      },
      { $match: { docId: target.docId } },
      { $project: { _id: 1 } },
      { $limit: 1 }
    ])
    .toArray();

  return hits.length > 0;
}

export interface ProbeResult {
  ok: boolean;
  attempts: number;
  waitedMs: number;
}

/**
 * Bounded retry with linear backoff. Bounded matters in both directions: too few attempts
 * fails a document that was merely slow to index, and unbounded retries turn a genuinely
 * broken index into a job that never finishes and never reports why.
 *
 * A thrown error (a missing index, a malformed query) is NOT swallowed into "not yet
 * searchable" — that is the difference between "wait longer" and "this will never work", and
 * conflating them is how a configuration error becomes a mysterious timeout.
 */
export async function waitUntilSearchable(target: ProbeTarget): Promise<ProbeResult> {
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= env.docProbeMaxAttempts; attempt++) {
    if (await probeOnce(target)) {
      return { ok: true, attempts: attempt, waitedMs: Date.now() - startedAt };
    }
    if (attempt < env.docProbeMaxAttempts) await sleep(env.docProbeBackoffMs);
  }
  return { ok: false, attempts: env.docProbeMaxAttempts, waitedMs: Date.now() - startedAt };
}
