import type { Response } from 'express';
import type { Logger } from 'pino';
import {
  AskMode,
  DoneEvent,
  Source,
  SourcesEvent,
  SseEventName,
  StreamErrorEvent,
  TokenEvent,
  TraceEvent,
  newId,
  unresolvedCitations
} from '@lumina/contract';
import { env } from './env.js';
import { toolsFor } from './tools/registry.js';
import { runDocsPreflight, runGatherLoop, runMemoryPreflight, runSaveBackstop } from './loop.js';
import { allSearchesCached, createRunState, recordUsage } from './run.js';
import { streamFinalTurn, type FinalSource } from './llm.js';
import { appendMessage } from './threads.js';
import { persistRun } from './runlog.js';
import { isExplicitSaveRequest } from './saveIntent.js';

function send(res: Response, event: SseEventName, data: unknown): void {
  // A disconnected client (or a stream we've already ended) makes writableEnded true;
  // writing past that point either no-ops with a warning or, in the worst case, raises
  // an 'error' event on the response with no listener, which crashes the whole process.
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * The Phase 2 quick pipeline: a real agent loop decides what to search/fetch (Components
 * 1–3), then a pinned text-only final turn produces the cited answer on the SAME
 * conversation (Component 4). `sources` is always sent before the first `token` (PRD 7).
 * On any unrecovered failure, this emits an `error` SSE event and ends the stream — never a
 * `done` dressed up as success (fail loud).
 */
export interface QuickAskArgs {
  threadId: string;
  userId: string;
  query: string;
  priorTurns: { role: 'user' | 'assistant'; content: string }[];
  requestId: string;
  /** Phase 5: `web` keeps the Phase 1-4 behaviour; `docs` retrieves only from the Space.
   * `auto` is still served as web — routing is Phase 6 (GAP-007). */
  mode: AskMode;
  /** Already verified to exist AND belong to this user by the route (D1). */
  spaceId?: string;
  res: Response;
  log: Logger;
}

export async function handleQuickAsk(args: QuickAskArgs): Promise<void> {
  const { threadId, userId, query, priorTurns, requestId, mode, spaceId, res, log } = args;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disables proxy buffering in front of the service
  res.flushHeaders();
  res.socket?.setNoDelay(true); // avoid Nagle-induced delay on small SSE frames

  // A client that navigates away mid-answer shouldn't leave us paying for tokens nobody
  // reads. 'close' fires on a premature disconnect too; writableEnded distinguishes that
  // from our own normal res.end() below, which also triggers 'close'.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const state = createRunState({ requestId, threadId, userId, query, depth: 'quick', mode, spaceId });
  let ttftMs: number | undefined;

  try {
    let step = 0;
    const onTrace = (ev: TraceEvent) => {
      step = Math.max(step, ev.step);
      send(res, 'trace', ev);
    };

    // ---- Phase 4 D1: deterministic recall pre-flight, before the first model call. Not
    // model-elected — runs every time, costs nothing when the user has no memories yet. ----
    const preflight = await runMemoryPreflight(state, onTrace, controller.signal);

    // ---- Phase 5 D17a: on a docs ask, retrieve from the Space deterministically before the
    // first model call, for the same reason the memory pre-flight exists (GAP-011): the
    // retrieval-rate gate and recall@5 both require retrieval to have actually happened, and
    // `tool_choice: 'auto'` compels nothing. The tool stays registered so the model can
    // re-query with better wording. A failure here throws — fail loud, not an empty answer. ----
    // `step` is maintained by `onTrace` above, which takes the max of every step it sees — so
    // it is already current once the pre-flight has emitted. Adding `stepsUsed` on top would
    // skip a number and leave a hole in the trace a reader has to wonder about.
    if (state.mode === 'docs') {
      await runDocsPreflight(state, onTrace, step, controller.signal);
    }

    // ---- the agent loop: model decides what to search/fetch, within budget (Components
    // 1–3). Every tool call becomes a `trace` event as it happens. recall_memory stays
    // registered (Phase 4) so the model may call it again; the preflight's result is
    // injected as its own labelled block (D7) ahead of the query itself. ----
    const history = await runGatherLoop(state, onTrace, controller.signal, priorTurns, preflight.contextBlock, step);

    // ---- Phase 4 D8a: explicit-save backstop. Only fires when the gather loop produced no
    // successful model-elected save_memory call for a query that unambiguously asked to be
    // remembered — never a double-write on top of an already-successful save. ----
    const alreadySaved = state.toolCalls.some((t) => t.name === 'save_memory' && t.ok);
    if (!alreadySaved && isExplicitSaveRequest(query)) {
      await runSaveBackstop(state, onTrace, step, controller.signal);
    }

    // ---- sources, numbered from 1, built only from what was actually retrieved in THIS
    // request — fetched pages for web, retrieved chunks for documents. Never from search
    // snippets alone (grounded or nothing).
    //
    // Phase 5 D16, two rules that look like details and are not:
    //   - EVERY retrieved chunk is emitted, in retrieval rank order, cited or not. The
    //     `sources` event IS the retrieval surface the bench measures recall@5 from
    //     (bench.mjs:398-399); emitting only what the model happened to cite would turn a
    //     retrieval metric into a measure of the model's citation appetite.
    //   - a doc snippet is the chunk's FULL text, never truncated like the web path's 400
    //     chars. The gold set's anchor-matched items only score if the anchor falls inside
    //     the emitted snippet (bench.mjs:410), and an anchor can sit anywhere in the chunk.
    // Bounded by `docMaxSources` so a run with several searches cannot grow the final prompt
    // without limit; the cap applies to the tail, keeping the best-ranked ones.
    const evidence = state.evidence.slice(0, env.docMaxSources);
    const sources: Source[] = evidence.map((e, i) =>
      e.kind === 'doc'
        ? { n: i + 1, kind: 'doc' as const, title: e.title, snippet: e.text, docId: e.docId, locator: e.locator }
        : { n: i + 1, kind: 'web' as const, title: e.title, snippet: e.text.slice(0, 400), url: e.url }
    );

    send(res, 'sources', sources satisfies SourcesEvent);

    // ---- the pinned final turn: continues the SAME history the loop built, but cannot
    // call a tool, so nothing can retrieve after the first streamed token. A capped run
    // still answers here — honestly, from whatever evidence exists (A2). ----
    // The same evidence the `sources` event just announced, in the same order and numbering —
    // so the model is choosing from exactly the list the client can render chips for.
    const finalSources: FinalSource[] = evidence.map((e, i) =>
      e.kind === 'doc'
        ? { n: i + 1, title: e.title, text: e.text, docId: e.docId, locator: e.locator }
        : { n: i + 1, title: e.title, text: e.text, url: e.url }
    );
    const tools = toolsFor({ depth: state.depth, mode: state.mode, hasSpace: Boolean(state.spaceId) }).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    let answerText = '';
    const startedAt = state.startedAt;
    const finalUsage = await streamFinalTurn(
      history,
      tools,
      finalSources,
      state.terminated === 'cap',
      (delta) => {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
        answerText += delta;
        send(res, 'token', { text: delta } satisfies TokenEvent);
      },
      controller.signal,
      state.memoryWrites
    );
    recordUsage(state, finalUsage);

    // ---- grounding guard: every [n] in the answer must resolve to an emitted source.
    // The model was told to cite only from the given sources, but the guard is what
    // actually enforces it — a prompt is a suggestion, a check is a gate. ----
    const dangling = unresolvedCitations(answerText, sources);
    if (dangling.length > 0) {
      throw new Error(`ungrounded citation(s) [${dangling.join(', ')}] do not match any emitted source`);
    }

    const answerId = newId('ans');
    const done: DoneEvent = {
      answerId,
      latencyMs: Date.now() - startedAt,
      ttftMs: ttftMs ?? Date.now() - startedAt,
      model: env.llmModel,
      tokens: { in: state.tokensIn, out: state.tokensOut },
      costUsd: state.costUsd,
      // Component 4: honest now — true only when this request made at least one search
      // and every one of them hit (GAP-005 closed). Zero searches still reports false:
      // `true` with no retrieval would read as a cached answer that never happened.
      searchCached: allSearchesCached(state),
      terminated: state.terminated,
      depth: state.depth,
      subQuestions: 0
    };
    send(res, 'done', done);
    res.end();

    // Everything below runs AFTER `done`/`res.end()` and on purpose not inside the try/catch
    // above: the client already has a complete, successful answer. A write failing here is
    // a real problem to log loudly, but re-surfacing it as an `error` event after `done` has
    // already gone out would contradict a stream the client was just told succeeded
    // (BUG-006's trade-off). Each of the four writes below (one message append, three
    // inside `persistRun`) is independently caught — see `persistRun`'s own comment.
    try {
      await appendMessage(threadId, userId, { role: 'assistant', content: answerText, sources, answerId, done });
    } catch (err) {
      log.error({ err, threadId, answerId }, 'answer streamed successfully but failed to persist');
    }

    await persistRun(state, { requestId, userId, threadId, answerId, ttftMs: done.ttftMs }, log);
  } catch (err) {
    // Headers are already sent at this point, so a failure cannot become a different
    // HTTP status — it has to surface as an `error` SSE event instead (fail loud, PRD 7).
    log.error({ err, threadId, requestId }, 'quick ask failed');
    send(res, 'error', { status: 502, error: (err as Error).message } satisfies StreamErrorEvent);
    if (!res.writableEnded) res.end();
  }
}
