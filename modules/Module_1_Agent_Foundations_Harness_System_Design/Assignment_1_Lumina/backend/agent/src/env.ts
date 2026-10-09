import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5',

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),
  // Nothing in SPEC.md/AGENTS.md/TECHNICAL.md/DESIGN.md declares a tier-1 capacity beyond
  // "in-process LRU" — Phase 3 plan D5 picks 500 as a documented default, generous against
  // the bench's 20-distinct-query workload while still bounded.
  searchCacheLruMax: num(process.env.SEARCH_CACHE_LRU_MAX, 500),

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  // Phase 4 plan D5: bound each embedding request to ~8s so a hanging provider can't hang
  // the ask it's recalling/saving for. Nothing in SPEC.md/AGENTS.md declares this number.
  embeddingTimeoutMs: num(process.env.EMBEDDING_TIMEOUT_MS, 8000),

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),
  // Not in AGENTS.md's table, but the phase brief calls for a token ceiling alongside
  // tool-call and wall-clock caps — a loop that re-sends the whole history every turn can
  // run away on tokens well before either of those trips. The deep default is not a guess:
  // expectations.json's `budget.maxTokensPerRun: 180000` is declared there as exactly this —
  // the deep envelope ("a deep run: plan + ~12 fetched pages + synthesis"). Quick has no
  // declared number anywhere, so it is scaled off deep by the same 8:24 ratio already used
  // for maxToolCalls, rather than invented independently.
  maxTokensTotal: num(process.env.MAX_TOKENS_TOTAL, 60_000),
  maxTokensTotalDeep: num(process.env.MAX_TOKENS_TOTAL_DEEP, 180_000),

  // ---- Phase 5 D9: ingestion + document retrieval. Declared config, never magic numbers
  // inlined at a call site, because these are exactly the knobs recall@5 gets tuned with.
  /** Chunk size has an UPPER bound on purpose: the whole chunk becomes the citation
   * `snippet` (D16), and the gold set's anchor-matched items are only found if the anchor is
   * inside the emitted snippet. */
  docChunkTargetChars: num(process.env.DOC_CHUNK_TARGET_CHARS, 1000),
  docChunkOverlapChars: num(process.env.DOC_CHUNK_OVERLAP_CHARS, 150),
  /** A chunk never splits a source line (D8: that is what keeps locators unique), so a
   * pathologically long line would become one huge chunk. Lines longer than this are wrapped
   * by the parser first — see `parseText.ts` for why `line` still means something after. */
  docLineWrapChars: num(process.env.DOC_LINE_WRAP_CHARS, 400),
  docEmbedBatchSize: num(process.env.DOC_EMBED_BATCH_SIZE, 64),

  docVectorTopK: num(process.env.DOC_VECTOR_TOP_K, 20),
  docTextTopK: num(process.env.DOC_TEXT_TOP_K, 20),
  docRrfK: num(process.env.DOC_RRF_K, 60),
  /** >= 5, or recall@5 is structurally unreachable: bench.mjs:399 slices the emitted doc
   * sources to 5 and that slice IS the recall measurement. */
  docFinalTopK: num(process.env.DOC_FINAL_TOP_K, 8),
  /** Ceiling on how many sources one answer may emit. Several searches in one request each
   * contribute their fused top-k, and an unbounded list would grow the final prompt (and the
   * citation range the model has to keep straight) without limit. Must stay above
   * `docFinalTopK` so a single search's results are never truncated. */
  docMaxSources: num(process.env.DOC_MAX_SOURCES, 12),

  jobStaleAfterSeconds: num(process.env.JOB_STALE_AFTER_SECONDS, 300),
  jobPollIntervalMs: num(process.env.JOB_POLL_INTERVAL_MS, 1500),
  /** A corrupt PDF fails deterministically; without a ceiling the sweeper retries it until
   * the cluster is the only thing that notices (D5). */
  jobMaxAttempts: num(process.env.JOB_MAX_ATTEMPTS, 3),
  /** Atlas Search is eventually consistent, so the read-your-write probe (D12) retries
   * rather than failing the first time it does not see its own write. */
  docProbeMaxAttempts: num(process.env.DOC_PROBE_MAX_ATTEMPTS, 12),
  docProbeBackoffMs: num(process.env.DOC_PROBE_BACKOFF_MS, 1500),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;
