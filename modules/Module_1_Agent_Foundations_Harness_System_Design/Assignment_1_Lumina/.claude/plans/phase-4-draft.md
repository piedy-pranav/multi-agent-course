# Phase 4 plan — Long-Term Memory

Read `.claude/CLAUDE.md` first for project context (the four grading rules, the
non-negotiables, the reference map), and `.claude/BUG-AUDIT.md` for what has already been
fixed and which deviations are outstanding. This file is the component-by-component build
sequence for **Phase 4 only**.

```text
Browser → Gateway (:8787) → Agent service (:8000) → Search / LLM / Embeddings / MongoDB Atlas
                                                                    │
                                                        memories (vector idx, userId filter)
```

**Goal:** the agent deliberately remembers user facts and preferences, recalls them
semantically in *other* threads, and every remembered thing is visible at `GET /memory` and
removable at `DELETE /memory/{id}`. After this phase, a preference saved in thread A
observably changes the answer in thread B, and deleting it makes the effect disappear.

**Worth 10 rubric points** (`eval/rubric.json#memory`), scored automatically by
`benchmark/bench.mjs`'s `runMemory()` phase (`bench.mjs:726–798`). Phase 4's design is
driven by what that function actually asserts — read it before coding.

---

## Phase 3 recap / current starting point

What exists, verified, and must keep working. **Do not rebuild any of it.**

| Area | State | File |
|---|---|---|
| Agent loop | Gather loop, tool-use turns, concurrent tool execution per turn, `trace` per call, failed tool → `ok:false` + non-empty `error` fed back as `tool_result` | `backend/agent/src/loop.ts` |
| Budgets | Explicit `RunState`, pure `checkGatherBudget`, `GATHER_FRACTION = 0.7`, `capReason` | `backend/agent/src/run.ts` |
| Tool registry | `toolsForDepth(depth)` filters `AskTool.options` against `DEEP_ONLY_TOOLS`; `ToolExecContext` side-channel | `backend/agent/src/tools/registry.ts` |
| Final answer | `sources` event then a pinned tool-less final turn, grounding guard via `unresolvedCitations`, `done` with real `terminated`/tokens/cost | `backend/agent/src/ask.ts`, `llm.ts` |
| Threads/messages | `createThread`, `getThread`, `listThreads`, `appendMessage`, `getRecentHistory`, D4 title promotion | `backend/agent/src/threads.ts` |
| Typed collections | `collection<T>(COLLECTIONS.x)` accessors — `threads`, `messages`, `searchCache`, `requests`, `runs` | `backend/agent/src/collections.ts` |
| Mongo | One pooled client, `ignoreUndefined: true` (BUG-001) | `backend/agent/src/db.ts` |
| Run log | `buildRunLog` + `persistRun` (Mongo `runs` row → `runs/<id>.json` → `requests` enrichment), four independent `try/catch`es | `backend/agent/src/runlog.ts` |
| Search cache | Two-tier (in-process LRU + Mongo TTL), honest `searchCached` | `backend/agent/src/cache/searchCache.ts` |
| Gateway | Auth-before-body-parse, D3 request-id validation, `validateBody`, generic `proxyToAgent()`, `proxyAskStream()`, `rateLimit()`, BUG-007 error split | `backend/gateway/src/*` |
| `/stats` | Global/today-UTC aggregation from `requests`/`runs` | `backend/agent/src/stats.ts` |

### What Phase 4 inherits as already-true

- **`GET /memory` and `DELETE /memory/:memoryId` are already `401` without `X-User-Id`.**
  The gateway's auth middleware runs *before* the 501 loop, so `bench.mjs:160`'s probe
  (`GET /memory` with an empty `x-user-id` → want `401`) passes today and must keep
  passing. Do not move auth behind the new routes.
- **The generic `proxyToAgent()` already handles both memory routes with no change.**
  `proxy.ts:25` sets `hasBody = false` for `DELETE`, and `res.status(204).send('')`
  produces a correct bodyless 204 (Express strips body/content-length on 204) **provided
  the agent sends no `content-type` on its 204** — see C5's done-when.
- **The gateway's static catch-all already excludes `/memory`** (`index.ts` regex), so a
  built memory route will not be swallowed by the SPA fallback.
- **`scripts/indexes.json` already declares everything needed**: a `{userId:1, createdAt:-1}`
  index on `memories`, and the `memories_vector` Atlas Vector Search index with
  `embedding` (1536, cosine) **and `userId` declared as a filter field** — that filter field
  exists precisely so the `userId` predicate can live *inside* `$vectorSearch`. Nothing in
  `scripts/` needs editing (it is provided and a red line anyway).
- **`.env.example` already declares `OPENAI_API_KEY` and `EMBEDDING_MODEL=text-embedding-3-small`**,
  and `env.ts` already reads `embeddingModel`; `secrets.openai` already exists and is unused.

### Known deltas Phase 4 inherits

- `GAP-001` — TTFT ~5× over the `ttft_p95_ms: 2500` target. Phase 4 **adds** one
  embedding + one vector query to the front of every ask. This compounds GAP-001; Phase 4
  must measure the delta and record it, not fix it (Phase 8 owns the number).
- `BUG-010`'s residual — a real cited answer already runs ~$0.094 against the
  `max_cost_per_answer_usd: 0.05` gate. Embedding cost is ~$0.0000004/call and will not
  move that needle, but it must still be *counted* (C2, D5).
- `GAP-002` (SerpApi never run), `GAP-007` (`mode: "auto"` served as web), `GAP-008`
  (cache-hit-rate margin) stay deferred. Phase 4 touches none of them.
- `GATHER_SYSTEM_PROMPT` currently instructs the model to fetch at least one page before
  stopping (BUG-010's fix). That instruction actively fights a save-only request — see D2.

---

## Scope

### In scope

1. Embedding client (`text-embedding-3-small`, 1536 dims) — the first non-LLM, non-search
   provider in the service.
2. `memories` collection access + the `MemoryDoc` store (insert, list, delete, vector
   recall), user-scoped at every entry point.
3. The `save_memory` tool — model-elected, explicit, trace-visible.
4. The `recall_memory` tool — semantic, `userId`-filtered inside `$vectorSearch`, plus a
   deterministic pre-flight call so recall provably crosses threads.
5. `GET /memory` (list everything, no embeddings, newest first) and
   `DELETE /memory/{memoryId}` → `204`, both user-scoped.
6. Gateway wiring for both routes (two lines; the forwarder already exists).
7. Prompt changes so a "remember this" request does not get dragged through a pointless
   web search, and so a *failed* save is reported honestly rather than narrated as success.
8. `mongo-cosine-scan` fallback for memory recall, so local dev without Atlas Search works
   and `/health` stays truthful.
9. Honest embedding cost accounting into `RunState.costUsd`.

### Explicitly out of scope — do not pull these in

| Not now | Belongs to | Why it is tempting |
|---|---|---|
| `search_documents`, `chunks`, GridFS, upload routes, the jobs worker, `pdfjs-dist` | **Phase 5** | `search_documents` sits next to `recall_memory` in `AskTool`, and both are vector search. `toolsForDepth` will still return only the tools present in `REGISTRY` — leave `search_documents` out of the registry and `/spaces/*` on `501`. |
| `mode: web \| docs \| auto` routing, `spaceId` scoping | **Phase 6** | `GAP-007` stays open. The agent's ask route keeps rejecting `mode: "docs"` with `501`. `AskBody.mode` is still forwarded unchanged and still not acted on. |
| `plan_research`, the `plan` event, sub-question tagging, `DEEP_DAILY_CAP` enforcement, deep caps | **Phase 7** | `depth: "deep"` keeps returning `501` from the agent. `DEEP_ONLY_TOOLS` filtering already works and needs no change. |
| TTFT/cost tuning, concurrency, cache-hit steering, deployment | **Phase 8** | Phase 4 makes TTFT worse. Measure, record in BUG-AUDIT, move on. |
| Memory *summarisation*, automatic fact extraction from answers, decay/expiry, editing a memory | Not in the spec at all | SPEC 5.3 says writes are **explicit** via `save_memory`. Automatic extraction would directly violate "nothing is remembered that `/memory` does not show" the moment extraction outran the panel. |
| Hybrid (BM25 + RRF) retrieval, re-ranking | **Phase 5** (and it is about `chunks`, not `memories`) | SPEC 5.4 scopes hybrid+RRF to `chunks`; `memories` needs only the vector index. |
| The "why did you remember that?" link | `Could` in SPEC 5.3 | Store `sourceThread` (C2) so Phase 8 *could* add it cheaply; build no UI (and `web/` is a red line). |

---

## Contract: what Phase 4 must satisfy, exactly

From `packages/contract/` — the authority, over this plan and over SPEC.md prose.

```ts
// ids.ts
MemoryId = z.string().min(1)        // NOT prefixed — but newId() accepts 'mem'
// http.ts
Memory = { id: MemoryId, text: string.min(1), sourceThread?: ThreadId, createdAt: datetime }
ListMemoryResponse = { memories: Memory[] }
// db.ts
MemoryDoc = { _id: string, userId: UserId, text: string.min(1),
              embedding: number[].length(1536), sourceThread?: ThreadId, createdAt: iso }
EMBEDDING_DIMS = 1536
COLLECTIONS.memories = 'memories'
SEARCH_INDEXES.memoriesVector = 'memories_vector'
// sse.ts
AskTool ⊇ 'recall_memory' | 'save_memory'     // both quick-legal; neither is in DEEP_ONLY_TOOLS
```

| Requirement | Source | Component |
|---|---|---|
| `GET /memory` → `200 {memories:[{id,text,sourceThread?,createdAt}]}` | `ListMemoryResponse`, SPEC §7 | C4 |
| `DELETE /memory/{id}` → `204` | SPEC §7 line 233 | C5 |
| `401` on both without `X-User-Id` | `ROUTES[].auth`, `bench.mjs:160` | already true (C6 must not break it) |
| `404` unknown id — **does NOT apply to memory**: SPEC §7's status line enumerates thread/space/document and omits it | SPEC §7 status codes | C5, D4 |
| Long-term memory per `X-User-Id` in `memories`, `{_id,userId,text,embedding,sourceThread,createdAt}` | SPEC 5.3 Must | C2 |
| Writes explicit via `save_memory`; the trace shows the write; `GET /memory` lists every row | SPEC 5.3 Must, AGENTS.md "Memory" | C3, C4, D8 |
| Recall demonstrable across threads; trace shows `recall_memory` returning it | SPEC 5.3 Must, rubric `memory` | C3, D1 |
| Recall semantic: Atlas Vector Search on `memories.embedding`, filtered by `userId`; cap ~10 docs / ~1000 tokens | SPEC 5.3 Should | C3, D6, D7 |
| Nothing remembered that `/memory` does not show | AGENTS.md:80, TECHNICAL.md:267, PRD §12.5 | C3/C4, D8 |
| A failed tool call carries `ok:false` + non-empty `error` | rule A1, `TraceEvent.superRefine`, `RunLog.superRefine` | C3, D9 |
| `/health` names the vector backend | SPEC §7, §8 | D10 |

### What `bench.mjs` actually asserts (the graded path, verbatim behaviour)

```text
user = `bench-mem-<base36 now>`          ← a FRESH user every run; no pre-existing memories
1. GET  /memory                           → `before`
2. POST /threads  {}                      → thread A
3. ask(A, {query: "Remember this preference for all future answers: Always answer in
           British English and keep answers under 100 words.", mode: "web"})
     → memorySaved := GET /memory has ≥1 row not in `before`
       (a save_memory trace step is reported in the note but is NOT required for the pass)
       `if (a.error) M.errors++`          ← an error event here hurts the 1% error-rate gate
4. POST /threads  {}                      → thread B
5. ask(B, {query: "What is the capital of Portugal?", mode: "web"})
     → memoryRecalled := trace has ≥1 `recall_memory` step AND ≥1 of them has ok === true
6. DELETE /memory/<added[0].id>
7. GET  /memory                           → memoryDeleted := that id is gone
```

Four consequences that shape the whole phase:

1. **`memoryRecalled` is decided by the trace of an unrelated factual question.** A model
   left to decide whether to recall before answering "What is the capital of Portugal?"
   will frequently not bother. See **D1**.
2. **It only requires `ok: true`, not a non-empty result.** A recall that legitimately
   matches nothing still passes — so there is no incentive to fake a hit, and a zero-match
   recall must be `ok: true` with an empty list, never `ok: false`.
3. **The save ask must not emit an `error` event**, and it is a request with nothing to
   search. See **D2**.
4. **`added[0]` is the newest row** only if `GET /memory` sorts newest-first. See **C4**.

---

## Architectural decisions to settle BEFORE coding

### D1 — Who calls `recall_memory`: the model, or a deterministic pre-flight?

**The tension.** `recall_memory` in the toolset makes recall model-elected, which is the
honest agentic shape. But the graded assertion is that a trace for *"What is the capital of
Portugal?"* contains a successful `recall_memory` step. Nothing in that question suggests
to a model that it should check stored user preferences first; relying on it is a coin flip
on 10 points, and worse, on the "recall is demonstrable across threads" Must.

**Recommendation: deterministic pre-flight recall on every ask, *plus* keep
`recall_memory` in the model's toolset.**

- Before the first model call, the ask path performs one real `recall_memory` execution
  (same tool function, same code path the model would hit), emits it as `trace` step 1, and
  records it in `RunState.toolCalls`.
- The recalled texts are injected into the gather history as context (D7).
- `recall_memory` stays in `REGISTRY`, so the model can recall again mid-run with a
  different query (e.g. "what do I know about this user's stack?").

**Why this is honest, not a staged step:** a real embedding call and a real `$vectorSearch`
genuinely execute; the `ms` is real; `ok:false` + a real `error` appears if it fails. The
trace is not claiming the *model* chose it — `TraceEvent` has no "who chose this" field, and
`reason` is `.optional()`. Use `reason` to say so explicitly:
`reason: "pre-flight recall: stored preferences are checked on every ask, before the model sees the question"`.
That makes the trace *more* truthful than a model-elected step with no reason, and it is
exactly the kind of thing `reason` exists for ("it is why this step happened").

**Rejected alternatives:**
- *Prompt the model to always recall first.* A prompt is a suggestion, not a gate — the
  same reasoning `toolsForDepth` is built on (`registry.ts`: "A prompt asking it not to is
  a suggestion, not a gate"). Fails intermittently; intermittent is worse than absent.
- *Inject memories from a system prompt with no trace step.* Breaks the graded assertion
  and breaks SPEC 5.3's "the trace shows `recall_memory` returning it" — a retrieval that
  does not appear in the trace is the opposite of an inspectable system.
- *Synthesise a trace step without running anything.* A fabricated trace step. Not an
  option; it is the Live Translate shape pointed at the observability surface.

**D1a — does the pre-flight count against the tool-call cap?** **Yes.** It is a real tool
call and `RunLog.toolCalls` must list it, so the quick budget of 8 becomes 7
model-available calls. A typical run is pre-flight + 1 search + 2 fetches = 4 calls, so
there is headroom; `expectations.json`'s global `maxToolCalls: 24` is untouched. Not
counting it would make `RunLog` disagree with what ran, which `quality/check.mjs` reads.
Record the narrowed quick headroom in BUG-AUDIT (GAP-012).

**D1b — skip the pre-flight when the user has no memories?** **No — always emit the step,
but skip the embedding when the user has zero rows.** The step first does an indexed
`countDocuments({userId})`; on `0` it returns `[]` with `ok:true`, a real `ms`, and
`reason: "pre-flight recall: no stored memories for this user"`. On `> 0` it embeds and
queries. This keeps the trace uniform (every ask shows its recall decision), costs one
cheap counted query on a cold user, and avoids paying for an embedding of a question when
there is provably nothing to match. It also means `memoryRecalled` cannot fail because a
count raced a save — the bench's thread B always has ≥1 row by then.

**D1c — pre-flight on a `cap`/budget-tripped run?** The pre-flight runs *before*
`checkGatherBudget`'s first evaluation in `runGatherLoop`. Keep it that way, but still
check `checkHardWallClock` first so a request that arrives already over budget does not
start work. In practice step 1 at t≈0 never trips.

### D2 — "Remember this" is a request with nothing to search

`GATHER_SYSTEM_PROMPT` currently says (BUG-010's fix): *"after a search, fetch_page at
least one of the most relevant results before you consider yourself done, unless the
question plainly needs no sourcing at all (e.g. a greeting)."*

The bench's save request is `mode: "web"` and is precisely a request that needs no
sourcing. Three ways this goes wrong today:

1. The model searches and fetches a page about British English, burning ~$0.09 and ~10s on
   a request whose only job was to store a sentence.
2. The final turn, now holding one irrelevant source, writes `[1]` into a reply about a
   saved preference — a citation that resolves but is nonsense, and a grounding-rate risk.
3. The model never calls `save_memory` at all, because the prompt's loudest instruction is
   "fetch before you stop" — and `memorySaved` fails, taking `memoryRecalled` and
   `memoryDeleted` down with it (`bench.mjs:765–768` short-circuits all three).

**Recommendation:** extend `GATHER_SYSTEM_PROMPT` with an explicit carve-out — a request
whose purpose is to *record* a preference or fact is satisfied by `save_memory` alone, needs
no web evidence, and correctly produces zero sources. Keep BUG-010's fetch-before-stop rule
for every request that asks a *question*. Phrase the carve-out as narrow and
intent-based, not keyword-based ("remember" appearing in a question like "do people
remember the 2008 crash?" must not disable sourcing).

Also confirm the 0-source path still works end to end: `ask.ts` already emits an empty
`sources` event before any token, and `buildFinalSourcesMessage` already has a 0-source
branch ("There are 0 sources below… cite nothing"). `streamFinalTurn` throws if the stream
produced **no text at all** — so the final turn must still be given something to say. The
save-only reply ("Saved — I'll answer in British English and keep answers under 100 words
from now on.") satisfies that. **Verify this explicitly in C7**: a thrown
"anthropic stream returned no text content" here becomes an `error` event and a bench
`M.errors++`.

### D3 — Memory id format

`MemoryId` is only `z.string().min(1)` — unlike `ThreadId`/`AnswerId` it is *not* prefixed,
so the contract would accept anything. But `newId()`'s prefix union already includes
`'mem'` (`ids.ts:28`), which is the contract's own hint at the intended shape, and it costs
nothing to be consistent with `thr_`/`ans_`.

**Recommendation:** `newId('mem')` → `mem_<base36 ts><rand>`. Unlike BUG-008's message-id
problem, no local helper is needed — `'mem'` is in the union. The id travels in a URL path
(`DELETE /memory/:memoryId`), so validate it against `^[A-Za-z0-9_-]{1,64}$` before it
reaches a Mongo filter (same defence-in-depth posture as SEC-003), even though a string
filter value cannot be an injection the way a filename could.

### D4 — `DELETE /memory/{id}`: unconditional, idempotent `204`

*Revised after challenge. An earlier draft of this plan recommended `404` on a miss; the
repo evidence below contradicts that, and the privacy argument it rested on was backwards.*

**Recommendation: `deleteOne({_id, userId})`, then `204` unconditionally — never `404`.**

Evidence, in order of weight:

1. **The contract and spec declare one status and only one.** `SPEC.md:233` reads
   `DELETE /memory/{id} → 204`, with no alternative branch. SPEC §7's status-code line
   enumerates `404 unknown thread/space/document` — it names three resources and
   conspicuously **omits memory**, while `ROUTES` in `http.ts` declares the route with no
   status information at all. An enumeration that names three of four resources is evidence
   about the fourth, not silence about it.
2. **The provided UI — a red-line file — is written for exactly `204` and treats anything
   else as an error.** `web/src/api.ts:62`: `if (res.status === 204) return undefined as T;`
   is a hard-coded special case, and every non-2xx throws `ApiError`.
   `MemoryPanel.tsx:26–31`'s `remove()` catches that into `setError`, which renders a
   user-visible error banner. So a `404` on a stale list, a double click, or two open tabs
   shows the user a failure for an operation that achieved precisely what they asked.
3. **A `404` here can retroactively destroy an already-passing graded check.**
   `benchmark/lib.mjs:59` — `if (!res.ok) throw new HttpError(...)` — so `del()` **throws**
   on `404`. `bench.mjs:788`'s `await memClient.del(...)` sits inside `runMemory`'s outer
   `try`, whose `catch` (`bench.mjs:793–797`) calls `cap('memorySaved', false, …)`. And
   `cap` (`bench.mjs:93–96`) is `M.caps[name] = {...}` — a **plain overwrite, last write
   wins**. A single `404` anywhere in that phase therefore rewrites an already-`true`
   `memorySaved` to `false` and takes all three memory checks with it. An unconditional
   `204` cannot throw and carries no such tail risk.
4. **Idempotent `204` reveals strictly *less* than `204`/`404`.** This is where the earlier
   draft had it backwards: because the filter is `{_id, userId}`, a `204`/`404` split is an
   existence-**and**-ownership oracle — it tells any caller whether a given memory id
   exists under some other user. Unconditional `204` tells them nothing.
5. **It is not a "silent no-op dressed as success".** `DELETE`'s postcondition is "this id
   is not present for you afterwards", which is true in both branches. Nothing failed, so
   there is no error to surface and rule A1 is not engaged — A1 is about a *failure* made
   indistinguishable from a result, not about two different routes to the same satisfied
   postcondition.

**Malformed id:** also `204`. A syntactically impossible id matches nothing, so the
postcondition holds. Keep D3's regex as a **log-only** guard (a `warn` naming the rejected
id) rather than a status branch — it exists to document that nothing unvalidated reaches a
filter, not to answer differently.

Record in BUG-AUDIT as **GAP-013** that the implementation is idempotent and never `404`s,
with the `web/src/api.ts:62` and `bench.mjs:93` evidence, so a future phase does not
"correct" it toward REST convention and silently reintroduce risk 3.

### D5 — Embedding provider, dimensions, and cost accounting

- **Model:** `text-embedding-3-small` via OpenAI, from `env.embeddingModel` /
  `secrets.openai`. Native output is 1536 dims, which is exactly `EMBEDDING_DIMS` and
  exactly what `scripts/indexes.json` declares (`numDimensions: 1536`). Do not pass a
  `dimensions` override; do not swap models without changing the index.
- **Fail loud** on a missing key: `throw new Error('OPENAI_API_KEY is not set')`, mirroring
  `llm.ts`'s `ANTHROPIC_API_KEY` guard. Never a zero-vector fallback — a zero vector would
  return *arbitrary* neighbours from a cosine index, i.e. plausible-looking wrong memories.
- **Validate the returned length against `EMBEDDING_DIMS` before insert** (via
  `MemoryDoc.parse`, whose `.length(1536)` is the check). A wrong-dimension model must fail
  at write time with a clear message, not silently produce rows the vector index rejects or
  scores nonsensically.
- **Cost:** `sla.json#cost_model.embedding_usd_per_mtok = 0.02`. Add the embedding cost to
  `RunState.costUsd`.
  **Do not add embedding tokens to `tokensIn`/`tokensOut`.** `DoneEvent.tokens` is the LLM
  `{in,out}` split the model reported; folding a different provider's token meter into it
  would make `done.tokens` and `/stats` unreconcilable with the Anthropic usage a grader
  can check (rubric `observability`: "/stats.answers and /stats.costUsdToday reconcile with
  the agent log within 1%"). Consequence: `RunLog.tokens` (a single total) under-reports by
  the embedding tokens while `costUsd` includes their cost. That is a deliberate, declared
  asymmetry — log it as **GAP-010** rather than leaving a reader to find the discrepancy.
  Add `RunState.embeddingTokens` so the number exists and is loggable even though it does
  not enter `tokens`.

### D6 — Atlas Vector Search is eventually consistent, and the bench recalls ~seconds after saving

The bench saves in thread A and asks in thread B immediately after. An Atlas Search index
is **eventually consistent** — this is the exact lesson DESIGN.md Q4 and SPEC 5.4's
read-your-write probe are built around, and on a fresh cluster the index may also still be
*building* (`listSearchIndexes().queryable === false`).

The bench's `memoryRecalled` only needs `ok: true`, so index lag cannot fail the automated
check. But SPEC 5.3's Must ("a preference saved in thread A **changes the answer** in
thread B") and the manual/video evidence both need the row to actually come back.

**Recommendation: `$vectorSearch` as the primary path, with a declared recency fallback.**

1. Embed the recall query, run `$vectorSearch` on `memories_vector` with `userId` as a
   `filter` **inside the stage** (never a later `$match` — the `chunks_vector` note in
   `indexes.json` spells out why: a post-`$match` returns another tenant's rows first and
   then hides them, quietly destroying recall).
2. If `$vectorSearch` returns **zero** rows while `countDocuments({userId}) > 0`, fall back
   to the most recent ≤10 rows for that user (`{userId:1, createdAt:-1}`, already indexed).
3. Record which path ran in the trace step's `reason`
   (`"vector"` / `"recency fallback: vector index returned nothing for a user with N memories"`).
   A fallback that is invisible in the trace is a hidden behaviour; one that names itself is
   a documented degradation.

This is not "inject all rows" (SPEC 5.3's Should): it is capped at 10 and only fires when
the semantic path returned nothing at all.

**`mongo-cosine-scan`:** when `env.vectorBackend === 'mongo-cosine-scan'`, skip
`$vectorSearch` entirely — pull the user's rows (`{userId}` projected with `embedding`),
score cosine in Node, take the top k. `/health` already reports `env.vectorBackend`, so a
grader reading a recall number knows which ran. This is the same split Phase 5 will need
for `chunks`; write it so the cosine helper is reusable but **do not** generalise it to
chunks now.

**Operational prerequisite, not code:** run `node scripts/create-indexes.mjs` and then
`--status` until `memories/memories_vector` reports `queryable`. A recall number taken
before that is meaningless. This belongs in C3's done-when.

### D7 — How recalled memories reach the model

The pre-flight runs before the model's first turn, so there is no `tool_use` block to
answer with a `tool_result` — fabricating one would mean inventing a `tool_use_id` the model
never emitted (and the Messages API would reject the mismatch anyway).

**Recommendation:** inject the recalled texts as a **text block prepended to the gather
history**, immediately before `state.query`, labelled unambiguously as stored user context:

```text
Known stored preferences and facts about this user (from long-term memory; they were saved
explicitly by the user in earlier conversations, and may not be relevant to this question):
- Always answer in British English and keep answers under 100 words.
```

This slots into `loop.ts`'s existing `seedHistory` mechanism (D6 of Phase 3), which already
flattens prior turns to text-only blocks for exactly this reason — no tool blocks smuggled
across a request boundary. Keep memories **separate from** `priorTurns` so the labelling is
not lost in the middle of a conversation transcript.

- **Caps (SPEC 5.3 Should):** at most **10** memories and ~**1000 tokens**. Implement as
  `topK = 10` plus a character budget (~4000 chars ≈ 1000 tokens) applied in recall order
  (most similar first), truncating the *list*, never an individual memory's text mid-fact.
- **Also instruct the final turn** that a stored preference governs *form* (language,
  length, format) but is **never evidence** — a memory is not a citable source, and
  `[n]` must still only resolve to something retrieved in this request. Without this, a
  model holding "answer in British English" and zero sources may try to cite the memory.
  This is a direct grounding risk: add it to `FINAL_SYSTEM_PROMPT`.

### D8 — Who decides what is worth remembering

**Model-elected `save_memory` only.** No automatic extraction from answers, no heuristic
"this looked like a preference" sniffing. SPEC 5.3: *"Writes are explicit and inspectable:
the agent calls `save_memory` only for stable facts/preferences (not for trivia from a
single answer)"*. The tool description is where the "stable facts, not trivia" guidance
lives, and the trace plus `GET /memory` are the inspection surface.

The invariant to protect: **nothing is remembered that `/memory` does not show.** Phase 4
satisfies it structurally — `memories` is the only durable store written by `save_memory`,
and `GET /memory` lists that collection unfiltered (bar `userId`) and unpaginated.
No implicit second store: no caching of recalled memories across requests, no stashing
preferences on the `threads` row.

### D8a — An explicit user instruction to remember must not depend on the model electing to

*Added after challenge. D1 refuses to let a prompt carry a graded requirement; leaving
`save_memory` wholly model-elected left exactly that asymmetry in place.*

**The asymmetry is real and it is the larger of the two risks.** `bench.mjs:752–768`:
`memorySaved` is `added.length > 0` — a row in `GET /memory`. A missed save does not fail
one check, it fails three: `bench.mjs:765–768` short-circuits `memoryRecalled` and
`memoryDeleted` with "nothing was saved, so recall could not be tested". All 10 points rest
on the model choosing one tool out of four on one request, under a system prompt whose
loudest instruction (BUG-010's) is about fetching pages. D2 removes the competing pressure;
it does not make the save certain.

**Recommendation: a deterministic post-loop backstop, narrowly gated.** After the gather
loop and **before** the final turn, if *both*:

- no **successful** `save_memory` call was recorded in `RunState` this run, **and**
- a conservative detector says the user's own query is an explicit instruction to remember
  something,

then run one forced extraction turn (`tool_choice: {type: 'tool', name: 'save_memory'}`)
over the user's query alone, and execute **the real `save_memory` path** — same function,
same embedding, same `MemoryDoc.parse`, same insert. Emit it as a normal `trace` step with
a `reason` saying what it is
(`"explicit save backstop: the request asked to remember something and the research loop did not save it"`),
and record it in `toolCalls` like any other.

**Why this keeps every invariant:**

- **Explicit** — more so than the model-elected path. The write is triggered by the *user's*
  own instruction, not by the model's inference and not by extraction from an answer. SPEC
  5.3's "writes are explicit and inspectable" is a contrast with implicit harvesting, and
  its neighbouring clause names the thing actually forbidden: "not for trivia from a single
  answer". The backstop never reads the answer.
- **Inspectable / trace-visible** — a real `trace` step with a real `ms`, `ok`, and on
  failure a non-empty `error`; `runs/<id>.json` lists it.
- **Nothing stored invisibly** — the row lands in `memories` and `GET /memory` lists it,
  like every other row. There is still exactly one store.
- **It can only add a save the user asked for, never suppress one** the model chose. The
  gate is "no successful save yet", so it never double-writes; C2's exact-text dedupe covers
  a near-identical race.

**The detector is the hard part, and it must be conservative.** Keyword matching is the
obvious implementation and the obvious trap — D2 already warns that "do people still
remember the 2008 crash?" must not trigger a save. Rules:

- Match an imperative addressed to the assistant about *future behaviour*, anchored at or
  near the start of the query: `remember (that |this )?`, `save (this|that)`, `keep in mind`,
  `from now on`, `for (all )?future answers`, `note that I`, `my preference is`,
  `always answer`, `don't forget`.
- **Veto if the query reads as a question** — ends with `?`, or opens with an interrogative
  (`do|does|did|what|when|who|why|how|is|are|can|should`). This is what excludes the 2008
  crash case and the whole class it represents.
- A false negative costs nothing: the request simply falls back to today's model-elected
  behaviour. A false positive costs a junk row the user can see and delete in one click.
  Tune for false negatives, never the reverse.
- Put the detector in its own module with its own table of positive and negative cases, so
  it is testable without a provider — this is the one piece of Phase 4 that is pure
  string logic, and it should be the one piece with real unit tests.

**Cost:** zero on the overwhelming majority of asks (the detector is free, and the forced
turn only runs when the detector fires *and* the model already failed to save). On the
graded save ask, worst case one small extra call.

**Discretionary saving stays model-elected**, exactly as D8 says — a user mentioning in
passing that they work in TypeScript is the model's judgement call, and no detector fires.
D8a is strictly a floor under the explicit case, not a replacement for D8.

### D9 — A failed recall must not kill the ask; a failed save must not be narrated as success

Two different honest behaviours, both A1-compliant:

- **Recall fails** (embedding provider down, index not queryable, Mongo error) → `trace`
  with `ok:false` and a non-empty `error`, `toolCalls` records the failure, and **the run
  continues** and answers from the web. Recall is an enhancement; killing a perfectly
  answerable question because a preference lookup failed would be worse service, and the
  failure is fully visible. This is **not** a swallowed provider error: it is a surfaced
  one that the run is designed to tolerate, and it is distinguishable from an empty result
  (`ok:false` + `error` vs `ok:true` + `[]`) — which is exactly what A1 demands.
- **Save fails** on a request that explicitly asked to remember something → `trace`
  `ok:false` + `error`, the `tool_result` fed back to the model is the error, **and** the
  final prompt must make the model say the save failed. A reply that reads "Got it, I'll
  remember that" over a failed write is the Live Translate shape, in miniature: the user
  believes something is stored that is not, and `GET /memory` silently disagrees with the
  answer they just read.

Phase 4 does **not** turn either into a `502`/`terminated: "error"`. Reserve that for the
LLM/search provider failures that already do it, so the existing error-rate behaviour does
not change.

### D9a — A failed save must reach the final turn as a fact, not as a hope

*Added after challenge. The question was whether the current architecture already guarantees
that a failed `save_memory` cannot be narrated as success. It guarantees less than it looks.*

**What the architecture already guarantees.** `loop.ts:131–136` pushes every failed tool
call back as `{type:'tool_result', tool_use_id, content: r.error, is_error: true}`, and
`ask.ts:99` hands that **same `history` array** to `streamFinalTurn`, which does
`[...history, buildFinalSourcesMessage(...)]` (`llm.ts:191`). So the error string is
structurally present in the final turn's context, every time, with no prompt involved. That
part is genuinely solid and needs no change.

**Two reasons that is not sufficient.**

1. **Position.** `FINAL_SYSTEM_PROMPT` says nothing about tool failures, and the last thing
   the model reads is `buildFinalSourcesMessage` — "Write the final answer now", the source
   count, and the sources — which mentions no failure. The `is_error` block sits thousands
   of tokens upstream. This repo already has a measured precedent for exactly this failure
   mode: BUG-010's fix found that stating the source count **next to the list** worked where
   a system-prompt sentence alone had not. Relying on a buried `is_error` is the same bet
   that already lost once.
2. **D8a's backstop produces no `tool_result` at all.** A backstop save happens outside the
   model's tool loop, so if *it* fails there is no `is_error` block anywhere in history. The
   model's context would contain no trace of the failure by any route — and the user
   explicitly asked for that save. This alone makes a structural fix necessary rather than
   optional.

**Recommendation — the smallest structural fix: a machine-generated memory-write status
block, appended to the final user message.**

- Track outcomes on run state: `RunState.memoryWrites: {text: string; ok: boolean; error?: string}[]`,
  appended by the real save path (both routes — model-elected and D8a's backstop), so the
  data exists independently of how the save was triggered.
- `buildFinalSourcesMessage` takes those records and, when any exist, emits a block in the
  same position and the same deterministic style as BUG-010's count note:

  ```text
  Memory write status (the system's own record of what was actually stored):
  - FAILED to save "Always answer in British English…" — MongoServerSelectionError: …
    You MUST state plainly that this was NOT saved. Do not say you will remember it.
  ```

  and on success, symmetrically, `- SAVED: "…"`.

This is not "another prompt sentence": it is content generated from run state, emitted only
when there is something to report, carrying the actual error text, placed where the model is
demonstrably looking. Static prose in a system prompt cannot name which write failed or why.

**Two further guarantees that do not depend on the model's wording at all**, worth stating
because together they are what makes this honest rather than best-effort:

- The failed save is already a streamed `trace` event with `ok:false` and a non-empty
  `error`, which the provided UI renders in its trace panel.
- `GET /memory` will not list the row, so the memory panel contradicts any false claim
  immediately, in the same screen.

**Rejected:** a post-stream guard that scans the answer text for success claims
("I'll remember", "saved", "noted") and throws like the grounding guard does. Natural-language
negation makes it both evadable and prone to killing a *correct* answer that merely says
"I could not save that, but I'll remember it for this conversation". A brittle regex that
can destroy a good answer is worse than the status block it would be backing up.

### D10 — `/health` and the vector backend

`/health` already reports `env.vectorBackend`, which from Phase 4 is genuinely exercised
for the first time. Two honesty questions arise:

- Should `status` become `degraded` when `VECTOR_BACKEND=atlas-vector-search` but
  `memories_vector` is not `queryable`? **Recommendation: no, not in Phase 4 —**
  `HealthResponse.status` currently tracks Mongo reachability, and widening it is a change
  to a Phase 3 behaviour the bench's contract probes already pass against. Instead, log a
  loud `warn` **once at startup** naming the index and its status. Revisit in Phase 8 when
  the deployed topology is fixed. Record as **GAP-014**.
- Do not add memory counts or any memory field to `/health` or `/stats` — neither
  `HealthResponse` nor `StatsResponse` has a home for them, and both are parsed by the UI.

### D11 — User isolation: the three places it must hold

Memory is the first genuinely *private, cross-thread, durable* user data in the system. One
missing `userId` leaks one user's preferences into another's answers.

| Entry point | Filter | Failure if omitted |
|---|---|---|
| `GET /memory` | `{userId}` | one user's panel lists another's facts |
| `DELETE /memory/:id` | `{_id, userId}` | user A deletes user B's memory |
| recall (`$vectorSearch`) | `filter: {userId: {$eq: userId}}` **inside the stage** | another user's preference silently steers this user's answer — the worst case, because it is invisible: no error, just a wrong-flavoured answer |
| recall (cosine-scan fallback) | `{userId}` in the `find` | same |
| recall (recency fallback) | `{userId}` in the `find` | same |

Also: **never project `embedding` into any response.** 1536 floats per row is a large,
useless payload and it is derived user data. Project it away at the query, not after
(BUG-002's lesson: `{projection: {embedding: 0}}` so it is never fetched).

`X-User-Id` is unauthenticated by design in this assignment (there is no login), so
"isolation" here means consistent scoping, not authorisation. Do not add auth; do not treat
`X-User-Id` as trusted for anything beyond scoping.

---

## Component sequence

Each component: implement the smallest slice → test independently with `curl -N` → test
through the gateway → test through the UI → run the grader → commit.

### C1 — Embedding client

**Files:** `backend/agent/src/embed.ts` (new), `backend/agent/src/env.ts` (touch only if a
dims/base-url knob proves necessary — prefer not).

Build: `embed(text: string, signal?: AbortSignal): Promise<{ embedding: number[]; tokens: number }>`
against OpenAI `/v1/embeddings` with `env.embeddingModel`. Fail loud on a missing key and on
a non-2xx (include status + a truncated body, like `llm.ts` does). Export
`EMBEDDING_USD_PER_MTOK = 0.02` next to the call, with the same "keep in sync with
`sla.json#cost_model`" comment `llm.ts` carries for the LLM prices. No retries, no
batching, no caching in this phase.

**A bounded timeout is mandatory, not optional** (revised after challenge). D9 promises
that a recall failure surfaces as `ok:false` and the ask continues; that promise is void if
the provider **hangs** rather than erroring, because an unbounded `fetch` has no failure to
surface — the request simply stops. Worse, `checkGatherBudget` is evaluated *between* turns
and tool executions and cannot interrupt an in-flight call, so `maxWallClockSec` would not
rescue it either (see GAP-016 — this is a pre-existing hole Phase 4 must not widen).

**Smallest implementation consistent with the repo.** Two timeout patterns already exist:

| Pattern | Where | Shape |
|---|---|---|
| Manual controller | `tools/fetchPage.ts:21–35` | `new AbortController()` + `setTimeout(abort)` + `clearTimeout` in `finally` |
| `AbortSignal.timeout` | `gateway/src/proxy.ts:33`, `gateway/src/index.ts` health probe | one-liner, self-cleaning |

Use **`AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)])`** when a caller
signal is present, and `AbortSignal.timeout(...)` alone when it is not. It is a single
expression, needs no `finally`, and composes the caller's disconnect abort (BUG-005's
`controller.signal`, already threaded into every other provider call) with the deadline.
`AbortSignal.any` needs Node ≥ 20.3; `package.json#engines` declares `>=20.19`, so it is
available on every supported runtime. `EMBED_TIMEOUT_MS` goes in `env.ts` as a documented
default — **8 s**, under `fetchPage`'s 10 s because an embedding is a single small POST with
no page to parse, and comfortably inside the 90 s quick envelope even if recall and a save
both time out.

One distinction to keep: an abort from the **caller's** signal is a client disconnect, not a
provider failure. It still surfaces as `ok:false` on the trace step, which is harmless —
`ask.ts`'s `send()` already no-ops on `res.writableEnded`, so nothing is written to a
departed client either way. Do not add special-casing for it.

**Done when:**
- A one-off script/`node -e` call returns an array of exactly `1536` finite numbers and a
  positive token count.
- With `OPENAI_API_KEY` unset it throws a message naming the variable, and nothing returns
  a zero vector or an empty array.
- A deliberately wrong model name surfaces the provider's 4xx status and body, not a
  generic "embedding failed".
- **Pointed at a deliberately hanging endpoint** (a local server that accepts and never
  responds), `embed` rejects in ~8 s with a timeout-shaped error — it does not hang. Verified
  with a real stub, not reasoned about.
- **The same hang during a pre-flight recall** produces a `recall_memory` trace step with
  `ok:false` and a non-empty error at ~8 s, after which the ask **still answers** from the
  web and reports `terminated: "done"` — D9's invariant holding under a hang, not just under
  an error.
- Aborting the caller's signal mid-embed rejects promptly rather than waiting out the 8 s.
- `grep -rn "sk-" backend/` finds no key and no key-shaped literal; the key is read only
  through `secrets.openai`.

### C2 — The `memories` store

**Files:** `backend/agent/src/memories.ts` (new), `backend/agent/src/collections.ts`
(add `memoriesCollection`), `backend/agent/src/run.ts` (add `embeddingTokens`, a
`recordEmbeddingCost` helper, and D9a's `memoryWrites: {text, ok, error?}[]`).

Build, all `userId`-scoped:
- `saveMemory(userId, text, sourceThread?) → {id, text, sourceThread?, createdAt}` —
  normalise/trim text, reject empty, embed (C1), build the doc with `newId('mem')` and an
  ISO-string `createdAt`, **`MemoryDoc.parse(doc)` before insert** (this is what enforces
  `.length(1536)` and `.min(1)`), then `insertOne`. This is the **single** save path: both
  the model-elected tool and D8a's backstop call exactly this function, and both record the
  outcome into `RunState.memoryWrites` (D9a) so the final turn's status block is built from
  one source regardless of which route triggered the write.
- `listMemories(userId) → Memory[]` — `find({userId}, {projection:{embedding:0}})`,
  `sort({createdAt:-1})`, map `_id → id`, return `createdAt` as an ISO string.
  `ListMemoryResponse.parse` the result in the route (C4).
- `deleteMemory(userId, memoryId) → boolean` — `deleteOne({_id: memoryId, userId})`,
  return `deletedCount === 1`.
- `countMemories(userId) → number` — for D1b's pre-flight short-circuit.
- `recallMemories(userId, query, topK) → {items, path}` — D6's three paths, D11's filters,
  D7's caps. `path` is what the trace `reason` reports.

**Dedupe (D-minor):** reject an exact normalised-text duplicate for the same user —
return the existing row's id with no new insert. The bench uses a fresh `bench-mem-*` user
per run, so its before/after diff is unaffected; a human re-saying the same preference does
not accumulate rows in the panel. Keep it to *exact normalised text* — semantic dedupe
would risk silently discarding a genuinely new, similar fact, which is a worse failure than
a duplicate row.

**Done when:**
- `saveMemory` then `listMemories` round-trips text, `sourceThread` and `createdAt`; the
  returned object has **exactly** the `Memory` keys (`jq 'keys'`) — no `_id`, no `userId`,
  no `embedding` (BUG-002's exact failure mode, re-checked here).
- A direct `db.memories.findOne()` shows `_id` as a `mem_…` **string**, not an `ObjectId`
  (BUG-008's exact failure mode, re-checked here), and `embedding.length === 1536`.
- `createdAt` round-trips as a string that passes `z.string().datetime()`.
- User A's `listMemories` never contains user B's row; `deleteMemory(A, idOfB)` returns
  `false` and B's row survives.
- `saveMemory` with a stubbed 1024-dim embedding throws at `MemoryDoc.parse`, before any
  insert — verified by checking the collection count did not change.
- Two saves of the same text under one user leave one row; two saves of the same text under
  two users leave two rows.

### C3 — `save_memory` and `recall_memory` tools, plus the pre-flight

**Files:** `backend/agent/src/tools/memory.ts` (new),
`backend/agent/src/saveIntent.ts` (new — D8a's detector, pure string logic),
`backend/agent/src/tools/registry.ts` (register both),
`backend/agent/src/loop.ts` (accept injected memory context),
`backend/agent/src/ask.ts` (pre-flight, trace step, context, D8a's backstop),
`backend/agent/src/run.ts` (embedding cost/tokens, `memoryWrites`).

Build:
- `save_memory` tool: input `{text: string, reason?: string}` (JSON Schema, not zod —
  matching `registry.ts`'s existing convention). Description carries D8's "stable facts and
  preferences the user will want applied to future conversations — not trivia from a single
  answer, not the content of this answer". `execute` needs the `userId`/`threadId`, which
  today's `ToolExecContext` does not carry → **widen `ToolExecContext`** with `userId` and
  `threadId` (the same side-channel pattern `onCacheResult` already established) rather
  than threading new parameters through every tool signature.
- `recall_memory` tool: input `{query: string}`. Returns the capped list (D7).
- Register both in `REGISTRY`. `toolsForDepth` needs **no change** — it already maps over
  `AskTool.options` and filters out whatever is absent from `REGISTRY`, so registering
  these two is all that makes them available, and `plan_research`/`search_documents`
  stay absent.
- Pre-flight in `ask.ts` (D1): before `runGatherLoop`, call the same recall path, emit a
  `trace` with `step: 1`, `tool: 'recall_memory'`, the real `input`/`ok`/`ms`, and D1's
  `reason`; `recordToolCall` it; pass the texts into `runGatherLoop` as memory context.
  The loop's own `step` counter must continue from there, not restart at 1 — `TraceEvent.step`
  is `.int().positive()` and a duplicated step number makes the trace unreadable.
  (`ask.ts` already tracks `step = Math.max(step, ev.step)`; the loop's internal counter is
  what needs an offset.)
- `saveIntent.ts` (D8a): `isExplicitSaveRequest(query: string): boolean` — the anchored
  imperative table plus the interrogative veto. Pure, no I/O, no provider. Ship it with its
  own case table (positives: the bench's literal string, `"from now on, use British English"`,
  `"remember that I build in TypeScript"`; negatives: `"do people still remember the 2008
  crash?"`, `"what should I remember about RRF?"`, `"how do I save a document?"`).
- D8a's backstop in `ask.ts`: after `runGatherLoop` and **before** the `sources` event and
  the final turn, if no successful `save_memory` is in `state.toolCalls` **and**
  `isExplicitSaveRequest(query)`, run one forced extraction turn
  (`tool_choice: {type:'tool', name:'save_memory'}`) over the user's query and execute the
  real save path. Emit it as a trace step with the backstop `reason`, `recordToolCall` it,
  and record the outcome in `state.memoryWrites`. It must run before the final turn so D9a's
  status block can report it.

**Ordering constraint:** the backstop sits between the loop and `sources`, so the
`trace* → sources → token* → done` order is preserved — a trace step after `sources` would
break the contract's declared sequence and `lib.mjs`'s `sourcesBeforeFirstToken` check.

**Done when:**
- `curl -N` an ask for a user with zero memories: the first `trace` is `recall_memory`,
  `ok:true`, with the "no stored memories" reason, and **no** embedding call was made
  (verified from the log, not inferred).
- `curl -N` an ask containing "remember that I prefer TypeScript": the trace shows
  `save_memory` with `ok:true`, and `GET /memory` lists the row immediately after.
- **D8a backstop:** with the `save_memory` tool temporarily removed from the model's
  manifest (so the model *cannot* elect it), the bench's literal save string still leaves
  exactly one row in `GET /memory`, and the trace shows the backstop step with its
  `reason`. Restore the manifest and confirm the backstop now does **not** fire (no double
  row) because the model's own save succeeded first.
- **Detector:** every case in `saveIntent.ts`'s table passes as a unit test with no network;
  `"do people still remember the 2008 crash?"` saves nothing and the trace contains no
  `save_memory` step at all.
- A **new thread, same user**, asking something unrelated: the trace's first step is
  `recall_memory` with `ok:true` and the step's result contains the TypeScript preference.
- The same question in a **different user's** thread recalls nothing.
- `runs/<requestId>.json` lists `recall_memory` (and `save_memory` where applicable) in
  `toolCalls`, in execution order, and still passes `RunLog.parse` (it is parsed in
  `buildRunLog`, so a malformed record fails loudly at write time).
- With `OPENAI_API_KEY` deliberately broken: the recall step is `ok:false` with a non-empty
  `error`, the ask **still answers** from the web, `done.terminated` is `"done"` (not
  `"error"`), and the HTTP status stays `200` (D9).
- With Mongo deliberately unreachable during a save: the save step is `ok:false` with a
  non-empty `error` and the streamed answer **says the save failed** (read the prose).
- `trace` step numbers are strictly increasing with no duplicates across the pre-flight/loop
  boundary.
- Index prerequisite: `node scripts/create-indexes.mjs --status` reports
  `memories/memories_vector` as `queryable` before any recall number is believed.
- `VECTOR_BACKEND=mongo-cosine-scan` recalls the same row via the scan path, and the trace
  `reason` says so.

### C4 — `GET /memory`

**Files:** `backend/agent/src/index.ts` (route + `BUILT_ROUTES`).

Build: `requireUserId` → `listMemories(userId)` → `ListMemoryResponse.parse` →
`200`. Add `'GET /memory'` to the agent's `BUILT_ROUTES` set so the 501 loop skips it.

**Done when:**
- `GET /memory` with a fresh user returns `200 {"memories":[]}` — an empty list, never a
  `404` and never `{}` (`MemoryPanel.tsx:17` reads `r.memories ?? []`, but the contract
  requires the key).
- `jq '.memories[0] | keys'` returns exactly `["createdAt","id","sourceThread","text"]`
  (or without `sourceThread` when unset — and `null` never appears; BUG-001's
  `ignoreUndefined` covers the write side, and the projection covers the read side).
- Rows are newest-first (`bench.mjs`'s `added[0]` depends on it).
- Three saves → three rows; the response passes `ListMemoryResponse.parse` in a test
  harness, not just by eye.
- `GET /memory` **without** `X-User-Id` → still `401` through the gateway (the C6 regression
  check for `bench.mjs:160`).

### C5 — `DELETE /memory/:memoryId`

**Files:** `backend/agent/src/index.ts` (route + `BUILT_ROUTES`).

Build: `requireUserId` → `deleteMemory(userId, id)` → **`res.status(204).end()`**
unconditionally (D4): no body, no `content-type`, and no `404` branch. D3's regex is a
log-only `warn` on an implausible id, never a status.

**Done when:**
- `curl -i -X DELETE` of an existing own row → `204`, zero-length body, **no
  `content-type` header** (this is what keeps `proxyToAgent`'s `res.status(204).send(text)`
  from attaching one downstream — verify through the gateway too, not just the agent).
- A second `DELETE` of the same id → `204` again (idempotent), and `GET /memory` is
  unchanged.
- `DELETE` of another user's id → `204`, **and that row is still present in the owner's
  `GET /memory`** — checked directly against the owner's list, since the status code
  deliberately reveals nothing (D4.4).
- `DELETE /memory/..%2F..%2Fetc` → `204`, a `warn` in the log naming the rejected id, no
  stack trace, no 500, and no row deleted for anyone.
- `benchmark/lib.mjs`'s `del()` never throws on any of the above — the `cap()` overwrite
  hazard in D4.3 cannot be triggered.
- `DELETE /memory/<id>` without `X-User-Id` → `401`.
- After the delete, a fresh thread's `recall_memory` no longer returns it and the answer
  no longer reflects it (the rubric's "the effect disappears" half).

### C6 — Gateway wiring

**Files:** `backend/gateway/src/index.ts` (two route lines + `BUILT_ROUTES`).

Build:
```ts
app.get('/memory', proxyToAgent());
app.delete('/memory/:memoryId', proxyToAgent());
```
and add both to `BUILT_ROUTES`. No `validateBody` (neither route has a body). No new
middleware: auth, rate limiting, request-id and the error handler all already cover them.

**Done when:**
- Both routes behave identically through `:8787` and `:8000` (same status, same body, same
  `jq` keys) for: empty list, populated list, successful delete, repeat delete, other
  user's delete.
- `x-request-id` round-trips on both and appears in **both** services' pino logs for the
  same request (rubric `observability`).
- The per-user rate limit applies to them (31st request in a window → `429` with
  `resetsAt`) and `/health` is still exempt.
- `GET /memory` with an empty `x-user-id` → `401` (not `501`, not `200`) — the
  `bench.mjs:160` probe.
- `grep -rn "openai\|OPENAI" backend/gateway/` returns nothing. No provider key enters the
  gateway (AGENTS.md red line).
- The SPA catch-all still does not swallow `/memory` (it is in the regex exclusion list).

### C7 — Prompts: the save-only path and memory-as-form-not-evidence

**Files:** `backend/agent/src/llm.ts` (`GATHER_SYSTEM_PROMPT`, `FINAL_SYSTEM_PROMPT`,
`buildFinalSourcesMessage` if the memory context needs restating next to the sources).

Build D2's carve-out and D7's "a memory is not a source" rule. Keep BUG-010's
fetch-before-stop intact for actual questions. If a stored preference is in play, the final
turn should honour it (language, length, format) while leaving citation rules untouched.

Also build **D9a's memory-write status block**: `buildFinalSourcesMessage` takes
`state.memoryWrites` and, when non-empty, emits the deterministic `SAVED` / `FAILED to save`
block next to the source count — the position BUG-010 proved effective. Built from run
state, not from prose, and emitted only when there is something to report.

**Done when:**
- `"Remember this preference for all future answers: Always answer in British English and
  keep answers under 100 words."` (the bench's literal string, `mode: "web"`) produces:
  a `save_memory` trace step with `ok:true`; **zero** `web_search`/`fetch_page` steps; an
  empty `sources` event **before** the first token; a short confirming answer with **no
  `[n]` citations**; `done` with `terminated: "done"`; and **no `error` event** (the
  `M.errors++` trap).
- A normal question still searches *and* fetches (BUG-010 has not regressed): re-run the
  "who is Lionel Messi?" case from BUG-010's verification and confirm
  `web_search → fetch_page → sources → token`.
- A question like "do people still remember the 2008 crash?" is treated as a question —
  it searches and fetches, and does **not** save a memory.
- With the British-English preference stored, a later answer in a new thread is
  observably British-English and short, and still cites only sources retrieved in that
  request; the grounding guard does not trip.
- A model that tries to cite a memory is caught: temporarily inject a memory and a
  0-source request and confirm either no citation is written, or the existing
  `unresolvedCitations` guard throws (it must not silently pass).
- **D9a, the one that matters:** force the save to fail (Mongo unreachable, or a stubbed
  `saveMemory` that throws) on the bench's literal save string, then **read the streamed
  prose**. It must say the preference was not saved and must not promise to remember it.
  Run this on both save routes — model-elected *and* D8a's backstop, which produces no
  `tool_result` at all and is the case the status block exists for.
- With a **successful** save, the status block's `SAVED` line does not make the model
  verbose or make it start citing the memory — check the answer still reads normally.

### C8 — Observability & cost truthfulness

**Files:** `backend/agent/src/runlog.ts`, `backend/agent/src/run.ts`, `.env.example` (only
if a new knob was genuinely added), `.claude/BUG-AUDIT.md`.

Build: embedding cost into `state.costUsd` (D5); `embeddingTokens` tracked on `RunState`
and logged (not folded into `tokens`); the startup warn for a non-queryable
`memories_vector` (D10). Write up the new BUG-AUDIT entries (see below).

**Done when:**
- A run that embedded twice (pre-flight recall + a save) shows a `costUsd` strictly greater
  than the LLM-only cost by the expected embedding amount — checked by arithmetic against
  `embedding_usd_per_mtok`, not by eyeballing.
- `done.tokens.in/out` still match the Anthropic usage in the log exactly (no embedding
  tokens leaked in).
- `/stats.costUsdToday` still reconciles with the summed `runs` rows within 1%.
- `node quality/check.mjs .` reports **no error-severity failure** over `runs/` — in
  particular A1 (every `ok:false` tool call carries an error) and A3 (no >3 consecutive
  same-tool, which the pre-flight cannot cause).
- `runs/failing/` still holds the deliberately-broken run and `runs/` does not.

---

## Whole-phase verification

Run in this order. Nothing below is "spot-check it in the UI".

### 1. The graded memory path, by hand, exactly as the bench walks it

Use a brand-new user id (`phase4-mem-$(date +%s)`) so there is no pre-existing state —
mirroring `bench.mjs`'s fresh `bench-mem-*` user.

```text
GET  /memory                                     → 200 {"memories":[]}
POST /threads {}                                 → thread A
POST /threads/A/ask  "Remember this preference for all future answers: Always answer in
                      British English and keep answers under 100 words."   (mode: web)
   → trace: recall_memory(ok, 0 memories) → save_memory(ok)
   → sources: []  BEFORE the first token
   → a short confirmation, no [n]
   → done: terminated "done" ·  NO error event
GET  /memory                                     → exactly 1 row, newest-first, Memory keys only
POST /threads {}                                 → thread B
POST /threads/B/ask  "What is the capital of Portugal?"                    (mode: web)
   → trace step 1: recall_memory, ok:true, returns the preference
   → the answer is British-English and short, and cites only pages fetched in THIS request
DELETE /memory/<id>                              → 204, empty body
DELETE /memory/<same id again>                   → 204 again (idempotent, D4)
GET  /memory                                     → 0 rows
POST /threads {}  → thread C, same question
   → recall_memory ok:true with an empty result; the answer is no longer styled by the
     deleted preference
```

Every step through **:8787**, then repeat the whole sequence directly against **:8000** and
diff the bodies.

### 2. Isolation and privacy

- Two users, one memory each: neither `GET /memory` shows the other's; neither can
  `DELETE` the other's; neither's answers are styled by the other's preference.
- `grep -rn "embedding" ` over captured responses: no 1536-float array appears in **any**
  HTTP body (`/memory`, `/threads/:id`, the SSE stream, `/stats`, `/health`).
- No secret reachable: `grep -rn "OPENAI_API_KEY\|sk-" web/ backend/gateway/` is empty, and
  no endpoint echoes it.

### 3. Failure injection (A1 / fail-loud)

| Injected failure | Required behaviour |
|---|---|
| `OPENAI_API_KEY` invalid | recall step `ok:false` + non-empty error; ask still answers; `terminated: "done"`; HTTP 200 |
| **Embedding endpoint hangs** (stub that never responds) | recall step `ok:false` at ~8 s (C1's `EMBED_TIMEOUT_MS`), ask still answers, `terminated: "done"` — D9 holding under a hang, not only under an error |
| Mongo unreachable mid-save | save step `ok:false` + error; **the prose says the save failed** (D9a's status block); `GET /memory` agrees (no row) |
| Same, but via D8a's backstop (no `tool_result` in history) | identical prose behaviour — this is the case the status block exists for |
| `memories_vector` deleted | recall falls back to recency, the trace `reason` says so, `/health` still names the backend, startup logged a warn |
| LLM provider 5xx | unchanged from Phase 3: `error` event, `terminated: "error"` — memory must not have altered this |
| `DELETE /memory/<traversal payload>` | `204`, a log `warn`, no 500, no stack trace, nothing deleted |

### 4. Regression — Phases 1–3 must be untouched

- `GET /threads`, `GET /threads/:id`, `POST /threads`, `/stats`, `/health` — same shapes.
- Thread history still works: a follow-up in the same thread still resolves "it".
- Search cache still reports honest `searchCached` (same query twice → `false` then `true`).
- `mode: "docs"` → `501`; `depth: "deep"` → `501`. **Phase 4 must not have made either
  start working.**
- `grep -rn "plan_research\|search_documents" backend/agent/src/tools/registry.ts` finds
  neither registered.
- Rate limit, request-id validation (SEC-003), BUG-007's 400-vs-502 split: re-probe each.
- `git status` shows **no** modification under `web/`, `packages/contract/`, `benchmark/`,
  `eval/`, `quality/`, `scripts/` — the red line, checked with
  `git status --porcelain -- web packages benchmark eval quality scripts` (must be empty).

### 5. Graders

```bash
node scripts/create-indexes.mjs --status     # memories_vector must be queryable first
node quality/check.mjs .                     # no error-severity failure over runs/
node benchmark/bench.mjs                     # the full run, NOT --smoke (smoke skips memory)
```

Then read `reports/bench.json` and confirm **`memorySaved`, `memoryRecalled` and
`memoryDeleted` are all `true`** with sensible `why` strings, and that `errorRate`,
`citationGrounding` and `retrievalRate` have **not regressed** versus the last Phase 3 run.
Record the TTFT before/after delta attributable to the pre-flight recall.

A full bench run costs real money and includes RAG/deep phases that are still `501`. Expect
those rows to fail — that is correct for Phase 4. What must be true is: the memory rows
pass, and no previously-passing row broke.

### 6. UI

`web/`'s `MemoryPanel` is already built and already calls both routes. Confirm the panel
lists saved memories with a working delete button, and that `App.tsx`'s `memoryKey` refresh
(bumped after an ask, `App.tsx:156`) makes a newly-saved memory appear without a reload.
No `web/` edits — it is a red line.

---

## New BUG-AUDIT entries Phase 4 should add

Add these to `.claude/BUG-AUDIT.md` as they are confirmed, with the same structure as the
existing entries.

| ID | Title | Why it goes in the audit |
|---|---|---|
| `GAP-010` | Embedding tokens counted in `costUsd` but excluded from `done.tokens` / `RunLog.tokens` | D5. A declared asymmetry between two token meters, not an oversight. A reader comparing `tokens` to `costUsd` would otherwise find a discrepancy and have to guess. |
| `GAP-011` | `recall_memory` is a deterministic pre-flight, not purely model-elected | D1. The trace's `reason` says so, but the *reason for the design* (a graded assertion a prompt cannot reliably satisfy) belongs in the audit so it is not later "simplified" back into a model-elected call. |
| `GAP-012` | Quick runs now have 7, not 8, model-available tool calls | D1a. The pre-flight consumes one of the 8. Harmless today (typical run = 4) but it is a real narrowing of a declared cap and must not be discovered by a future phase as a mystery. |
| `GAP-013` | `DELETE /memory/{id}` is unconditionally idempotent `204`, never `404` | D4. Record the reasoning *and* the evidence (`web/src/api.ts:62` special-cases 204; `bench.mjs:93`'s `cap` overwrite + `lib.mjs:59`'s throw make a 404 able to zero an already-passing check) so a later phase does not "correct" it toward REST convention. |
| `GAP-014` | `/health` does not degrade when `memories_vector` is not queryable | D10. Startup warns; `status` is unchanged. Deferred to Phase 8 with the rest of the deployment-shaped work. |
| `GAP-015` | Recency fallback when `$vectorSearch` returns nothing | D6. An eventual-consistency accommodation that is visible in the trace but is *not* semantic recall. Must be named, or a recall number taken during index lag would be attributed to the vector path. |
| `GAP-016` | **`maxWallClockSec` is not a deadline, and two of three provider calls are unbounded** | **New blocker-class finding, pre-existing.** `webSearch.ts:52` (Tavily) and `:86` (SerpApi) pass no `signal` and no timeout; `llm.ts:85`/`:196` bound nothing but the caller's abort. `checkGatherBudget` is only evaluated *between* turns and tool executions (`loop.ts:45`, `:63`), so it cannot interrupt an in-flight call. A hung provider therefore runs past the 90 s quick cap indefinitely — the only bound is the client's own timeout (`lib.mjs`'s 300 s). That breaks `answer_p95_ms`/`deep_answer_p95_s` and makes rule A2 dishonest (an overrun is never reported as `terminated: "cap"`). Phase 4 does **not** fix it — but `embed.ts` is bounded from the start (C1) so the phase does not widen it, and Phase 8 owns the fix (a deadline-derived `AbortSignal` threaded into every provider call). |
| `GAP-017` | Explicit-save backstop (D8a) and its string detector | D8a. A deterministic write triggered by a string match is exactly the kind of mechanism a later reader would be right to be suspicious of. Record why it exists (one missed save fails three graded checks via `bench.mjs:765`), why it is safe (gated on "no successful save yet", trace-visible, listed in `GET /memory`, can only add a user-requested save), and where its case table lives. |

**Update, don't duplicate:** `GAP-001` (TTFT) gains a line recording the pre-flight's
measured contribution. The "Files changed vs. the provided skeleton" table gains
`embed.ts`, `memories.ts`, `tools/memory.ts`, `saveIntent.ts`, and the modifications to
`registry.ts`, `loop.ts`, `ask.ts`, `llm.ts`, `run.ts`, `runlog.ts`, `collections.ts`,
`index.ts` (both services).

**Existing gaps Phase 4 closes:** none outright. It is the first phase to actually exercise
`env.vectorBackend`, `env.embeddingModel` and `secrets.openai`, all of which have been
declared-but-dead since the skeleton — worth noting in the audit as resolved dead
configuration rather than as a gap.

---

## Ambiguities and contradictions surfaced (with recommendations)

Flagged explicitly rather than silently resolved. Each has a recommendation above; this is
the index.

1. **`MemoryId` is unprefixed in the contract, but `newId()` has a `'mem'` member.**
   `ids.ts:19` says `z.string().min(1)`; `ids.ts:28`'s union includes `'mem'`. The contract
   permits anything and hints at `mem_`. → **D3: use `newId('mem')`.** (Same class of
   contract inconsistency as BUG-008's missing `'msg'`, but resolved in our favour.)

2. **`DELETE /memory/{id}` has no declared miss behaviour.** SPEC §7 gives only `204`; the
   status table lists `404` for "unknown thread/space/document" and **omits memory** from an
   otherwise exhaustive enumeration. → **D4 (revised): unconditional idempotent `204`.** The
   provided UI hard-codes the 204 case (`web/src/api.ts:62`) and renders anything else as an
   error; a `404` can retroactively zero an already-passing `memorySaved` through
   `lib.mjs:59`'s throw and `bench.mjs:93`'s overwriting `cap`; and `204`-always is the
   *more* privacy-preserving branch, not the less. Logged as GAP-013.

3. **"The trace shows `recall_memory` returning it" vs. a model that will not call it.**
   SPEC 5.3 and the rubric require a trace step on a question that gives a model no reason
   to recall (`bench.mjs` asks for the capital of Portugal). The spec never says *the model
   must choose* to recall. → **D1: deterministic pre-flight, labelled in `reason`.**

4. **`GATHER_SYSTEM_PROMPT` (BUG-010's fix) directly conflicts with a save-only request.**
   "Fetch at least one relevant result before you stop" versus a request whose entire job
   is to store a sentence. Left alone, the graded save ask burns a search and a fetch and may
   not save at all. → **D2: an intent-based carve-out, keeping BUG-010 intact for
   questions.** This is the single highest-risk item in the phase.

5. **`RunLog.tokens` is one total across two different providers' token meters.** The
   contract comment ties it to the `done` event's LLM `{in,out}`; embeddings are a third
   number with no declared home. → **D5: cost in, tokens out, declared as GAP-010.**

6. **Atlas Vector Search is eventually consistent, and the graded flow saves then recalls
   seconds later.** DESIGN.md Q4 already states vector indexing is eventually consistent;
   SPEC mandates a read-your-write probe for *documents* (5.4) and says nothing for
   *memories*. → **D6: vector primary + trace-visible recency fallback.** A read-your-write
   probe on save was considered and rejected for this phase: it would add latency to the
   graded save ask and, unlike a document's `indexed` status, there is no status field in
   `Memory` to hold the result — the honest place to handle the lag is at read time.

7. **SPEC 5.3's "~10 documents / 1 000 tokens" cap is a `Should` with no declared constant.**
   No number for it exists in `sla.json`/`expectations.json`/`rubric.json`. → **D7: `topK = 10`
   and a ~4000-character budget, as documented defaults in `env.ts`** (the same posture
   Phase 3 D5 took for `SEARCH_CACHE_LRU_MAX`), not magic numbers in the recall function.

8. **Who owns the "stable facts, not trivia" judgement?** SPEC 5.3 asks for discretion that
   only a prompt can express, while the audit's recurring lesson is that a prompt is a
   suggestion. → **D8: accept the prompt as the mechanism for *discretionary* saves,
   because the backstop is structural rather than preventive** — every write is listed at
   `GET /memory` and is one click from deletion. Over-saving is a visible, reversible
   annoyance; automatic extraction would be an invisible one. Do not add a filter that
   silently drops a save the model asked for: that would mean the trace shows a write that
   did not happen. **An *explicit* user instruction is not a discretion case**, and leaving
   it prompt-dependent contradicted D1's own reasoning — see D8a, item 9.

9. **"The agent calls `save_memory`" (SPEC 5.3) — does that require the *model* to elect
   it?** The clause's own neighbour names what is actually forbidden ("not for trivia from a
   single answer"), so "explicit" reads as a contrast with implicit harvesting rather than a
   statement about which component issues the call. Meanwhile `bench.mjs:752` scores
   `memorySaved` on a row in `GET /memory` and never requires the trace step at all.
   → **D8a: a user-triggered deterministic save is the most explicit write in the system**
   and satisfies every property the spec states (explicit, inspectable, trace-visible,
   listed, deletable). Flagged rather than assumed, because a grader reading the clause
   narrowly could see it differently; the mitigation is that the trace `reason` says exactly
   what fired and why. Logged as GAP-017.

10. **Nothing in the spec or the declared numbers bounds a provider call.** No timeout
    appears in `sla.json`/`expectations.json`/`rubric.json`, and the repo bounds exactly one
    call (`fetchPage.ts:11`, 10 s). The caps table in AGENTS.md reads as though
    `maxWallClockSec` were a deadline, but `checkGatherBudget` is only evaluated between
    turns (`loop.ts:45`, `:63`) and cannot interrupt an in-flight request. → **C1 bounds
    `embed` at 8 s so Phase 4 adds no new unbounded call; GAP-016 records the pre-existing
    hole** in `webSearch.ts:52`/`:86` and `llm.ts:85`/`:196` for Phase 8.

11. **A failed tool result is in the final turn's context but not at its generation point.**
    `loop.ts:131–136` guarantees the `is_error` block reaches `streamFinalTurn` via the
    shared `history`, which is a real structural guarantee — but BUG-010 already established
    in this repo that an upstream statement loses to one placed next to the list the model is
    reading. And D8a's backstop produces no `tool_result` at all. → **D9a: a deterministic
    memory-write status block built from `RunState.memoryWrites`**, not another system-prompt
    sentence. A prose-scanning guard was considered and rejected (evadable, and able to kill
    a correct answer that honestly reports the failure).

---

## Summary

### 1. Phase 4 scope

Long-term, per-`X-User-Id` memory and nothing else: an embedding client, the `memories`
store, the `save_memory` and `recall_memory` tools, semantic `userId`-filtered recall over
the `memories_vector` index (with a cosine-scan dev path and a trace-visible recency
fallback for index lag), `GET /memory`, `DELETE /memory/{id}` → `204`, the two gateway
route lines, prompt changes so a save-only request is not dragged through a pointless web
search and so a memory is never mistaken for a citable source, and honest embedding-cost
accounting. **Out:** all of Phase 5 (spaces, uploads, chunks, the worker, `search_documents`),
Phase 6 routing (`mode` stays unacted-on, `GAP-007` stays open), Phase 7 deep research
(`depth: "deep"` stays `501`, `plan_research` stays unregistered), and Phase 8 tuning —
Phase 4 *worsens* TTFT and records the delta rather than chasing it.

### 2. Component sequence

C1 embedding client (bounded) → C2 `memories` store → C3 the two tools + the pre-flight
recall + D8a's save backstop → C4 `GET /memory` → C5 `DELETE /memory/:id` → C6 gateway
wiring → C7 prompts + D9a's status block → C8 observability/cost. Each with its own
done-when list; C1–C3 are where the real risk is, C4–C6 are small and mostly contract-shape
discipline.

### 3. Important architectural decisions

- **D1** Deterministic pre-flight `recall_memory` on every ask, labelled in the trace's
  `reason`, with the tool also left in the model's toolset — because a prompt cannot
  reliably satisfy a graded trace assertion, and a fabricated trace step is not an option.
- **D8a** The same reasoning applied to the write side: an **explicit** user instruction to
  remember something gets a deterministic backstop (real `saveMemory` path, real trace step,
  gated on "no successful save yet" plus a conservative question-vetoing detector), because
  one missed save fails three graded checks at once. Discretionary saving stays model-elected
  per **D8**; no automatic extraction, ever.
- **D2** An intent-based carve-out in `GATHER_SYSTEM_PROMPT` for record-this requests,
  without weakening BUG-010's fetch-before-stop rule for questions.
- **D9a** A failed save is reported to the final turn as a machine-generated status block
  built from `RunState.memoryWrites` — positioned where BUG-010 proved injected facts land,
  and necessary because D8a's backstop produces no `tool_result` to inherit.
- **D4** `DELETE /memory/{id}` is **unconditionally idempotent `204`**, never `404`: the only
  status SPEC §7 declares, the only one the provided UI handles (`web/src/api.ts:62`), the
  one that cannot throw inside `runMemory` and zero an already-passing check
  (`lib.mjs:59` + `bench.mjs:93`), and the branch that leaks no existence/ownership oracle.
- **D5** Embedding cost into `costUsd`, embedding tokens *out* of `done.tokens`, declared.
- **D6** `$vectorSearch` with `userId` filtered *inside the stage*, a trace-visible recency
  fallback for Atlas index lag, and a `mongo-cosine-scan` path for local dev.
- **D7** Recalled memories injected as a labelled text block via the existing `seedHistory`
  mechanism, capped at 10 / ~1000 tokens, with the final prompt told that a memory governs
  *form* and is never evidence.
- **C1** Every provider call Phase 4 adds is bounded —
  `AbortSignal.any([signal, AbortSignal.timeout(8_000)])` — because D9's "a failed recall
  surfaces and the ask continues" is void if the provider hangs instead of erroring.

### 4. Gaps and risks discovered

- **Highest risk: the prompt conflict (D2/ambiguity 4).** The graded save ask hits
  BUG-010's fetch-before-stop instruction head-on. If the model searches instead of saving,
  all three memory checks fail together (`bench.mjs:765` short-circuits) — 10 points on one
  prompt edit. Test this exact string early, before building C4–C6. **D8a's backstop is the
  floor under this risk**, which is why it is no longer carried by the prompt alone.
- **Second risk: `memoryRecalled` depends on a trace step for an unrelated question.**
  Mitigated by D1, but it is the reason D1 cannot be "just prompt it".
- **NEW BLOCKER (GAP-016) — `maxWallClockSec` is not a deadline, and two of three provider
  calls are unbounded.** `webSearch.ts:52`/`:86` pass no signal and no timeout; `llm.ts`
  bounds nothing but the caller's abort; and `checkGatherBudget` is evaluated only *between*
  turns (`loop.ts:45`, `:63`), so it cannot interrupt an in-flight call. A hung provider
  therefore runs past the 90 s quick cap until the client gives up (300 s in `lib.mjs`).
  This breaks `answer_p95_ms`/`deep_answer_p95_s` and makes rule A2 dishonest — an overrun is
  never reported as `terminated: "cap"`. **Pre-existing, discovered while checking C1's
  timeout; not Phase 4's to fix.** Phase 4's obligation is only not to widen it, which C1
  satisfies. Phase 8 owns the real fix: one deadline-derived `AbortSignal` threaded into
  every provider call.
- **D8a's detector is the one piece of new string logic that can be wrong in both
  directions.** A false positive stores a junk row (visible, one-click deletable); a false
  negative just restores today's model-elected behaviour. Tuned for false negatives, vetoes
  anything reading as a question, and it is the one module in Phase 4 with real unit tests.
- **Atlas index lag and index-build time** can make recall return nothing on a fresh
  cluster. Mitigated by D6's fallback; `create-indexes.mjs --status` must say `queryable`
  before any recall number is believed.
- **TTFT and cost pressure compound.** `GAP-001` is already ~5× over `ttft_p95_ms`, and
  BUG-010's residual already puts a real cited answer over `max_cost_per_answer_usd`. Phase
  4 adds an embedding + a vector query to every ask. Measure and record; Phase 8 owns it.
- **The quick tool-call cap narrows from 8 to 7** model-available calls (GAP-012).
- **Privacy surface is new.** Memory is the first durable cross-thread private user data; a
  single missing `userId` — especially the one *inside* `$vectorSearch` — leaks silently,
  with no error, as a subtly wrongly-styled answer. Three enforcement points (list, delete,
  recall ×3 paths) plus "never project `embedding`".
- **Spec silences** on the delete-miss status, the recall cap constants, memory-side
  read-your-write, provider timeouts, and whether "the agent calls `save_memory`" names the
  model are resolved above with reasons rather than quietly chosen, and are queued as
  GAP-010 through GAP-017.

---

**Nothing in this plan is implemented yet.** `backend/agent/src/embed.ts`,
`memories.ts`, `tools/memory.ts` and `saveIntent.ts` do not exist; `/memory` and
`/memory/:id` still answer `501` from both services. Start at C1.

**Revision note.** D4, D8a, D9a and C1's timeout were revised after a challenge pass that
re-checked four decisions against `bench.mjs`, `benchmark/lib.mjs`, `web/src/api.ts`,
`loop.ts` and `llm.ts`. D4 reversed outright (`404`-on-miss → unconditional `204`); D8a and
D9a are new; C1 gained a mandatory bound. GAP-016 was discovered during that pass and is the
one finding that reaches beyond Phase 4.
