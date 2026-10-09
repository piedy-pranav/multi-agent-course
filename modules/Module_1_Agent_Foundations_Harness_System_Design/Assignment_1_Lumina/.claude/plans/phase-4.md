# Phase 4 — Long-Term Memory

Read first: `.claude/CLAUDE.md`, `.claude/BUG-AUDIT.md`, `SPEC.md`, `TECHNICAL.md`,
`DESIGN.md`, `AGENTS.md`, `packages/contract`, and the completed Phase 3 plan.

This file is the Phase 4 implementation blueprint only.

## Goal

Implement durable per-user memory so that:
- explicit user preferences/facts can be saved;
- they can be recalled in later threads;
- `GET /memory` lists them;
- `DELETE /memory/:memoryId` removes them;
- recalled memory affects answer style/behaviour but is never citation evidence;
- all behaviour is user-scoped, trace-visible, and cost-accounted.

A preference saved in thread A must affect thread B; deleting it must remove the effect.

---

## 1. Preserve Phase 3

Do not rebuild or regress:
- gather loop / tool execution;
- budgets / `RunState`;
- source-first SSE order;
- grounding guard;
- thread history;
- search cache;
- run logging + `/stats`;
- gateway auth / proxy / SSE / rate limiting;
- request-id correlation.

Already available — **do not rebuild or "fix" any of these**:
- gateway auth already makes `/memory` unauthenticated calls return `401`
  (`gateway/src/index.ts`, auth middleware runs before the 501 loop — satisfies
  `bench.mjs:160`'s probe today);
- generic `proxyToAgent()` supports GET/DELETE (`gateway/src/proxy.ts:25` sets
  `hasBody = false` for DELETE; a bodyless 204 forwards correctly);
- **`toolsForDepth` needs no change** (`tools/registry.ts`) — it maps over
  `AskTool.options` and skips whatever is absent from `REGISTRY`, so adding the two
  memory tools to `REGISTRY` is the whole job, and `plan_research`/`search_documents`
  stay unavailable automatically;
- `loop.ts` already feeds a failed tool back as `{tool_result, is_error:true}`
  (`loop.ts:131–136`) and `ask.ts:99` passes that same `history` array into
  `streamFinalTurn`, so a tool error already reaches the final turn's context;
- `loop.ts` already accepts a text-only `seedHistory` (Phase 3 D6) — the injection point
  for D7's memory context;
- `scripts/indexes.json` already defines the memories index and `memories_vector` with 1536-dim cosine + `userId` filter;
- OpenAI embedding env/config already exists (`env.ts` `embeddingModel`, `secrets.openai`).

Protected/source-of-truth directories stay untouched:
`web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`.

Known non-Phase-4 gaps remain deferred: TTFT/cost optimisation, SerpApi exercise, auto routing, deep research, deployment, global provider deadline enforcement.

---

## 2. Scope

### In
1. embedding client;
2. memories store;
3. `save_memory`;
4. `recall_memory`;
5. deterministic recall pre-flight;
6. explicit-save backstop;
7. `GET /memory`;
8. idempotent `DELETE /memory/:memoryId`;
9. gateway wiring;
10. prompt changes;
11. embedding cost/token tracking;
12. Atlas vector recall + cosine dev fallback + visible recency fallback.

### Out
- Phase 5: spaces, uploads, GridFS, chunks, worker, `search_documents`;
- Phase 6: docs/web/auto routing;
- Phase 7: deep research / `plan_research`;
- Phase 8: SLA tuning / deployment;
- automatic harvesting from answers;
- memory summarisation / expiry / editing;
- BM25/RRF for memories;
- UI changes.

---

## 3. Contract

Relevant shapes:

```ts
Memory = { id, text, sourceThread?, createdAt }

MemoryDoc = {
  _id: string,
  userId,
  text,
  embedding: number[1536],
  sourceThread?,
  createdAt
}
```

HTTP:

```text
GET    /memory        → 200 {memories:[...]}
DELETE /memory/:id    → 204
missing X-User-Id     → 401
```

Must hold:
- every memory operation scoped by `userId`;
- writes explicit + inspectable;
- recall demonstrable across threads;
- `recall_memory` appears in trace;
- nothing remembered that `/memory` does not show;
- memory is context, not evidence;
- failed tool call = `ok:false` + non-empty `error`.

---

## 4. Graded flow

Worth 10 rubric points (`eval/rubric.json#memory`), scored by `benchmark/bench.mjs:726–798`
(`runMemory()`). **Read that function before coding C3.** A fresh `bench-mem-*` user every
run, so there is never pre-existing state. One missed save fails all three checks:
`bench.mjs:765–768` short-circuits `memoryRecalled` and `memoryDeleted` when nothing saved.

Benchmark path:

```text
fresh user
GET /memory

thread A
"Remember this preference for all future answers:
 Always answer in British English and keep answers under 100 words."

GET /memory
→ new row exists

thread B
"What is the capital of Portugal?"

trace
→ successful recall_memory

DELETE saved row
GET /memory
→ gone
```

Implications:
- explicit save must be reliable;
- recall must run even when question does not suggest memory;
- save-only request should not search/fetch;
- `/memory` newest-first;
- delete must not throw.

---

## 5. Architectural decisions

### D1 — Deterministic recall pre-flight
Before the gather loop:
- `countDocuments({userId})`;
- if zero: skip embedding, return `[]`, emit `recall_memory ok:true`;
- otherwise: embed query, recall, emit real trace, record tool call;
- inject recalled memory into gather context;
- keep `recall_memory` registered so the model may call it again.

The pre-flight counts as a real tool call and uses a trace `reason` explaining it.

### D2 — Save-only path
Update `GATHER_SYSTEM_PROMPT` (`llm.ts`) so an explicit record-this request can finish with
`save_memory` alone:
- no `web_search`;
- no `fetch_page`;
- zero sources is valid.
Normal factual questions keep Phase 3's search/fetch behaviour.

**This edits the prompt that BUG-010 fixed — read that entry in `.claude/BUG-AUDIT.md`
first.** BUG-010 added "after a search, fetch_page at least one relevant result before you
consider yourself done" because the model was answering from snippets and emitting zero
sources. The carve-out must be intent-based and narrow, never keyword-based, and must not
weaken the fetch-before-stop rule for questions. Re-run BUG-010's own verification case
("who is Lionel Messi?" → `web_search → fetch_page → sources → token`) after the edit.

### D3 — IDs
Use `newId("mem")`. Never expose Mongo `ObjectId`s.

### D4 — DELETE
Use:

```ts
deleteOne({_id: memoryId, userId})
res.status(204).end()
```

Always `204` after auth, regardless of `deletedCount`. Implausible IDs may be logged but
still return 204.

**Do not "correct" this to `404`.** It is deliberate and counterintuitive; the evidence:
- `SPEC.md:233` declares `204` and nothing else. SPEC §7's status line enumerates
  `404 unknown thread/space/document` — it names three resources and omits memory.
- `web/src/api.ts:62` hard-codes `if (res.status === 204) return undefined` and throws
  `ApiError` on every non-2xx, which `MemoryPanel.tsx:26–31` renders as an error banner.
  `web/` is a red line and cannot be adapted.
- `lib.mjs:59` makes `del()` **throw** on non-2xx; `bench.mjs:788`'s delete sits inside
  `runMemory`'s outer `try`, whose catch calls `cap('memorySaved', false, …)`; and `cap`
  (`bench.mjs:93`) is a plain overwrite. So one `404` rewrites an already-passing
  `memorySaved` to `false` and takes all three memory checks with it.
- `{_id, userId}` + unconditional `204` leaks nothing; a `204`/`404` split is an
  existence-and-ownership oracle.

### D5 — Embeddings
Use `text-embedding-3-small`, 1536 dims.
- missing key/non-2xx → fail clearly;
- no zero-vector fallback;
- validate dimensions;
- no retry/batching/cache;
- bound each embedding request to ~8s and compose with caller abort;
- recall timeout → `ok:false` + error, then continue ask;
- embedding cost enters `RunState.costUsd`;
- embedding tokens stay separate from LLM `done.tokens`.

### D6 — Recall
Primary:

```text
embed
→ $vectorSearch(memories_vector)
→ userId filter INSIDE vector stage
→ top 10
```

If vector returns zero while user has memories, return newest ≤10 as a trace-visible recency fallback.

If `VECTOR_BACKEND=mongo-cosine-scan`, load only that user's memories and cosine-score in Node.

### D7 — Memory context
Inject a separate labelled block before the current user query:

```text
Known stored preferences and facts about this user
(saved explicitly; may be irrelevant):
- ...
```

Cap at ≤10 memories and about 4000 chars. Memory may influence form/style but is never a citation source.

### D8 — Normal saving
`save_memory` stays model-elected for discretionary facts. Tool description: save stable preferences/facts useful later; never auto-harvest answer trivia. All writes use one `saveMemory()` path.

### D8a — Explicit-save backstop
After gather loop but before `sources`, if:
- no successful `save_memory` happened, and
- `isExplicitSaveRequest(query)` is true,

force one `save_memory` extraction turn and execute the real save path.

Requirements:
- real trace;
- record tool call;
- record write result;
- no double-write if normal save already succeeded.

`saveIntent.ts` must be pure/testable and conservative.

Positive examples:
- "remember that I prefer TypeScript";
- "from now on use British English";
- benchmark literal save request.

Negative examples:
- "do people remember the 2008 crash?";
- "what should I remember about RRF?";
- "how do I save a document?"

Tune for false negatives.

### D9 — Failure behaviour

**An empty recall is a SUCCESS, not a failure.** A recall that matches nothing emits
`ok:true` with an empty list. Never `ok:false`. This is graded: `bench.mjs:779` requires
`recalled.some(t => t.ok)`, and the question it recalls against ("capital of Portugal")
may legitimately match no stored preference. `ok:false` is reserved for a recall that
could not run — provider error, timeout, Mongo failure. Same rule as `web_search`
returning zero results: empty ≠ broken (rule A1 is about making failure *distinguishable*
from an empty result, in both directions).

Recall failure: visible `ok:false + error`, then continue normal ask.

Save failure: visible `ok:false + error`, no row stored, final answer must say it was not saved.

Memory failures alone do not become upstream `502`.

### D9a — Final memory-write status
Track:

```ts
state.memoryWrites = [{text, ok, error?}]
```

Both normal and backstop saves update it. Final synthesis receives:

```text
Memory write status:
- SAVED: "..."
```

or:

```text
Memory write status:
- FAILED to save "...": <error>
  State plainly that this was NOT saved.
```

Build this from run state, not model inference. Emit it in `buildFinalSourcesMessage`
(`llm.ts`), next to the source-count note — the position BUG-010 proved effective.

Why a prompt sentence is not enough: the `is_error` tool_result does reach the final turn
(`loop.ts:131–136` → `ask.ts:99`), but it sits thousands of tokens above the "write the
answer now" message, and **D8a's backstop produces no tool_result at all**, so a failed
backstop save would otherwise be invisible to the model.

### D10 — Health
Do not change `/health` shape. If the vector index is not queryable, log a startup warning only.

### D11 — Isolation
Every path scopes by `userId`:

```text
GET      find({userId})
DELETE   deleteOne({_id,userId})
vector   filter userId inside $vectorSearch
cosine   find({userId})
recency  find({userId})
```

Never return `embedding` over HTTP.

---

## 6. Components

### C1 — Embedding client
Files: `backend/agent/src/embed.ts`, optionally `env.ts`.

Implement:

```ts
embed(text, signal?) → {embedding, tokens}
```

Must support configured model, 1536 finite values, provider errors, ~8s timeout, caller abort, no retries.

Done when: real call works; missing key/wrong model/hanging endpoint fail correctly; caller abort works; no hard-coded secret.

### C2 — Memories store
Files: `memories.ts`, `collections.ts`, `run.ts`.

Implement:

```ts
saveMemory(...)
listMemories(...)
deleteMemory(...)
countMemories(...)
recallMemories(...)
```

`saveMemory`: trim → exact-text dedupe per user → embed → `MemoryDoc.parse` → insert.

`listMemories`: user-scoped, no embedding, newest-first, `_id → id`.

`recallMemories`: Atlas vector / cosine fallback / recency fallback.

Done when: round-trip works; `_id` is `mem_...`; dims=1536; no private fields leak; cross-user list/delete blocked; bad dims fail before insert; exact duplicate per user remains one row.

### C3 — Memory tools + pre-flight + save backstop
Files: `tools/memory.ts`, `saveIntent.ts`, `tools/registry.ts`, `loop.ts`, `ask.ts`, `run.ts`.

Register `save_memory` and `recall_memory`. Extend `ToolExecContext` with `userId` and `threadId`.

Ask sequence:

```text
hard-wall check
→ recall pre-flight
→ trace
→ memory context
→ gather loop
→ explicit-save backstop if needed
→ sources
→ final synthesis
```

Trace step numbers must remain strictly increasing.

Done when:
- zero-memory recall succeeds without embedding, emitting `ok:true` + empty list (D9 —
  **never `ok:false`**);
- a recall that runs but matches nothing is also `ok:true`;
- explicit save creates row;
- same user/new thread recalls it;
- different user does not;
- forced-save backstop works;
- negative detector cases do not save;
- broken embedding produces visible recall failure but ask continues;
- failed save is reported as failed.

### C4 — GET /memory
File: `backend/agent/src/index.ts`.

Flow:

```text
requireUserId
→ listMemories
→ ListMemoryResponse.parse
→ 200
```

Done when: fresh user returns `{"memories":[]}`; newest-first; exact fields; no embedding; unauthenticated → 401.

### C5 — DELETE /memory/:memoryId
File: `backend/agent/src/index.ts`.

Flow:

```text
requireUserId
→ deleteMemory({_id,userId})
→ 204
```

Done when: own delete 204; repeat 204; other-user ID 204 but row survives; malformed ID 204 with no deletion; empty body; unauthenticated → 401; deleted memory stops affecting future answers.

### C6 — Gateway
File: `backend/gateway/src/index.ts`.

Add:

```ts
app.get("/memory", proxyToAgent())
app.delete("/memory/:memoryId", proxyToAgent())
```

Done when: gateway/agent behaviours match; auth/rate limit/request-id still work; gateway contains no provider logic/key; SPA fallback does not swallow `/memory`.

### C7 — Prompts + final status
File: `backend/agent/src/llm.ts`.

Implement:
1. save-only carve-out;
2. memory-is-context-not-evidence rule;
3. final memory-write status block.

Benchmark literal save request must produce:

```text
recall_memory
save_memory
NO web_search
NO fetch_page
sources []
short confirmation
no citation
no error
done
```

Normal factual question must still do:

```text
web_search → fetch_page → sources → token
```

This is **BUG-010's regression check** — use its own case ("who is Lionel Messi?") and read
that BUG-AUDIT entry before touching `GATHER_SYSTEM_PROMPT`.

Also verify the 2008-crash question does not save; stored British-English preference affects later answer; memory is never cited; failed save is described as failed.

### C8 — Observability
Files: `run.ts`, `runlog.ts`, `.claude/BUG-AUDIT.md`, `.env.example` only if needed.

Track:
- `embeddingTokens`;
- embedding cost;
- `memoryWrites`.

Done when: cost arithmetic correct; LLM token counters unchanged; `/stats.costUsdToday` reconciles; quality check has no new error-level failure; every failed memory tool has an error.

---

## 7. Verification

### Graded flow

```text
GET /memory → []

thread A
save benchmark preference

expect:
recall_memory ok
save_memory ok
sources []
short confirmation
done
no error

GET /memory → new row

thread B
"What is the capital of Portugal?"

expect:
first trace recall_memory ok
preference returned
answer follows preference
citations only from current retrieval

DELETE memory → 204
DELETE again → 204
GET /memory → absent

thread C
repeat question
→ deleted preference no longer affects answer
```

Run through `:8787`, then direct agent.

### Isolation
Two users must not list/delete/recall each other's memories or affect each other's answers. No response may contain an embedding array.

### Failure injection

| Failure | Expected |
|---|---|
| invalid OpenAI key | recall `ok:false`, ask continues |
| embedding hangs | timeout, recall `ok:false`, ask continues |
| Mongo save failure | save `ok:false`, final says not saved |
| vector unavailable | visible recency fallback |
| LLM failure | Phase 3 error behaviour unchanged |
| malformed delete ID | 204, nothing deleted |

### Regression
Re-check `/threads`, `/stats`, `/health`, thread history, search cache, rate limit, request-id handling, malformed JSON handling.

Still:

```text
mode: docs  → 501
depth: deep → 501
```

Do not register `search_documents` or `plan_research`.

### Graders

```bash
node scripts/create-indexes.mjs --status
node quality/check.mjs .
node benchmark/bench.mjs
```

Confirm:

```text
memorySaved    = true
memoryRecalled = true
memoryDeleted  = true
```

Phase 5+ rows may still fail. Record memory pre-flight TTFT delta.

---

## 8. BUG-AUDIT

Add/update:
- `GAP-010` embedding cost vs separate embedding tokens;
- `GAP-011` deterministic recall pre-flight;
- `GAP-012` pre-flight consumes one quick tool-call slot;
- `GAP-013` unconditional/idempotent memory DELETE 204;
- `GAP-014` vector-index warning without health-shape change;
- `GAP-015` visible recency fallback;
- `GAP-016` existing provider calls lack universal hard deadlines; Phase 8;
- `GAP-017` explicit-save deterministic backstop.

Update `GAP-001` with measured TTFT impact.

---

## 9. Implementation order

```text
C1 embedding
→ C2 memories store
→ C3 tools + recall pre-flight + save backstop
→ C4 GET /memory
→ C5 DELETE /memory
→ C6 gateway
→ C7 prompts/status
→ C8 observability
→ full verification
```

Do not begin Phase 5.

Start at C1.
