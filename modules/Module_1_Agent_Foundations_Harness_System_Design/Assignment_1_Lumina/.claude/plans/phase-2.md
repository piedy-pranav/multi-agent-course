# Phase 2 plan — Agent Loop + Budgets

Read `.claude/CLAUDE.md` first for project context (the four grading rules, the
non-negotiables, the reference map), and `.claude/BUG-AUDIT.md` for what has already been
fixed and which temporary deviations are still outstanding. This file is the
component-by-component build sequence for Phase 2 only.

```text
LLM → choose tool → execute → observe → repeat → answer
```

**Goal:** the agent dynamically decides what information it needs, instead of following the
hard-coded `search → fetch 4 pages → synthesize` pipeline Phase 1 built.

**Phase 1 recap (what you are replacing):** `backend/agent/src/ask.ts` runs a fixed sequence
and streams `trace* → sources → token* → done`. That event contract does not change in
Phase 2 — only *who decides* the sequence does.

---

## Scope

**In:** explicit agent state, real tool calling, model-driven search/fetch decisions,
tool-call/time/token budgets, honest termination reasons, trace per step, aggregated run
metadata.

**Out (later phases, do not build):** search cache and run-log *files* (Phase 3), gateway
(Phase 3), memory tools (Phase 4), `search_documents` (Phase 5), `mode: auto` routing
(Phase 6), `plan_research` and deep search (Phase 7), hitting the latency SLA (Phase 8).

Tools available this phase are still only `web_search` and `fetch_page`. Build the registry so
the others slot in without reshaping the loop.

---

## The one architectural decision to make first

The contract requires the **`sources` event before the first `token` event**. That is a rule
about what the *client* sees, not about how the model behaves internally: a `token` event is
answer text, and you choose what becomes one. A model's mid-loop commentary ("let me search for
that…") is not answer text and simply never gets forwarded.

So a tool loop does **not** conflict with the contract. What remains is one narrow
implementation question: **while streaming, how do you know the turn you are streaming is the
final answer, rather than a turn that is about to call another tool?** A single turn can
legitimately emit text and *then* a `tool_use` block, so forwarding deltas optimistically can
put a token on the wire before retrieval has finished.

**Recommended: one conversation, with a forced text-only final turn.**

```text
loop:  model (tools available) → tool_use? → execute → observe → repeat
       ↑ text from these turns is never forwarded as `token`
exit:  model stops asking for tools, or a budget trips
       → emit `sources`
       → final call on the SAME history, pinned to text-only
       → stream its deltas as `token`
       → `done`
```

Why this shape:
- Keeps "one loop … → answer" (SPEC 5.1), which is the harness the assignment is actually
  teaching. The answer comes out of the same conversation that gathered, so the model sees its
  own tool results and reasoning without being re-prompted from scratch.
- The ordering invariant holds **structurally**, not by hoping the model behaves: the final call
  cannot call a tool, so nothing can retrieve after the first token.
- Real incremental streaming survives, because the final call is the one being streamed.
- A cap hit just exits the loop early into that same final call — which is exactly how you get
  an honest partial answer from whatever evidence exists.

Two gotchas to know before writing it:
- Pin the final turn with `tool_choice: {type: "none"}` rather than dropping the `tools`
  parameter: a history containing `tool_use`/`tool_result` blocks generally still requires
  `tools` to be present. If your API version rejects that, fall back to buffering the final
  turn's text and emitting it after `sources` — correct, just less smooth.
- Keep `max_tokens` modest on gather turns and instruct them to call tools rather than answer.
  If a gather turn returns prose anyway you discard it, and you would rather not have paid for
  a full answer to throw away.

**Rejected alternative: a two-stage pipeline** (gather loop, then synthesis from a fresh prompt).
It satisfies the invariant too, but it sends the evidence to the provider twice, lifts the
answer out of the loop the course is teaching, and costs more against a
`max_cost_per_answer_usd` gate that Phase 1 answers already run close to ($0.039 of $0.05).
Recorded so the decision is not silently revisited.

---

## Component 1 — Tool registry

- New: `backend/agent/src/tools/registry.ts`.
- One entry per tool: `{ name, description, inputSchema, execute }`, wrapping the existing
  `webSearch` and `fetchPage` functions unchanged. `inputSchema` is JSON Schema, as the
  provider's tool-use API expects. `name` must come from the contract's `AskTool` enum
  (`packages/contract/src/sse.ts`) — never a free string.
- Export `toolsForDepth(depth)`. **Build this now even though `plan_research` does not exist
  yet.** `DEEP_ONLY_TOOLS` is already exported by the contract; filtering by depth before the
  first model call is the structural guarantee behind red line R2 (a quick run must never
  reach `plan_research`). A prompt asking the model not to is a suggestion, not a gate.
- **Done when:** `toolsForDepth('quick')` returns exactly `web_search` and `fetch_page`, a
  unit-style script can execute a tool by name through the registry, and nothing in
  `webSearch.ts`/`fetchPage.ts` had to change.

## Component 2 — Run state and budgets

- New: `backend/agent/src/run.ts` — an explicit state object threaded through the run, rather
  than loose variables:
  `{ requestId, threadId, userId, query, depth, startedAt, toolCalls[], evidence[], tokensIn, tokensOut, costUsd, terminated, capReason }`.
- Budget helpers reading `env` (already present): `maxToolCalls` 8 / `maxWallClockSec` 90 for
  quick, `maxToolCallsDeep` 24 / `maxWallClockSecDeep` 240 for deep. Add a token ceiling as a
  constant or new env var — the phase brief calls for iteration/token/time budgets.
- **Reserve headroom for the final answer turn.** Wall-clock must cover it too, so stop
  *gathering* at a fraction of the budget (~70%) instead of spending all 90s on tools and then
  blowing the cap while the answer streams.
- Record *which* budget tripped in `capReason`. The contract's `Terminated` enum is only
  `done | cap | error`, so `cap` has to cover all three ceilings — the distinction still
  belongs in the trace and run metadata, or nobody can debug which limit bites.
- **Done when:** budget checks are pure functions with a tiny script proving each ceiling
  trips independently, with no network calls involved.

## Component 3 — The loop

- New: `backend/agent/src/loop.ts`. One message history, appended to across turns.
- Add a tool-use-capable call to `llm.ts` (non-streaming is fine for gather turns): send
  `tools`, read `stop_reason`.
  - `stop_reason === 'tool_use'` → execute every `tool_use` block in the turn, emit one
    `trace` per call, append the assistant turn plus `tool_result` blocks to the history, loop.
  - otherwise → the model is ready to answer; exit the loop with `terminated: 'done'`. Any text
    in that turn is **discarded, not forwarded** — the answer comes from the pinned final call
    in Component 4, so that the ordering invariant is structural.
- **Execute multiple `tool_use` blocks from one turn concurrently.** This is also the partial
  remedy for GAP-001 (Phase 1's sequential fetches drove TTFT to ~12s).
- Check budgets **before** each model call and before each tool execution; on a trip, set
  `terminated: 'cap'` and break out to the final answer turn.
- A failing tool is **not** a failing run: emit `trace` with `ok: false` and a non-empty
  `error` (the contract's `superRefine` enforces non-empty), feed the error back as the
  `tool_result` so the model can adapt, and continue. Only a provider exception ends the run
  as `error`.
- Accumulate tokens and cost for **every** call. Phase 1 counted a single synthesis call; a
  multi-turn loop that reports only the last turn's usage under-reports `costUsd`, and the
  bench's cost gate would be measuring a fiction.
- **Done when:** `curl -N` on a simple factual question shows the model choosing a small
  number of tool calls, and a broader multi-part question visibly choosing *more* — different
  shapes for different questions is the actual proof the loop decides rather than follows a
  script.

## Component 4 — Final answer turn and SSE rewiring

- Rewrite `handleQuickAsk` in `ask.ts` as: run the loop → build `sources` from the evidence
  gathered **in this request** → emit `sources` → make the pinned text-only final call on the
  same history and stream its deltas as `token` → grounding guard → `done`.
- The final call is the ordering guarantee: `tool_choice: {type: "none"}` with `tools` still
  present. Nothing can retrieve after the first token because nothing *can* call a tool.
- Keep every Phase 1 behaviour that is already verified and correct: SSE headers and flush,
  `send()`'s `writableEnded` guard (BUG-004), `AbortController` on disconnect (BUG-005),
  post-`done` persistence in its own try/catch (BUG-006), and `unresolvedCitations` as the
  grounding gate.
- `done` now reports the real `terminated` from run state, aggregated `tokens`/`costUsd`, and
  `depth`.
- On `terminated: 'cap'`, answer from partial evidence and say so in the answer text — a capped
  run reported as `done` is red line A2.
- `streamAnswer` is reusable for the final call, but it currently builds its own prompt from a
  bare source list. It needs a variant that streams a continuation of an existing message
  history instead. Delete `synthesizeAnswer` (GAP-003) once this works — do not keep two prompt
  paths that can drift.
- **Done when:** the Phase 1 acceptance checks all still pass — `trace* → sources → token* →
  done`, `sources` strictly before the first token, every `[n]` resolving, `401`/`404`/`400`
  intact, broken search key still producing `trace ok:false` + `error` and no fabricated
  answer.

## Component 5 — Run metadata

- Assemble the run record in the contract's `RunLog` shape (`packages/contract/src/db.ts`):
  `{ tokens, wallClockSec, costUsd, terminated, depth, toolCalls[{name, ok, error, ms}] }`.
- Note the trap: `RunLog.tokens` is a **single total**, not the `{in, out}` split the `done`
  event carries. Same run, two shapes, on purpose.
- Phase 2 builds it in memory and logs it; **writing `runs/<requestId>.json` is Phase 3**
  (GAP-004) along with the rest of observability. Shape it now so Phase 3 only serializes.
- **Done when:** the record validates against `RunLog.parse()` in a scratch script, including
  a deliberately failed tool call (which must carry a non-empty `error`).

---

## Verification for the phase as a whole

```bash
# 1. the loop decides: different questions, different tool-call shapes
T=$(curl -s -X POST localhost:8000/threads -H 'x-user-id: dev' | jq -r .threadId)
curl -N -X POST localhost:8000/threads/$T/ask -H 'x-user-id: dev' \
  -H 'content-type: application/json' -d '{"query":"What is Tavily?","mode":"web"}'

# 2. cap enforcement: squeeze the budget and confirm an honest partial
MAX_TOOL_CALLS=2 npm run dev:agent     # then ask a question needing more than 2 calls
#    expect: terminated:"cap" in done, an answer that admits it is partial, never "done"

# 3. fail loud still holds: break the search key, expect trace ok:false + error, no answer
# 4. ordering invariant: sources must still precede the first token
```

Then: test through the UI, commit, move to Phase 3.

---

## Watch items

- **Top up Anthropic credits before starting.** Phase 1 answers cost ~$0.04 each. A multi-turn
  loop re-sends the whole history every turn, so expect roughly $0.10–0.15 per test run — and
  this phase needs many runs. The ~$2 remaining will not comfortably cover it; $5 more is a
  sensible buffer.
- **Watch the per-answer cost gate, not just your balance.** `max_cost_per_answer_usd` is $0.05
  and Phase 1 already sat at $0.039. In one conversation, fetched page text lands in
  `tool_result` blocks and is **re-sent on every later turn**, so each extra turn after a fetch
  multiplies the most expensive part of the context. Keep `fetchPage`'s character cap tight,
  fetch few pages, and prefer one turn that fetches several pages concurrently over several
  turns that each fetch one.
- **TTFT will get worse before it gets better** (GAP-001). Two stages plus multiple turns adds
  latency, and the 2500ms target is Phase 8's problem. Do not optimize prematurely, but *do*
  keep tool execution concurrent — that is free.
- **`mode` is still `web`-only.** Keep rejecting `docs` with `501`; `auto` routing is Phase 6.
- **TEMP-001 / TEMP-002 remain outstanding** — the `VITE_API_URL` repoint and the agent's CORS
  shim both get undone in Phase 3 when the real gateway lands. Do not commit Phase 2 and 3
  believing the CORS shim is permanent; it is tracked and it is an architectural violation.
