import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { RunLog, type RunDoc } from '@lumina/contract';
import { env } from './env.js';
import { elapsedSec, allSearchesCached, type RunState } from './run.js';
import { runsCollection, requestsCollection } from './collections.js';

/**
 * Assembles the run record in the contract's `RunLog` shape and validates it. Phase 2
 * builds this in memory and logs it; writing `runs/<requestId>.json` is Phase 3 (GAP-004) —
 * this is shaped now so that phase only has to serialize.
 *
 * `tokens` here is a single total, not the `{in, out}` split the `done` SSE event carries —
 * same run, two shapes, on purpose (RunLog's own comment in the contract).
 */
export function buildRunLog(state: RunState): RunLog {
  const record: RunLog = {
    tokens: state.tokensIn + state.tokensOut,
    wallClockSec: elapsedSec(state),
    costUsd: state.costUsd,
    terminated: state.terminated,
    depth: state.depth,
    toolCalls: state.toolCalls.map((c) => ({
      name: c.name,
      ok: c.ok,
      ...(c.error !== undefined ? { error: c.error } : {}),
      ms: c.ms
    }))
  };

  // Validates against the contract schema itself — including its superRefine that a
  // failed tool call must carry a non-empty error string. A record that doesn't parse here
  // is a bug in run-state bookkeeping, not something to paper over with `as RunLog`.
  return RunLog.parse(record);
}

export interface PersistRunArgs {
  requestId: string;
  userId: string;
  threadId: string;
  answerId: string;
  ttftMs: number;
}

/**
 * GAP-004 (close): one `runs/<requestId>.json` per answer, plus the `runs`/`requests` rows
 * that make `/stats` (Component 5) queryable without re-reading the file. Called AFTER
 * `done`/`res.end()` — delivery of a correct answer is never blocked on observability
 * (BUG-006's trade-off, generalized). Mongo is the durable record and is written first;
 * `scripts/export-runs.mjs` regenerates the file FROM the `runs` collection, never the
 * reverse. Four writes, four independent `try/catch`es (one here, three below, plus the
 * caller's own message-append) — one broken sink must not take the other three down with
 * it, so none of them is chained or awaited inside a shared block.
 */
export async function persistRun(state: RunState, args: PersistRunArgs, log: Logger): Promise<void> {
  const runLog = buildRunLog(state);
  // D5: a request with zero searches is not "every search hit" — omit the field entirely
  // (rather than writing `false`) so `/stats`'s cache-hit-rate denominator can tell a
  // non-searching answer apart from a searching one that missed.
  const searchCached = state.searchesTotal > 0 ? allSearchesCached(state) : undefined;

  // GAP-010: embedding tokens/cost are Phase 4 additions on top of the contract's RunLog
  // shape (which only knows the LLM's `tokens`/`costUsd`). `embeddingCostUsd` is already
  // folded into `runLog.costUsd` via `recordEmbeddingUsage` (D5: one true cost total) —
  // this is the breakdown, additive on the Mongo rows and the file, same precedent as
  // `ttftMs`/`searchCached` (GAP-006): nothing in the contract is `.strict()`, so an extra
  // key here is informative, never a validation hazard for anything that reads RunLog's
  // own declared fields.
  const fileRecord = {
    ...runLog,
    embeddingTokens: state.embeddingTokens,
    ...(state.memoryWrites.length ? { memoryWrites: state.memoryWrites } : {})
  };

  try {
    const runDoc: RunDoc = {
      ...runLog,
      requestId: args.requestId,
      userId: args.userId,
      threadId: args.threadId,
      answerId: args.answerId,
      query: state.query,
      createdAt: new Date().toISOString()
    };
    await (await runsCollection<RunDoc>()).updateOne(
      { requestId: args.requestId },
      { $set: { ...runDoc, embeddingTokens: state.embeddingTokens, memoryWrites: state.memoryWrites } },
      { upsert: true }
    );
  } catch (err) {
    log.error({ err, requestId: args.requestId }, 'failed to upsert the runs collection row');
  }

  try {
    await writeFile(join(env.runsDir, `${args.requestId}.json`), JSON.stringify(fileRecord, null, 2));
  } catch (err) {
    log.error({ err, requestId: args.requestId }, 'failed to write runs/<requestId>.json');
  }

  try {
    // Merges onto the SAME row the request-logging middleware (index.ts) already wrote on
    // `res.on('finish')` — upsert either way, since the two writes can land in either
    // order. ttftMs/searchCached/embeddingTokens have no declared home on RequestDoc;
    // additive fields are fine since nothing in the contract is `.strict()` (StatsResponse
    // gap, Component 5).
    await (await requestsCollection()).updateOne(
      { requestId: args.requestId },
      {
        $set: {
          tokensIn: state.tokensIn,
          tokensOut: state.tokensOut,
          costUsd: state.costUsd,
          embeddingTokens: state.embeddingTokens,
          toolCalls: state.toolCalls.length,
          terminated: state.terminated,
          depth: state.depth,
          ttftMs: args.ttftMs,
          ...(searchCached !== undefined ? { searchCached } : {})
        }
      },
      { upsert: true }
    );
  } catch (err) {
    log.error({ err, requestId: args.requestId }, 'failed to enrich the requests collection row');
  }
}
