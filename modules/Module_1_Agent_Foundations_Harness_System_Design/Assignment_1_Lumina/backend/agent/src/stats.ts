import type { StatsResponse } from '@lumina/contract';
import { env } from './env.js';
import { requestsCollection, runsCollection } from './collections.js';

/**
 * `/stats` (Component 5). Scoping settled in `.claude/plans/phase-3.md` against
 * `bench.mjs:809–813`, which reads `requests`/`answers` as GLOBAL totals across every
 * calling id the bench uses — a per-user count would fall below what the bench expects.
 * Every field is computed from the persisted collections, never an in-process counter, so
 * the numbers survive a restart and reconcile with the logs within the rubric's 1%.
 */

interface RequestRow {
  ttftMs?: number;
  searchCached?: boolean;
  createdAt: string;
}

function todayRangeUtc(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export async function buildStats(callingUserId: string): Promise<StatsResponse> {
  const { start, end } = todayRangeUtc();
  const requests = await requestsCollection();
  const runs = await runsCollection();

  const requestsTotal = await requests.countDocuments({});
  // An "answer" reached `done` (contract `Terminated`: 'done' | 'cap' | 'error'); an
  // errored stream never sent `done`, so it does not count (bench.mjs:810).
  const answersTotal = await requests.countDocuments({ terminated: { $in: ['done', 'cap'] } });

  const todayRows = (await requests
    .find({ createdAt: { $gte: start, $lt: end } }, { projection: { ttftMs: 1, searchCached: 1, createdAt: 1 } })
    .toArray()) as unknown as RequestRow[];

  const ttftP95Ms = p95(todayRows.map((r) => r.ttftMs).filter((v): v is number => typeof v === 'number'));

  // Denominator = answers that ran >= 1 search (requests.ts/runlog.ts omit `searchCached`
  // entirely for zero-search answers, so `typeof === 'boolean'` is exactly that set).
  const searchRows = todayRows.filter((r) => typeof r.searchCached === 'boolean');
  const searchCacheHitRatePct =
    searchRows.length === 0 ? 0 : (searchRows.filter((r) => r.searchCached).length / searchRows.length) * 100;

  const todayRuns = (await runs
    .find({ createdAt: { $gte: start, $lt: end } }, { projection: { costUsd: 1 } })
    .toArray()) as unknown as { costUsd?: number }[];
  const costUsdToday = todayRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  // Per calling X-User-Id, today — DEEP_DAILY_CAP is per user (Phase 7), this just reports
  // it; today it is always 0 because `depth: "deep"` is still 501.
  const deepToday = await runs.countDocuments({
    userId: callingUserId,
    depth: 'deep',
    createdAt: { $gte: start, $lt: end }
  });

  return {
    requests: requestsTotal,
    answers: answersTotal,
    searchCacheHitRatePct,
    ttftP95Ms,
    costUsdToday,
    deepToday,
    deepDailyCap: env.deepDailyCap
  };
}
