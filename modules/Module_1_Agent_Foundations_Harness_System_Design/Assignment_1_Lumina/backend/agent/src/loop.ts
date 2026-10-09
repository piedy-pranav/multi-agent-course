import type { ToolName, TraceEvent } from '@lumina/contract';
import { toolsFor } from './tools/registry.js';
import { callAgentTurn, type AgentMessage, type ContentBlock, type ToolUseBlock } from './llm.js';
import { searchDocuments, type DocSearchResult } from './retrieval/docSearch.js';
import {
  checkGatherBudget,
  recordEmbeddingUsage,
  recordSearch,
  recordToolCall,
  recordUsage,
  type DocEvidence,
  type Evidence,
  type RunState
} from './run.js';
import { countMemories, recallMemories, saveMemory, buildMemoryContextBlock } from './memories.js';
import { extractMemoryText } from './saveIntent.js';

/** Modest on purpose (plan Component 3): a gather turn is told to call tools, not write
 * prose, so there is no reason to pay for a long completion here. */
const GATHER_MAX_TOKENS = 1024;

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export interface MemoryPreflightResult {
  /** D7's labelled block, or null when there was nothing to recall (or recall failed). */
  contextBlock: string | null;
  /** Always 1 today — one trace step, whatever the outcome. Exists so the caller can keep
   * trace step numbers strictly increasing across preflight → gather loop → backstop. */
  stepsUsed: number;
}

/**
 * Phase 4 D1: a deterministic recall, run once before the first model call — not something
 * the model decides to do. `countMemories` first so a brand-new user costs nothing (no
 * embedding call) and still gets a real, visible `ok:true` trace step (D9: empty is success,
 * not failure). A recall that runs but matches nothing is also `ok:true` — only a provider/
 * Mongo failure reaching the catch blocks below is `ok:false`, and even then the ask
 * continues (D9) with no memory context rather than failing the whole request.
 */
export async function runMemoryPreflight(
  state: RunState,
  onTrace: (event: TraceEvent) => void,
  signal?: AbortSignal
): Promise<MemoryPreflightResult> {
  const startedAt = Date.now();

  let count: number;
  try {
    count = await countMemories(state.userId);
  } catch (err) {
    const error = (err as Error).message;
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'recall_memory', ok: false, error, ms });
    onTrace({ step: 1, tool: 'recall_memory', input: { query: state.query }, ok: false, ms, error });
    return { contextBlock: null, stepsUsed: 1 };
  }

  if (count === 0) {
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'recall_memory', ok: true, ms });
    onTrace({
      step: 1,
      tool: 'recall_memory',
      input: { query: state.query },
      ok: true,
      ms,
      reason: 'no memories stored for this user yet — skipped embedding'
    });
    return { contextBlock: null, stepsUsed: 1 };
  }

  try {
    const recall = await recallMemories(state.userId, state.query, signal);
    recordEmbeddingUsage(state, recall.tokens);
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'recall_memory', ok: true, ms });
    const plural = recall.memories.length === 1 ? 'y' : 'ies';
    onTrace({
      step: 1,
      tool: 'recall_memory',
      input: { query: state.query },
      ok: true,
      ms,
      reason:
        recall.usedFallback === 'recency'
          ? `vector search returned nothing; fell back to ${recall.memories.length} most recent memor${plural}`
          : `recalled ${recall.memories.length} memor${plural}`
    });
    return { contextBlock: buildMemoryContextBlock(recall.memories), stepsUsed: 1 };
  } catch (err) {
    const error = (err as Error).message;
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'recall_memory', ok: false, error, ms });
    onTrace({ step: 1, tool: 'recall_memory', input: { query: state.query }, ok: false, ms, error });
    return { contextBlock: null, stepsUsed: 1 };
  }
}

/**
 * Phase 5 D17a: a deterministic document retrieval, run once before the first model call on a
 * `mode:"docs"` ask — the same shape as the memory pre-flight above, for the same reason.
 *
 * Not model-elected, because three graded things depend on it happening:
 *   - `expectations.json`'s `minRetrievalRate: 1.0` requires EVERY completed answer's trace
 *     to contain `web_search` or `search_documents` (bench.mjs:840-843). In docs mode
 *     `web_search` does not exist, so one model turn that answers directly misses the gate.
 *   - recall@5 is measured from the emitted `sources` of 30 gold asks; a run that retrieves
 *     nothing scores zero for that item however good the answer reads.
 *   - `callAgentTurn` uses `tool_choice: 'auto'`, so nothing compels a call.
 * GAP-011 records Phase 4 reaching the identical conclusion for `recall_memory`.
 *
 * The hits become `state.evidence` immediately, in fusion-rank order, so the FIRST five
 * emitted sources are the top five of a search on the user's own question — which is exactly
 * what recall@5 measures (D16).
 */
export async function runDocsPreflight(
  state: RunState,
  onTrace: (event: TraceEvent) => void,
  startStep: number,
  signal?: AbortSignal
): Promise<void> {
  const step = startStep + 1;
  const startedAt = Date.now();

  if (!state.spaceId) {
    // Unreachable: the ask route rejects `mode:"docs"` without a Space before the stream
    // opens. Guarded anyway rather than silently running an unscoped search.
    throw new Error('docs pre-flight has no spaceId');
  }

  try {
    const result = await searchDocuments({
      userId: state.userId,
      spaceId: state.spaceId,
      query: state.query,
      signal
    });
    recordEmbeddingUsage(state, result.embeddingTokens);
    addDocEvidence(state, result);

    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'search_documents', ok: true, ms });
    onTrace({
      step,
      tool: 'search_documents',
      input: { query: state.query },
      ok: true,
      ms,
      // The reason is the debugging surface (SPEC §10): both halves' counts are here so a
      // silently-empty lexical half (D13) is visible in the trace itself, not just in a log.
      reason:
        result.indexedDocs === 0
          ? 'no indexed documents in this Space yet'
          : `${result.hits.length} passage(s) from ${result.indexedDocs} indexed document(s) ` +
            `(dense ${result.vectorCount}, ${result.lexicalKind} ${result.lexicalCount}, fused by RRF)`
    });
  } catch (err) {
    // Fail loud. A retrieval failure is NOT an empty result: answering "the documents do not
    // cover this" when the truth is "the index threw" is precisely the Live Translate shape
    // rule A1 exists to prevent. The ask aborts and becomes a 502.
    const error = (err as Error).message;
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'search_documents', ok: false, error, ms });
    onTrace({ step, tool: 'search_documents', input: { query: state.query }, ok: false, ms, error });
    throw err;
  }
}

/**
 * D16: every retrieved chunk becomes evidence, in rank order, deduped by chunk id across all
 * searches in the request. Dedupe keeps the FIRST position a chunk appeared at, so a later
 * model-elected search cannot demote a chunk the pre-flight ranked first.
 */
export function addDocEvidence(state: RunState, result: DocSearchResult): void {
  const seen = new Set(
    state.evidence.filter((e): e is DocEvidence => e.kind === 'doc').map((e) => e.chunkId)
  );
  for (const hit of result.hits) {
    if (seen.has(hit.chunkId)) continue;
    seen.add(hit.chunkId);
    state.evidence.push({
      kind: 'doc',
      title: hit.title,
      docId: hit.docId,
      locator: hit.locator,
      text: hit.text,
      chunkId: hit.chunkId
    });
  }
}

/**
 * Phase 4 D8a: a deterministic backstop, called by the ask route after the gather loop when
 * an explicit save request (`saveIntent.ts`) produced no successful model-elected
 * `save_memory` call. Deliberately does not make another model call — `extractMemoryText`
 * strips the "remember that/this ..." wrapper off the query itself, so the backstop cannot
 * fail for the same reason (a provider hiccup, a model that didn't call the tool) the save
 * it's backing up might have failed for. Always records exactly one trace step and one
 * `state.memoryWrites` entry, success or failure.
 */
export async function runSaveBackstop(
  state: RunState,
  onTrace: (event: TraceEvent) => void,
  startStep: number,
  signal?: AbortSignal
): Promise<void> {
  const text = extractMemoryText(state.query);
  const startedAt = Date.now();
  const step = startStep + 1;

  try {
    const result = await saveMemory(state.userId, text, state.threadId, signal);
    recordEmbeddingUsage(state, result.tokens);
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'save_memory', ok: true, ms });
    state.memoryWrites.push({ text, ok: true });
    onTrace({
      step,
      tool: 'save_memory',
      input: { text },
      ok: true,
      ms,
      reason: 'explicit save request had no successful save_memory call in the gather loop — forced backstop save'
    });
  } catch (err) {
    const error = (err as Error).message;
    const ms = Date.now() - startedAt;
    recordToolCall(state, { name: 'save_memory', ok: false, error, ms });
    state.memoryWrites.push({ text, ok: false, error });
    onTrace({ step, tool: 'save_memory', input: { text }, ok: false, ms, error });
  }
}

/**
 * Runs the gather loop: model (tools available) → tool_use? → execute → observe → repeat,
 * until the model stops asking for tools or a budget trips. Text from gather turns is never
 * forwarded as an answer — the answer comes from the pinned final call built on this same
 * history (Component 4). Mutates `state` in place (toolCalls, evidence, usage, terminated).
 *
 * `memoryContext` (D7) is injected as its own text block directly ahead of the query's own
 * text block, in the same opening user message — a separate, explicitly labelled block, not
 * merged into the question itself. `startStep` keeps trace step numbers strictly increasing
 * across the memory pre-flight that ran before this.
 *
 * Returns the message history so the final answer turn can continue the same conversation.
 */
export async function runGatherLoop(
  state: RunState,
  onTrace: (event: TraceEvent) => void,
  signal?: AbortSignal,
  seedHistory: { role: 'user' | 'assistant'; content: string }[] = [],
  memoryContext?: string | null,
  startStep = 0
): Promise<AgentMessage[]> {
  const scope = { depth: state.depth, mode: state.mode, hasSpace: Boolean(state.spaceId) };
  const available = toolsFor(scope);
  const tools = available.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  // D6: prior turns are TEXT only, prepended ahead of this request's own question. They
  // give the model conversation context (so "it" in a follow-up resolves) without ever
  // smuggling in old tool_result/evidence blocks — this request's grounding guard must
  // only ever see sources retrieved in this request.
  const queryBlocks: ContentBlock[] = [];
  if (memoryContext) queryBlocks.push({ type: 'text', text: memoryContext });
  queryBlocks.push({ type: 'text', text: state.query });

  const history: AgentMessage[] = [
    ...seedHistory.map((m) => ({ role: m.role, content: [{ type: 'text' as const, text: m.content }] })),
    { role: 'user' as const, content: queryBlocks }
  ];

  let step = startStep;

  while (true) {
    const beforeCall = checkGatherBudget(state);
    if (beforeCall.tripped) {
      state.terminated = 'cap';
      state.capReason = beforeCall.reason;
      return history;
    }

    const turn = await callAgentTurn(history, tools, {
      toolChoice: 'auto',
      maxTokens: GATHER_MAX_TOKENS,
      signal,
      // D17b: the web gather prompt insists only a fetch_page result is citable, which is
      // wrong (and unachievable) when the toolset has no fetch_page at all.
      gatherMode: state.mode === 'docs' ? 'docs' : 'web'
    });
    recordUsage(state, turn);

    if (turn.stopReason !== 'tool_use') {
      // The model is ready to answer. Any text in this turn is prose written without the
      // ordering guarantee the contract requires (sources before tokens) — discard it; the
      // real answer comes from the pinned final call in Component 4.
      state.terminated = 'done';
      return history;
    }

    history.push({ role: 'assistant', content: turn.content });

    const toolUseBlocks = turn.content.filter(isToolUse);

    const beforeExec = checkGatherBudget(state);
    if (beforeExec.tripped) {
      // The model already asked for these tools; the API requires every tool_use to get a
      // matching tool_result even when we decline to run it, so the history stays valid.
      state.terminated = 'cap';
      state.capReason = beforeExec.reason;
      history.push({
        role: 'user',
        content: toolUseBlocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: `skipped: budget cap reached (${beforeExec.reason})`,
          is_error: true
        }))
      });
      return history;
    }

    // Execute every tool_use block from this turn concurrently — the partial remedy for
    // Phase 1's sequential fetches driving TTFT up, and free latency to keep either way.
    const results = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const startedAt = Date.now();
        // Resolved from the SAME scope the manifest was built from, so a tool the model was
        // never offered cannot be executed even if it asks for one by name.
        const tool = available.find((t) => t.name === block.name);
        try {
          if (!tool) throw new Error(`model requested unknown or unavailable tool "${block.name}"`);
          const output = await tool.execute(block.input, {
            onCacheResult: (hit) => recordSearch(state, hit),
            userId: state.userId,
            threadId: state.threadId,
            spaceId: state.spaceId,
            signal,
            onEmbeddingUsage: (tokens) => recordEmbeddingUsage(state, tokens),
            onMemoryWrite: (write) => state.memoryWrites.push(write),
            onDocHits: (result) => addDocEvidence(state, result)
          });
          const ms = Date.now() - startedAt;
          recordToolCall(state, { name: tool.name, ok: true, ms });
          onTrace({ step: ++step, tool: tool.name, input: block.input, ok: true, ms });

          if (tool.name === 'fetch_page' && typeof block.input.url === 'string') {
            const page = output as { url: string; text: string };
            const evidence: Evidence = {
              kind: 'web',
              title: state.titlesByUrl.get(page.url) ?? page.url,
              url: page.url,
              text: page.text
            };
            state.evidence.push(evidence);
          } else if (tool.name === 'web_search' && Array.isArray(output)) {
            for (const r of output as { title: string; url: string }[]) {
              state.titlesByUrl.set(r.url, r.title);
            }
          }

          return { block, ok: true as const, output };
        } catch (err) {
          const ms = Date.now() - startedAt;
          const error = (err as Error).message;
          const name = block.name as ToolName;
          recordToolCall(state, { name, ok: false, error, ms });
          onTrace({ step: ++step, tool: name, input: block.input, ok: false, ms, error });
          return { block, ok: false as const, error };
        }
      })
    );

    history.push({
      role: 'user',
      content: results.map((r) =>
        r.ok
          ? { type: 'tool_result' as const, tool_use_id: r.block.id, content: JSON.stringify(r.output).slice(0, 8000) }
          : { type: 'tool_result' as const, tool_use_id: r.block.id, content: r.error, is_error: true }
      )
    });
  }
}
