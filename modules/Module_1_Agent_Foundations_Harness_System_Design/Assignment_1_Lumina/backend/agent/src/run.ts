import type { AskMode, Depth, Locator, Terminated, ToolName } from '@lumina/contract';
import { env } from './env.js';
import { EMBEDDING_USD_PER_MTOK } from './embed.js';

/** Phase 4 D9a: one entry per attempted memory write, normal or backstop. The final
 * synthesis turn reads this to state plainly whether a save actually happened. */
export interface MemoryWriteRecord {
  text: string;
  ok: boolean;
  error?: string;
}

/** One completed (or failed) tool call, in the shape `RunLog.toolCalls` expects. */
export interface ToolCallRecord {
  name: ToolName;
  ok: boolean;
  error?: string;
  ms: number;
}

/**
 * One piece of retrieved evidence, grounding candidate material for the final answer.
 *
 * A discriminated union rather than optional fields, so the two kinds cannot be confused:
 * `Source` in the contract requires a `url` for `kind:"web"` and a `docId` for `kind:"doc"`
 * (sse.ts:124-131), and a half-filled object would only fail at the zod parse on the way out.
 */
export type Evidence = WebEvidence | DocEvidence;

export interface WebEvidence {
  kind: 'web';
  title: string;
  url: string;
  text: string;
}

export interface DocEvidence {
  kind: 'doc';
  title: string;
  docId: string;
  locator: Locator;
  /** The chunk's full text. Phase 5 D16: this becomes the citation `snippet` verbatim, never
   * truncated — the gold set's anchor-matched items are only scored as retrieved if the
   * anchor appears inside the emitted snippet (bench.mjs:410). */
  text: string;
  /** Dedupe key when several searches in one request return the same chunk. */
  chunkId: string;
}

/**
 * Explicit state threaded through one request's run, instead of loose variables scattered
 * across the loop. Everything the final `done` event and the Phase-2+ run log need comes
 * out of this object.
 */
export interface RunState {
  requestId: string;
  threadId: string;
  userId: string;
  query: string;
  depth: Depth;
  /** Phase 5: which retrieval mode this request asked for, and the Space it is scoped to.
   * Both decide the toolset before the first model call (`toolsFor`). */
  mode: AskMode;
  spaceId?: string;
  startedAt: number;
  toolCalls: ToolCallRecord[];
  evidence: Evidence[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  terminated: Terminated;
  /** Component 4: every `web_search` call in this request, hit or miss. `done.searchCached`
   * (and the `requests` row's `searchCached`) is true only when this request made at least
   * one search AND every one of them hit — see `allSearchesCached`. */
  searchesTotal: number;
  searchesCacheHits: number;
  /** `web_search` result titles keyed by url, so a later `fetch_page` on the same url can
   * label its evidence with something better than the bare URL. */
  titlesByUrl: Map<string, string>;
  /** Phase 4: embedding tokens stay separate from the LLM's `done.tokens` (D5), but still
   * enter `costUsd` via `recordEmbeddingUsage`. */
  embeddingTokens: number;
  /** Phase 4 D9a: every attempted save this request made, normal or backstop. */
  memoryWrites: MemoryWriteRecord[];
  /**
   * Which ceiling tripped, when `terminated === 'cap'`. The contract's `Terminated` enum
   * only has one `cap` bucket, so this is where the distinction a debugger actually needs
   * (tool calls vs. wall clock vs. tokens) survives — in the trace and run metadata, not
   * on the wire.
   */
  capReason?: CapReason;
}

export type CapReason = 'tool_calls' | 'wall_clock' | 'tokens';

export function createRunState(args: {
  requestId: string;
  threadId: string;
  userId: string;
  query: string;
  depth: Depth;
  mode: AskMode;
  spaceId?: string;
}): RunState {
  return {
    ...args,
    startedAt: Date.now(),
    toolCalls: [],
    evidence: [],
    titlesByUrl: new Map(),
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    terminated: 'done',
    searchesTotal: 0,
    searchesCacheHits: 0,
    embeddingTokens: 0,
    memoryWrites: []
  };
}

/** Embedding cost enters `RunState.costUsd` (D5); embedding tokens stay their own counter,
 * never folded into `tokensIn`/`tokensOut` (the LLM's `done.tokens`). */
export function recordEmbeddingUsage(state: RunState, tokens: number): void {
  state.embeddingTokens += tokens;
  state.costUsd += (tokens / 1_000_000) * EMBEDDING_USD_PER_MTOK;
}

export function recordSearch(state: RunState, hit: boolean): void {
  state.searchesTotal += 1;
  if (hit) state.searchesCacheHits += 1;
}

/** Zero searches is "not cached" — not "every search hit" (D5: `searchCached: true` with
 * no retrieval would read as a cached answer that never happened). */
export function allSearchesCached(state: RunState): boolean {
  return state.searchesTotal > 0 && state.searchesCacheHits === state.searchesTotal;
}

export function elapsedSec(state: RunState): number {
  return (Date.now() - state.startedAt) / 1000;
}

function maxToolCalls(depth: Depth): number {
  return depth === 'deep' ? env.maxToolCallsDeep : env.maxToolCalls;
}

function maxWallClockSec(depth: Depth): number {
  return depth === 'deep' ? env.maxWallClockSecDeep : env.maxWallClockSec;
}

function maxTokensTotal(depth: Depth): number {
  return depth === 'deep' ? env.maxTokensTotalDeep : env.maxTokensTotal;
}

/**
 * The final answer turn needs wall-clock headroom too. Spending the whole budget on
 * gathering and then blowing the cap while the answer streams would turn a legitimate
 * answer into a `cap` termination for no reason — so gathering stops at a fraction of the
 * budget, reserving the rest for the pinned final call.
 */
const GATHER_FRACTION = 0.7;

/**
 * Checked before each model call and before each tool execution. Pure — no network calls,
 * no side effects — so it can be unit-tested by constructing a `RunState` directly and
 * asserting each ceiling trips independently.
 */
export function checkGatherBudget(state: RunState): { tripped: boolean; reason?: CapReason } {
  if (state.toolCalls.length >= maxToolCalls(state.depth)) {
    return { tripped: true, reason: 'tool_calls' };
  }
  if (elapsedSec(state) >= maxWallClockSec(state.depth) * GATHER_FRACTION) {
    return { tripped: true, reason: 'wall_clock' };
  }
  if (state.tokensIn + state.tokensOut >= maxTokensTotal(state.depth)) {
    return { tripped: true, reason: 'tokens' };
  }
  return { tripped: false };
}

/** The hard ceiling the final answer turn itself must still respect. */
export function checkHardWallClock(state: RunState): { tripped: boolean; reason?: CapReason } {
  if (elapsedSec(state) >= maxWallClockSec(state.depth)) {
    return { tripped: true, reason: 'wall_clock' };
  }
  return { tripped: false };
}

export function recordToolCall(state: RunState, call: ToolCallRecord): void {
  state.toolCalls.push(call);
}

export function recordUsage(state: RunState, usage: { tokensIn: number; tokensOut: number; costUsd: number }): void {
  state.tokensIn += usage.tokensIn;
  state.tokensOut += usage.tokensOut;
  state.costUsd += usage.costUsd;
}
