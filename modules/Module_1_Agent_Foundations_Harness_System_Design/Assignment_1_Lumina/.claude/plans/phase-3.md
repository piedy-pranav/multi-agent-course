# Phase 3 plan — Persistence + Gateway

Read `.claude/CLAUDE.md` first for project context (the four grading rules, the
non-negotiables, the reference map), and `.claude/BUG-AUDIT.md` for what has already been
fixed and which temporary deviations are still outstanding. This file is the
component-by-component build sequence for Phase 3 only.

```text
Browser → Gateway (:8787) → Agent service (:8000) → Search / LLM / MongoDB Atlas
```

**Goal:** make the system durable and production-like. After this phase the browser never
talks to the agent service again, a conversation survives a restart, a follow-up question
sees the thread it is in, every answer leaves a file the gates can read, and a repeated
search is a cache hit rather than a second provider bill.

---

## Phase 2 recap / current starting point

What already exists, verified, and must keep working:

| Area | State |
|---|---|
| Agent loop | `loop.ts` — one history, tool-use turns, concurrent tool execution per turn, `trace` per call, failed tool → `ok:false` + non-empty `error` fed back as `tool_result`. |
| Budgets | `run.ts` — explicit `RunState`, pure `checkGatherBudget`, `GATHER_FRACTION = 0.7` headroom, `capReason` of `tool_calls \| wall_clock \| tokens`. |
| Final answer | `ask.ts` — `sources` then a pinned text-only final turn (`streamFinalTurn`), grounding guard via `unresolvedCitations`, `done` with real `terminated`/tokens/cost. |
| Tools | `tools/registry.ts` with `toolsForDepth`; `web_search` (tavily/serpapi), `fetch_page`. |
| Run metadata | `runlog.ts` builds and `RunLog.parse()`-validates the record, then **only logs it**. |
| Mongo | `db.ts` — one pooled client, `ignoreUndefined: true` (BUG-001). |
| Threads | `threads.ts` — `createThread`, `getThread` (user-scoped, projected per BUG-002), `appendMessage`. Routes `POST /threads`, `GET /threads/:id`, `POST /threads/:id/ask` live in the agent. |
| Gateway | **Untouched provided skeleton.** It has CORS, request-id generation, the pino request log, a real `/health` that nests the agent's, static hosting of `web/dist`, and a `501` for every other contract route. |

So "MongoDB persistence · threads + messages" is **partly already built** — Phase 1 wrote
threads and messages to Atlas. What is genuinely missing is listed in scope below. Do not
re-build `threads.ts` from scratch.

Known deltas Phase 3 inherits (from `.claude/BUG-AUDIT.md`):

- `GAP-004` — `runs/<requestId>.json` is still not written. Component 5 of Phase 2 shaped
  the record; this phase only has to serialize it.
- `GAP-005` — `searchCached` is hardcoded `false` in `ask.ts:122`. Honest today (no cache
  exists); becomes a lie the moment Component 4 lands.
- `TEMP-001` — `.env` has `VITE_API_URL=http://localhost:8000`. Must go back to `:8787`.
- `TEMP-002` — the CORS shim at `backend/agent/src/index.ts:64–81`. Must be **deleted**, not
  disabled. It is an architectural violation and it is committed.
- `GAP-001` (TTFT) and `GAP-002` (SerpApi path never run) stay deferred — Phase 8.

Also missing and in scope because the provided UI calls it: `GET /threads` (`web/src/api.ts:91`),
which neither service implements.

---

## Scope

**In:**

1. Mongo indexes applied and collection access centralized (`searchCache`, `requests`, `runs`
   join `threads`/`messages`).
2. `GET /threads` (list) with a title that satisfies the contract.
3. Conversation history: the loop is seeded from the thread's prior messages, so a follow-up
   resolves pronouns against the actual conversation.
4. Two-tier search cache — in-process LRU in front of the Mongo `searchCache` TTL collection —
   and an **accurate** `searchCached` in `done`.
5. Run logging and observability: `runs/<requestId>.json` per answer, `runs` + `requests`
   collections, inbound `X-Request-Id` honoured end to end, `/stats`.
6. The gateway for real: `X-User-Id` → `401`, zod validation → `400`, request-id validation,
   a corrected error handler (malformed JSON must be `400`, not the skeleton's `502`), proxy
   to the agent, `502` on upstream failure, unbuffered SSE pass-through for the ask route.
7. Per-user rate limiting → `429`.
8. Undo `TEMP-001` and `TEMP-002`; verify the UI works through `:8787`.

**Out (later phases — do not build):** long-term memory and `GET/DELETE /memory` (Phase 4);
Spaces, upload, GridFS, the jobs worker, `search_documents`, `413` (Phase 5); `mode: auto`
routing (Phase 6); `plan_research`, the `plan` event, `DEEP_DAILY_CAP` enforcement and its
`429 {resetsAt}` (Phase 7); hitting `ttft_p95_ms` / `answer_p95_ms`, the `runs/failing/`
trajectory, deployment, and serving a real `GET /evals/report.json` (Phase 8).

Those routes keep answering `501` from **both** services this phase. That is correct
behaviour, and `bench.mjs` only requires `GET /evals/report.json` to not be `401`.

---

## Architectural decisions to make before coding

### D1 — The gateway proxies; it never re-implements a route

One generic forwarder for every contract route, not thirteen hand-written handlers: copy
method, path, `X-User-Id`, `X-Request-Id`, and body to `${AGENT_URL}${path}`, then copy back
status, content-type and body. Validation and rate limiting are middleware *in front* of it.

Why: `SPEC.md` §7 says "the gateway forwards the same shapes to the AI service", and every
shape is already defined once in `packages/contract`. A gateway that re-derives response
bodies is a second place for the contract to drift. The ask route is the one special case
(streaming, Component 7) — and `POST /spaces/:id/documents` will be the second, in Phase 5.

### D2 — Which service owns which failure code

| Code | Owner | Why |
|---|---|---|
| `401` missing `X-User-Id` | **Both.** Gateway rejects first; the agent keeps its own `requireUserId`. | The agent must not be exploitable if it is ever reachable directly. Defence in depth, explicitly allowed — unlike the deep cap, which must *only* be in the agent. |
| `400` invalid body | **Gateway** (zod from `packages/contract`), agent keeps its `ZodError → 400` handler. | Same reason. `bench.mjs:162` probes `POST /threads/thr_x/ask` with `{}` through the gateway and wants `400` — note it wants `400` *before* the unknown-thread `404`, so validate the body before looking the thread up. |
| `404` unknown id | **Agent** (it owns the data). Gateway passes it through. | The gateway has no database. |
| `429` rate limit | **Gateway.** | `SPEC.md` §6: per-user rate limiting is an edge concern. |
| `429` deep cap | **Agent only** — Phase 7. | A cap on the edge is bypassable (`AGENTS.md:106`). |
| `502` upstream | **Gateway** when the agent is unreachable/throws; **agent** when a provider throws. | Fail loud at the layer that saw the failure. Never a `2xx` over a thrown error. |
| `501` not implemented | Both, for unbuilt routes. | The UI renders it as the progress bar. |

### D3 — `X-Request-Id` is generated at the gateway, *adopted* by the agent, and validated before it touches the filesystem

The gateway skeleton already reuses-or-generates one (`backend/gateway/src/index.ts:34–39`).
It must forward it. The agent currently mints its own with `newId('req')`
(`backend/agent/src/ask.ts:55`); change it to **prefer the inbound header** and only generate
when absent. That single id then names the pino lines in both services, the `runs/<id>.json`
file, and the `requests`/`runs` rows — which is exactly what rubric item `observability`
means by "one `X-Request-Id` correlates a request across gateway and agent pino logs".

**That id becomes a filename**, so it cannot be trusted as it arrives. The contract's
`RequestId` is only `z.string().min(1)` (`packages/contract/src/ids.ts:18`), so the contract
offers no protection: a header of `../../etc/foo` would be a path traversal on the `runs/`
write.

Rule: an id is acceptable only if it matches `^[A-Za-z0-9_-]{1,64}$`.

- **Gateway** — on an unacceptable inbound id, **ignore it and generate a fresh one** (the
  same path the skeleton already takes when the header is absent), log the rejected value
  once, and set the generated id on the response. Do **not** answer `400`: a caller may not
  control that header (a corporate proxy, Fly's router), and failing their request over it is
  punishing the wrong party. Correlation stays exact because nothing downstream ever sees the
  rejected value — the response header, both log streams and the run file all carry the
  generated id.
- **Agent** — adopt the inbound id only if it matches the same regex, else generate with
  `newId('req')`. Same defence-in-depth posture as `401`/`400` in D2: in Phase 3 the agent is
  still bound on `:8000` and must not be exploitable if reached directly.

Keep generation working regardless: `benchmark/lib.mjs:91` **reads** `x-request-id` off the
ask response and `cap('requestIdEchoed')` fails if any answer lacks it. The bench never sends
one.

### D4 — Thread titles: persist a conforming title at create

The conflict:

- `CreateThreadBody.title` is `.optional()` — a thread may be created titleless (and the UI's
  `createThread` sends `{}`, `web/src/api.ts:92`).
- `ListThreadsResponse.threads[].title` is a **required** `z.string()`, and so is
  `ThreadDoc.title` in `packages/contract/src/db.ts:17`.

`ThreadDoc` describes the **stored document**, and today's rows do not satisfy it:
`threads.ts:20` stores `title: undefined`, which `ignoreUndefined` (BUG-001's fix) omits
entirely. So this is not only a listing problem — the persisted row is already
non-conforming. Fixing it at read time would leave that true.

Decision: **persist a conforming title at create.** With no title supplied, store
`title: "New thread"` plus an additive `titleAuto: true`. On the thread's first ask, replace
it with the user's first query (truncated to `CreateThreadBody`'s 200-char ceiling) in one
conditional atomic update:

```ts
threads.updateOne(
  { _id: threadId, userId, titleAuto: true },
  { $set: { title: derived }, $unset: { titleAuto: '' } }
);
```

Why this shape:
- Every row satisfies `ThreadDoc` from the moment it exists.
- The update is naturally idempotent, so concurrent first asks cannot clobber each other —
  one matches and wins, the rest match nothing and no-op. No read-modify-write race.
- Gating on the `titleAuto` flag rather than on the literal string `"New thread"` matters: a
  user may legitimately title a thread that, and matching the sentinel would silently
  overwrite their own title.
- `titleAuto` is additive and safe — no contract schema uses `.strict()`.

`GetThreadResponse.title` is optional, so returning a string there stays valid, and
`ThreadList.tsx:29` renders `t.title || t.threadId`, so an untitled thread reads "New thread"
until its first ask instead of showing a raw id. **Record the tension in
`.claude/BUG-AUDIT.md`** rather than leaving it as an undocumented default.

### D5 — Cache key, and what is *not* cached

Key = `sha256(normalizedQuery + ' ' + provider)`, normalization = trim + collapse
internal whitespace + lowercase. **The query hashed is the `web_search` tool input, not the
user's question** — the model chooses its own search string, and that is what gets cached.
(This is also why a rephrased search on a repeated question is a miss; see watch items.)
Tier 1 is a bounded in-process `Map` LRU; tier 2 is the `searchCache` collection with its TTL
index on `expiresAt`. TTL from `SEARCH_CACHE_TTL_SECONDS` (6 h default).

**Tier-1 bound.** Nothing in the repo declares a capacity — `SPEC.md:105`, `AGENTS.md:73`,
`TECHNICAL.md:126` and `DESIGN.md:17` all say "in-process LRU" and stop, and the only cache
knob in `.env.example` is `SEARCH_CACHE_TTL_SECONDS`. So declare one: `SEARCH_CACHE_LRU_MAX`,
default **500** entries (the bench's entire distinct workload is 20 queries —
`benchmark/queries.json` — so 500 is generous and still bounded). Adding an env var with a
documented default follows the `MAX_TOKENS_TOTAL` precedent set in Phase 2. Exact behaviour:

- a **hit moves the entry to MRU** (delete then re-set — a JS `Map` preserves insertion
  order, so that is the whole implementation; no dependency needed);
- **insertion past capacity evicts the LRU entry** (the first key from `map.keys()`);
- an entry **past its `expiresAt` is deleted and counted as a miss** — not a hit, not an
  error.

**Single-flight is deliberately out of scope.** Concurrent identical searches could each miss
both tiers and call the provider, but that cannot happen in the graded workload:
`buildWorkload` (`bench.mjs:252–259`) emits the 20 distinct queries first — `queries.json`
holds exactly 20, so there are no duplicates *within* the fresh block — then appends the 20
repeats, and `pool(tasks, 4)` consumes the array in order, so by the time repeat *i* starts,
fresh *i* finished roughly 16 tasks earlier. No two concurrent bench tasks ever share a cache
key. It also would not address the real threat to the cache gate (watch items). Recorded so a
later phase does not re-litigate it.

Two rules that are easy to get wrong:

- **Check `expiresAt` in code as well as relying on the index.** Mongo's TTL sweeper runs
  roughly once a minute (`scripts/indexes.json`, `searchCache` note), so an expired row can
  still be returned by a `findOne`.
- **Only `web_search` results are cached. Never answers, never fetched pages.** `SPEC.md:66`:
  "No answer caching… answers are always regenerated so freshness is never served stale."
  `fetch_page` output is deliberately left uncached this phase — it is the biggest thing in
  the context and caching it would mean serving stale page text behind a fresh citation.
- The "time-sensitive queries bypass the cache" row in `SPEC.md:108` is a **Should**, not a
  Must. Implement it only if Component 4 lands cheaply; it is not a gate.

### D6 — Conversation history: send prior turns, not prior evidence

Seed the gather loop's history with the thread's previous user/assistant message **text**
only — never the old `tool_result` blocks or the old fetched page text. Cap it (last ~6
messages, each truncated). Reason: `max_cost_per_answer_usd` is $0.05 and a Phase 1 single
answer already sat at $0.039 (BUG-AUDIT GAP note / Phase 2 watch items). Replaying old page
text into every follow-up is the fastest way to blow that gate.

**The cap is load-bearing, not a nicety.** `benchmark/bench.mjs:275–277` creates **one**
thread and runs its entire 40-query web workload in it. Without a cap, ask #40 would carry 39
unrelated prior turns: a cost blowout against the $0.05 gate, a latency cost on a TTFT target
that is already 5× over (GAP-001), and a real chance the model answers a neighbouring
question instead of this one. Cap by message count *and* per-message length.

**Read the history before persisting the current message.** `index.ts:162` appends the user
message *before* `handleQuickAsk` runs, and `getThread` sorts by `createdAt` alone
(`threads.ts:36`) — two writes in the same millisecond have no deterministic order, so
"load N+1 and drop the last row" is unsafe. Instead, fetch the prior turns in `index.ts`
*before* `appendMessage`, and pass that snapshot into `handleQuickAsk`. A snapshot taken
before the write provably cannot contain the current message, with no boundary logic and no
reliance on sort ties.

Hard rule this creates: prior-turn sources are **history, not evidence**. `sources` for this
answer is still built only from `state.evidence` gathered in *this* request (grounded or
nothing). If the model cites a fact it learned from the conversation, it must re-retrieve it
or not cite it — the existing grounding guard already enforces this, so expect it to start
tripping on follow-ups and treat that as the guard working.

---

## Component sequence

Agent-side first (each testable with `curl -N` against `:8000`), gateway second, the UI
through the gateway last. That order means nothing is blocked on the proxy existing.

### Component 1 — Indexes and collection access

- **Files:** `backend/agent/src/db.ts` (modified). Possibly a small `collections.ts`.
- **Behavior:** run `node scripts/create-indexes.mjs` (provided, safe to re-run) so
  `threads`, `messages`, `searchCache` (TTL), `requests` and `runs` have the indexes from
  `scripts/indexes.json`. Add typed accessors so collection names come from the contract's
  `COLLECTIONS` constant rather than string literals scattered across files (`threads.ts`
  currently hardcodes `'threads'`/`'messages'`).
- **Contract/spec:** `COLLECTIONS` and the document schemas in `packages/contract/src/db.ts`;
  index definitions in `scripts/indexes.json`; `SPEC.md` §8. `runs.requestId` is a **unique**
  index — a second write for the same request must not be attempted blindly.
- **Failure cases:** vector/search indexes may report `building` (`--status`); harmless this
  phase, nothing here queries them. An M0 cluster allows exactly 3 search indexes — do not
  add a fourth.
- **Done when:** `node scripts/create-indexes.mjs --status` lists the TTL index on
  `searchCache.expiresAt` and the unique index on `runs.requestId`, and `/health` still
  reports `db: "ok"`.

### Component 2 — `GET /threads`

- **Files:** `backend/agent/src/threads.ts`, `backend/agent/src/index.ts`.
- **Behavior:** list the calling user's threads, newest first, as
  `{ threads: [{ threadId, title, createdAt }] }`. Titles come from the stored row per
  **D4** — `createThread` writes `"New thread"` + `titleAuto: true` when none was supplied,
  and the first ask swaps in the derived title via the conditional atomic update. This
  component does not synthesize a title at read time.
- **Contract/spec:** `ListThreadsResponse`; index `{userId: 1, createdAt: -1}`; `createdAt`
  must be an ISO-8601 `z.string().datetime()` — `threads.ts` already stores ISO strings, keep
  it that way and do not let a `Date` object reach the response.
- **Failure cases:** cross-user leakage — the query must filter by `userId`, like `getThread`
  already does; `_id` must be projected into `threadId`, never leaked raw (BUG-002's lesson);
  `titleAuto` is internal and must not reach the response body; a missing title must not emit
  `null` (BUG-001's lesson) — after D4 there should be no missing titles at all.
- **Done when:** `curl -s :8000/threads -H 'x-user-id: dev' | jq` validates against
  `ListThreadsResponse.parse`, a second user's id returns `{threads: []}`, no `_id`, `userId`,
  `titleAuto` or `null` appears in the body, and a thread's title changes from `"New thread"`
  to its first query after one ask and then **stays put** across later asks.

### Component 3 — Conversation history for follow-ups

- **Files:** `backend/agent/src/loop.ts` (history seed), `backend/agent/src/ask.ts` (fetch
  prior messages and pass them in), `backend/agent/src/threads.ts` (a read that returns the
  last N messages).
- **Behavior:** in `index.ts`, read the thread's prior user/assistant text turns **before**
  `appendMessage` writes the current one, then pass that snapshot into `handleQuickAsk`, which
  prepends it to the gather loop's history per **D6**. Ordering, not filtering, is what makes
  the current message impossible to double-send.
- **Contract/spec:** `SPEC.md` §5.3 "thread history in `threads`+`messages`"; `TECHNICAL.md`
  Part 1 step 3 "follow-ups see the thread". No wire-format change: the SSE contract is
  untouched.
- **Two small conformance fixes to make while in here** (both cheap, both prerequisites for
  deterministic ordering):
  - `messages` rows currently get a driver-assigned `ObjectId`, but `MessageDoc._id` is a
    required `z.string()` (`packages/contract/src/db.ts:23`). `newId()` has no `'msg'` prefix
    in its union (`ids.ts:28`), so this needs a small local id helper. BUG-002's `_id: 0`
    projection is why this has never leaked into a response.
  - Sort history reads by `{createdAt: 1, _id: 1}` so the ordering is total rather than
    ambiguous within a millisecond.
- **Failure cases:** duplicated current question (prevented structurally by the read-first
  ordering, not by a filter); unbounded context growth blowing `max_cost_per_answer_usd` —
  acute because the bench runs 40 asks in one thread (D6); replaying stale `tool_result`/page
  text (forbidden by D6); a follow-up citing a prior answer's sources, which the grounding
  guard will correctly reject.
- **Done when:** in one thread, ask "Who founded Tavily?" then "When was it founded?" — the
  second answer resolves "it" without the pronoun being in the query, its `trace` shows a
  fresh retrieval, every `[n]` resolves, and `done.costUsd` for the follow-up is still under
  $0.05.

### Component 4 — Two-tier search cache and honest `searchCached`

- **Files:** new `backend/agent/src/cache/searchCache.ts`; `backend/agent/src/tools/webSearch.ts`
  (wrap, do not rewrite the provider calls); `backend/agent/src/run.ts` (track hits/misses);
  `backend/agent/src/ask.ts` (report it).
- **Behavior:** `web_search` consults LRU → Mongo → provider, and writes through to both on a
  miss. Record per-search hit/miss on `RunState`.
- **Contract/spec:** `SearchCacheDoc` in `packages/contract/src/db.ts:89` is the stored
  shape — `_id` = the sha256, plus `provider`, `query`, `results[]`, `expiresAt`, `createdAt`.
  `DoneEvent.searchCached` is **"true only when EVERY search in the request was a cache
  hit"** (`sse.ts:156`). A run with **zero** searches is not "every search hit" — report
  `false`, since `searchCached: true` with no retrieval would read as a cached answer.
- **The threshold has zero margin — know this before building.**
  `min_search_cache_hit_rate_pct: 50`, and `bench.mjs:848` computes
  `cacheHits / webDone.length * 100` over **all 40** web answers, of which exactly 20 are
  repeats. So *every single repeat* must report `searchCached: true` to reach 50.0%. Combined
  with "every search in the request must hit", one repeat where the model rephrases its search
  string or issues one extra search drops the run below the gate. Phase 3 cannot fully solve
  this (it is Phase 8's number), but build the cache so it does not make it worse: key off the
  normalized tool input (D5), and do not add anything that varies the search string per run.
- **Failure cases:** normalization mismatch (`"What is Tavily?"` vs `"what is tavily?"`) →
  silent 0% hit rate; provider not in the key → a `SEARCH_PROVIDER` swap serving Tavily rows
  as SerpApi results; expired-but-unswept rows (D5); a cache read failure swallowing a real
  provider error — a Mongo failure here must degrade to a provider call and a log line, never
  to an empty result list (rule A1: a failure you cannot tell from an empty result is the
  Live Translate bug).
- **Done when:** the same query asked twice shows `searchCached: false` then `true` in `done`;
  `db.searchCache.findOne()` holds a row whose `_id` matches
  `sha256(normalized + \0 + provider)`; a restart still serves the Mongo tier (LRU cold, hit
  anyway); and **GAP-005 is closed** — `ask.ts` no longer hardcodes `false`.

### Component 5 — Run logs, `requests`/`runs` rows, and `/stats`

- **Files:** `backend/agent/src/runlog.ts` (write the file + the rows),
  `backend/agent/src/ask.ts` (pass the inbound request id, ttft, searchCached),
  `backend/agent/src/index.ts` (adopt `X-Request-Id`, add `GET /stats`).
- **Behavior:** two separate concerns, deliberately not coupled.
  - **Per request (every route, not just asks):** one `requests` row (`RequestDoc`), written
    by **agent-side** middleware on response finish (`res.on('finish')`), capturing
    `requestId, userId, route, status, ms, createdAt`. On an ask, enrich the same row with
    `tokensIn, tokensOut, costUsd, toolCalls, terminated, depth` plus the additive `ttftMs`
    and `searchCached`.
  - **Per answer:** write `runs/<effectiveRequestId>.json` in the `RunLog` shape and upsert
    the same record plus identifiers into the `runs` collection (`RunDoc`).
  - Implement `GET /stats` from those two collections.
- **Why `requests` covers every route, and why the agent writes it.** Three pieces of
  evidence, so this is settled rather than assumed:
  - Every ask-specific field on `RequestDoc` — `tokensIn`, `tokensOut`, `costUsd`,
    `toolCalls`, `terminated`, `depth` — is `.optional()` (`packages/contract/src/db.ts:122–135`),
    while `route`, `status` and `ms` are required. A collection meant only for asks would not
    be shaped that way.
  - `SPEC.md:301`'s gateway log line is `method, route, status, ms, request_id, user_id` —
    the same required fields, one per request.
  - `SPEC.md` §7's example has `requests: 412` against `answers: 130`, a ratio that only makes
    sense if non-ask traffic counts.

  It is written in the **agent**, not the gateway, because `backend/gateway/package.json` has
  no `mongodb` dependency and must not acquire one — the gateway owning persistent state
  would contradict D1 and `DESIGN.md` Q2. Since the gateway proxies every route, the agent
  sees every request that gets through.
- **The one honest boundary to document:** requests the gateway rejects itself — `401`, `400`,
  `429`, and a `502` raised because the agent was unreachable — never reach the agent, so they
  produce no `requests` row. They appear in the gateway's pino log only. `/stats.requests` is
  therefore "requests the agent service handled", which is the widest count the architecture
  permits without giving the gateway a database. State this in the handler's comment so the
  number is not mistaken for total edge traffic.
- **Contract/spec:** `RunLog` / `RunDoc` / `RequestDoc` / `StatsResponse`. `env.runsDir` is
  already created at boot (`index.ts:89`) and `runs/` is git-ignored. `RunLog.tokens` is a
  single **total**, not the `{in,out}` split `done` carries. `quality/check.mjs` reads only
  top-level `runs/*.json`, which is why a broken run belongs in `runs/failing/` — Phase 8.
  `/stats` must reconcile with the log to within 1% (`bench.mjs:813`, rubric `observability`).
- **Two gaps between `StatsResponse` and the stored schemas — flagging, not silently choosing:**
  - `ttftP95Ms` has no home: neither `RequestDoc`, `RunDoc` nor `RunLog` declares a ttft
    field. The zod objects are not `.strict()`, so storing an extra `ttftMs` on the
    `requests` row is additive and parses fine. **Do that**, and note it — using
    `RequestDoc.ms` as a stand-in would report latency as first-token time, which is a
    dishonest number.
    `searchCacheHitRatePct` has the same shape of gap; store `searchCached` on the row the
    same way.
  - `deepToday` / `deepDailyCap`: `deepToday` is per-user (see the table), `deepDailyCap`
    comes from `env.deepDailyCap`. The **cap enforcement** is Phase 7; only the reporting is
    here, and today it reports zero because deep is still `501`.

**`/stats` semantics — settle these before writing the handler.** The scoping is not a free
choice: `bench.mjs:809–813` computes `ours` from **every** answer in the run, including those
produced under the `bench-deep-*`, `bench-mem-*` and `bench-deepcap-*` ids (lines 521, 690,
737), then fetches `/stats` as plain `bench` and asserts `stats.answers >= ours`. A per-user
`answers` count would fall below `ours` and `statsReconciles` would fail.

| Field | Semantics | Why |
|---|---|---|
| `requests` | **Global**, all time: count of `requests` rows — one per HTTP request **the agent service handled**, every route, not only asks. Gateway-rejected requests (`401`/`400`/`429`, or a `502` when the agent was down) are not included; they live in the gateway log | `RequestDoc`'s ask fields are all optional while `route`/`status`/`ms` are required (`db.ts:122–135`); `SPEC.md:301`; the §7 example's `requests: 412` vs `answers: 130` |
| `answers` | **Global**, all time: answers that reached a `done` event (`terminated` ∈ `done \| cap`) | `bench.mjs:810` — must not be narrower than all users. An errored stream never sent `done`, so it is not an answer |
| `ttftP95Ms` | **Today (UTC)**, global: p95 of the stored `ttftMs` | No window declared anywhere; today is the only one that stays meaningful as the deployment improves. Not gated by the bench (it measures TTFT client-side), so this is a documented interpretation — label it as such |
| `searchCacheHitRatePct` | **Today (UTC)**, global. Denominator = answers that ran **≥1 search**; numerator = those with `searchCached: true`. Zero-search answers excluded from **both** | `bench.mjs:79–83`: the rate is a property of the searching workload — "anything else averaged in here is a number about something else". The bench never cross-checks this field against `/stats` |
| `costUsdToday` | **Today (UTC)**, global: sum of `costUsd` over today's runs | Rubric `observability`: must reconcile with the agent log within 1% |
| `deepToday` | **Per calling `X-User-Id`**, today | `TECHNICAL.md` troubleshooting: "`DEEP_DAILY_CAP` is per `X-User-Id`; the bench uses its own ids. Check `/stats.deepToday`"; SPEC scenario D ("four deep searches left today") |
| `deepDailyCap` | `env.deepDailyCap` | — |

Two riders: "today" means **UTC** explicitly — a local-time boundary drifts between a laptop
and a Fly region — and every field is computed from the persisted collections, never from
in-process counters, because the 1% reconciliation has to survive a restart.

- **Run-log persistence is best-effort, after delivery.** State the invariant rather than
  redesigning it: delivery of a correct answer is never blocked on observability
  persistence. The writes happen **after** `done`/`res.end()`, and a failure is a loud
  `log.error` naming the requestId. Three things make that defensible rather than negligent —
  BUG-006 already settled exactly this trade-off (a provider exception fails loud; a storage
  failure after a delivered answer is a server-side problem to log);
  `mkdirSync(env.runsDir, …)` at `index.ts:89` means an unwritable directory fails at
  **boot**, not silently per answer; and `scripts/export-runs.mjs` exists precisely to
  regenerate `runs/<requestId>.json` from the `runs` collection.
- **Mongo is the durable record; the file is a recoverable projection of it.** That ordering
  is the repo's own design — `scripts/export-runs.mjs` reads the `runs` collection and writes
  the files, never the reverse. So write the Mongo `runs` row **first**, then the file.
- **The post-response writes must not block each other.** Give each its **own** `try/catch` —
  the assistant-message append (already isolated per BUG-006), the `runs` upsert, the
  `requests` row, and the `runs/<id>.json` file are four independent failures, not one
  transaction:
  - a failed file write must **not** prevent the `runs`/`requests` writes (and because Mongo
    is the durable record, a file lost this way is recoverable with `npm run export:runs`);
  - a failed `runs` upsert must not prevent the `requests` row, and vice versa;
  - a failed message append must not prevent any of the observability writes.

  Each `catch` logs at `error` level with the `requestId` and which write failed, so one
  broken sink is greppable and does not silently take the other three with it. Do **not**
  wrap them in a single `try` or chain them with `await` inside one block — that is exactly
  how one failure swallows three records.
- **Failure cases:** writing the file inside the main `try` would resurrect BUG-006; a
  duplicate `runs.requestId` (unique index) must be an upsert, not a crash; an unvalidated
  inbound `X-Request-Id` must never reach the `runs/` path (**D3**); `/stats` on an empty
  database must return zeros, not `NaN` (p95 of nothing); a failed tool call in the file must
  carry a non-empty `error` or `RunLog.parse` rejects it (it already does).
- **Done when:** one ask leaves exactly one `runs/<id>.json` whose filename equals the
  **effective** `X-Request-Id` — the one returned to the caller in the response header, which
  is the inbound id when it was acceptable and the gateway-generated replacement when it was
  not (**D3**); that same ask leaves one `runs` row and one `requests` row carrying the same
  id; `node quality/check.mjs .` reads the file and reports no error-severity failure;
  `GET /stats` validates against `StatsResponse.parse`; deliberately making the `runs/`
  directory unwritable still leaves the Mongo rows intact and logs one `error` line naming the
  requestId; and **GAP-004 is closed**.

### Component 6 — Gateway: auth, validation, request id, proxy, `502`

- **Files:** `backend/gateway/src/index.ts`; new `backend/gateway/src/proxy.ts`; new
  `backend/gateway/src/validate.ts`.
- **Behavior:** middleware order, and it is **not** the skeleton's current order:

  ```text
  request id (validate per D3) → pino → X-User-Id (401) → rate limit (429)
    → body parse (400 on malformed JSON) → zod validate (400) → proxy (D1)
  ```

  Auth **before** body parse: authentication precedes interpreting a payload, and it makes
  both combinations unambiguous — no `X-User-Id` + malformed JSON → `401`; valid
  `X-User-Id` + malformed JSON → `400`. Rate limit before parse is deliberate too, so an
  abusive client's malformed bodies still consume quota. The skeleton currently parses at
  `index.ts:55–59`, before any auth; move it, and **keep its guard excluding the multipart
  `POST …/documents` route** — Phase 5 needs that.

  Replace the `501` loop only for the routes the agent actually implements; leave the rest
  `501`.
- **Fix a live bug in the provided skeleton while here.** `express.json` throws a
  `SyntaxError` carrying `status: 400` on malformed JSON, but the error handler at
  `backend/gateway/src/index.ts:122–125` maps **every** `Error` to `502` — a status the
  contract reserves for upstream provider failure. The handler must honour
  `err.status`/`err.statusCode` for 4xx and fall through to `502` only for genuinely unknown
  errors. The bench does not catch this (its `{}` probe at `bench.mjs:162` is *valid* JSON
  that fails `AskBody`), which is exactly why it would have shipped silently. Note also that
  `express.json({limit: '1mb'})` emits `413` on an oversized body — harmless, since
  `AskBody.query` caps at 2000 chars, but the contract reserves `413` for uploads, so give it
  a distinguishable message.
- **Contract/spec:** `USER_HEADER` / `REQUEST_HEADER` / `ROUTES` / `ErrorBody` /
  `CreateThreadBody` / `AskBody` from `packages/contract`. `/health` and
  `/evals/report.json` are the only routes with no `X-User-Id` requirement
  (`ROUTES[].auth`, and `bench.mjs:169`). `ErrorBody` wants `{error, status?, requestId?}` —
  include `requestId` on every error so a user's complaint is greppable.
- **Failure cases:** validating with `AskBody.parse` **mutates** the body via its `.default()`s
  (`mode: 'auto'`, `depth: 'quick'`) — forward the parsed object, so the agent sees the same
  defaults the gateway validated, and so `mode` is never undefined downstream; agent
  unreachable → `502` with a message, never a `200`; a `fetch` with no timeout hanging the
  gateway forever; accidentally reading a provider key in this process (red line — there are
  none in `gateway/src/env.ts` and there must stay none); `express.json` swallowing the
  multipart upload route (the skeleton already guards this — keep the guard for Phase 5).
- **Done when:** through `:8787`, `POST /threads` → `201`, `GET /threads/thr_nope` → `404`,
  `GET /memory` with no `X-User-Id` → `401`, `POST /threads/thr_x/ask` with `{}` → `400`,
  **malformed JSON with a valid `X-User-Id` → `400` (not `502`)**, **malformed JSON with no
  `X-User-Id` → `401`**, `GET /evals/report.json` with no header → not `401`, agent stopped →
  `502` (not `200`, not a hang), a hostile `x-request-id: ../../foo` is replaced by a
  generated id and writes no file outside `runs/`, and the same `X-Request-Id` appears in both
  services' pino lines for one request.

### Component 7 — SSE pass-through for the ask route

- **Files:** `backend/gateway/src/index.ts`, `backend/gateway/src/sse.ts` (provided helper —
  it is in `backend/gateway/`, so it is yours to use/extend).
- **Behavior:** `POST /threads/:id/ask` is forwarded as a stream: pipe the agent's response
  body straight to the client, byte for byte, with no buffering and no re-serialization.
  Copy the agent's status code through (`200` for a stream, but `404`/`501`/`502` arrive as
  JSON and must stay that way).
- **Contract/spec:** `sseHeaders()` already sets the four headers that matter
  (`text/event-stream`, `no-cache, no-transform`, `keep-alive`, `X-Accel-Buffering: no`) and
  flushes. **No `compression()` in front of this route** (`SPEC.md:202`, `TECHNICAL.md`
  troubleshooting). Event order `trace* → sources → token* → done` must survive the hop
  unchanged, with `sources` before the first `token`.
- **Failure cases:** buffering — all tokens landing at once at the end, which reads as "the
  model is slow" and will later fail `ttft_p95_ms` for a reason no profiler shows; parsing and
  re-emitting frames (a chunk boundary can split one `data:` line, so byte-piping is both
  simpler and more correct); a client disconnect not aborting the upstream request, which
  re-opens BUG-005's wasted spend one layer up — wire an `AbortController` to the client
  response's `close`; an error *after* headers are sent cannot become a status code, so it has
  to surface as an `error` SSE frame (the agent already does this; the gateway must not
  swallow it).
- **`X-Request-Id` must survive onto the streamed response.** `benchmark/lib.mjs:91` reads it
  off the ask response's headers and `cap('requestIdEchoed')` fails if any answer lacks it.
  The skeleton sets it in middleware (`index.ts:37`) and exposes it through CORS
  (`exposedHeaders`), so the risk is clobbering it when piping — do not write a fresh header
  set that drops it, and verify with `curl -D-`.
- **Done when:** `curl -N` through `:8787` shows the same event sequence and the same
  incremental timing as `:8000` (tokens arriving progressively, not in one burst), the first
  `event: sources` precedes the first `event: token`, `curl -D- …/ask` shows an
  `x-request-id` response header, and killing the curl mid-stream leaves both services
  healthy on `/health`.

### Component 8 — Per-user rate limiting → `429`

- **Files:** new `backend/gateway/src/rateLimit.ts`, wired in `index.ts`.
- **Behavior:** a per-`X-User-Id` sliding/fixed window at `env.rateLimitPerMinute`
  (already read, default 30; `RATE_LIMIT_PER_MINUTE` in `.env.example`). Over limit →
  `429` with an `ErrorBody`. In-process state is fine — this is an edge concern and the
  non-authoritative-state call in `DESIGN.md` covers it.
- **Contract/spec:** `SPEC.md` §6 puts rate limiting on the gateway; `ErrorBody.resetsAt` is
  described as the **image/deep** cap's field, so it is optional here — include it anyway,
  since a `429` with no reset time tells a client to stop and gives it no way to know when to
  resume (`bench.mjs:706` makes exactly that argument about the deep cap).
- **Failure cases (read this one carefully):** `benchmark/sla.json` runs
  `web_queries: 40` at `concurrency: 4` under a **single** `user_id: "bench"`, and
  `max_error_rate_pct` is `1.0`. A 30/min per-user limit can therefore rate-limit the
  benchmark itself and book the `429`s as errors. The fix is **not** to raise the limit to
  pass a gate — it is to keep the limit configurable via `RATE_LIMIT_PER_MINUTE` and set it
  appropriately for a bench run, and to document the production default. Decide and record
  this before Phase 8 measures it. Also: `/health` must stay unlimited (it is a liveness
  probe), and a missing `X-User-Id` must `401` before the limiter ever buckets it.
- **Done when:** a loop of `rateLimitPerMinute + 2` cheap requests from one user id returns
  `429` on the overflow with a parseable `ErrorBody`, a *different* `x-user-id` is unaffected
  in the same window, and `/health` never `429`s.

### Component 9 — Undo the temporary deviations

- **Files:** `.env` (`VITE_API_URL`), `backend/agent/src/index.ts` (delete the banner-marked
  block at lines 64–81), `.claude/BUG-AUDIT.md`.
- **Behavior:** `VITE_API_URL=http://localhost:8787`; the agent's CORS shim **deleted**
  entirely. The gateway's `cors()` is now the only CORS in the system, and the agent service
  stops being browser-reachable.
- **Contract/spec:** `AGENTS.md:18` assigns CORS to the gateway; `AGENTS.md:44` — "the browser
  talks ONLY to the gateway". Leaving the shim is an architectural violation and a widened
  attack surface on the process that holds the provider keys.
- **Failure cases:** doing this before Components 6–7 work breaks the UI completely — it is
  deliberately last; a stale Vite dev server caching the old `VITE_API_URL` (restart it, do
  not debug the proxy); CORS now failing for real if the deployed origin is missing from
  `CORS_ORIGINS`.
- **Done when:** `grep -rn "Access-Control-Allow-Origin" backend/agent/` returns nothing, the
  UI at `:5173` asks a question end to end through `:8787`, and a browser request straight to
  `:8000` is blocked by the missing CORS headers.

---

## Whole-phase verification

```bash
# 0. indexes, then both services up; /health nests the agent's
node scripts/create-indexes.mjs --status
npm run dev
curl -sf localhost:8000/health | jq && curl -sf localhost:8787/health | jq '.ai.status'

# 1. contract probes THROUGH the gateway (the four bench.mjs checks)
curl -s -o /dev/null -w '401 want 401 → %{http_code}\n' localhost:8787/memory
curl -s -o /dev/null -w '404 want 404 → %{http_code}\n' localhost:8787/threads/thr_nope -H 'x-user-id: dev'
curl -s -o /dev/null -w '400 want 400 → %{http_code}\n' -X POST localhost:8787/threads/thr_x/ask \
  -H 'x-user-id: dev' -H 'content-type: application/json' -d '{}'
curl -s -o /dev/null -w 'evals must not be 401 → %{http_code}\n' localhost:8787/evals/report.json
# malformed JSON: 400 with a user id, 401 without one — never 502
curl -s -o /dev/null -w 'bad json + auth want 400 → %{http_code}\n' -X POST localhost:8787/threads \
  -H 'x-user-id: dev' -H 'content-type: application/json' -d '{"title":'
curl -s -o /dev/null -w 'bad json, no auth want 401 → %{http_code}\n' -X POST localhost:8787/threads \
  -H 'content-type: application/json' -d '{"title":'

# 2. full stream through the gateway, sources before tokens, incremental timing
T=$(curl -s -X POST localhost:8787/threads -H 'x-user-id: dev' | jq -r .threadId)
curl -N -X POST localhost:8787/threads/$T/ask -H 'x-user-id: dev' -H 'x-request-id: req_manual_1' \
  -H 'content-type: application/json' -d '{"query":"What is Tavily?","mode":"web"}'

# 3. persistence + list + follow-up in the same thread
curl -s localhost:8787/threads/$T -H 'x-user-id: dev' | jq '.messages | length'   # >= 2
curl -s localhost:8787/threads -H 'x-user-id: dev' | jq   # titled from first query, newest first
# a brand-new thread lists as "New thread" BEFORE its first ask, and no titleAuto leaks
curl -s -X POST localhost:8787/threads -H 'x-user-id: dev' -H 'content-type: application/json' -d '{}' \
  && curl -s localhost:8787/threads -H 'x-user-id: dev' | jq '.threads[0]'
curl -N -X POST localhost:8787/threads/$T/ask -H 'x-user-id: dev' \
  -H 'content-type: application/json' -d '{"query":"Who founded it?","mode":"web"}'

# 4. cache: same query twice → searchCached false then true
# 5. request id + run log: the file is named by the EFFECTIVE id (the one echoed back in the
#    x-request-id response header) — here the inbound one, since it is acceptable
ls runs/req_manual_1.json && jq . runs/req_manual_1.json
# and that id appears in both services' logs. A hostile id must NOT escape runs/:
curl -s -o /dev/null -X POST localhost:8787/threads/$T/ask -H 'x-user-id: dev' \
  -H 'x-request-id: ../../pwned' -H 'content-type: application/json' -d '{"query":"hi","mode":"web"}'
ls ../../pwned.json 2>/dev/null && echo "FAIL: path traversal" || echo "no traversal"
# every answer left a run file (the gate's input)
ls runs/*.json | wc -l

# 6. rate limit: overflow one user, leave another alone
for i in $(seq 1 32); do curl -s -o /dev/null -w '%{http_code} ' localhost:8787/threads -X POST \
  -H 'x-user-id: ratetest' -H 'content-type: application/json' -d '{}'; done; echo

# 7. fail loud: stop the agent, ask again → 502, never 200
# 8. gates
node quality/check.mjs .
curl -s localhost:8787/stats -H 'x-user-id: dev' | jq

# 9. hygiene
git status --porcelain | grep -E '\.env$|node_modules|^runs/|^reports/' && echo FAIL || echo clean
grep -rn "Access-Control-Allow-Origin" backend/agent/ && echo "FAIL: TEMP-002 still present" || echo "TEMP-002 gone"
npm run typecheck && npm run lint
```

Then: test through the UI (ask, follow up, switch threads, watch the stream), commit, move to
Phase 4.

`node benchmark/bench.mjs` is **not** a Phase 3 exit gate — it exercises memory, RAG and deep
search, which are Phases 4, 5 and 7. Expect it to fail on those rows. Reading its contract and
cache rows is still useful.

---

## Watch items / risks

- **Rate limit vs. the bench (Component 8).** The single most likely way to pass this phase
  and fail Phase 8: the bench's own 40-query workload tripping a 30/min per-user limit and
  counting the `429`s against a 1% error-rate ceiling. Decide the posture now, in writing.
- **Buffering is invisible until it is fatal.** An SSE pass-through that buffers still looks
  correct in `curl` output — the frames all arrive, just at the end. Compare *timing* against
  `:8000`, not just the event list.
- **The cache gate has no margin.** 20 repeats out of 40 web answers against a `>= 50`
  threshold means every repeat must report `searchCached: true`, and `searchCached` is
  all-or-nothing per request. The realistic failure is not a cache bug: it is the model
  **rephrasing its search string** on the repeated question, or adding one extra search, so
  the key misses. Phase 8 owns the number, but Phase 3 should not make it worse, and the
  likely Phase 8 fix (instruct the final/gather prompt to search with the user's own phrasing
  first) is worth noting now.
- **The bench runs 40 asks in ONE thread** (`bench.mjs:275–277`), so conversation history is
  the component most likely to blow up cost, latency and answer relevance at once. D6's cap
  is what stands between a correct Phase 3 and a failed Phase 8 cost gate.
- **Follow-ups will push cost toward the $0.05 gate.** Conversation history plus a tool loop
  that re-sends its own history means context grows twice over. Keep D6's truncation tight and
  watch `done.costUsd` on the *second* and *third* turns of a thread, not just the first.
- **The grounding guard will start tripping on follow-ups.** That is correct behaviour (prior
  sources are history, not evidence). Fix the prompt so the final turn only cites this
  request's sources; do not weaken the guard.
- **`searchCached` honesty.** The moment the cache lands, a hardcoded `false` becomes a lie and
  `true` on a zero-search run becomes a worse one. It is `true` only when there was at least
  one search and every one of them hit.
- **Mongo as the cache's second tier is not authoritative** (`DESIGN.md` Q4). A cache read or
  write failure must degrade to a provider call plus a log line, never to an empty result and
  never to a `502`.
- **Don't let the gateway grow a brain.** Every piece of research logic, every provider key,
  and the future deep cap belong in the agent. The gateway that starts deciding things is the
  architecture violation this phase exists to remove, not to relocate.
- **GAP-001 (TTFT ~5× the 2500 ms target) and GAP-002 (SerpApi never exercised) stay open.**
  Phase 3 adds a network hop, so TTFT gets marginally worse. Still Phase 8's problem.
- **`mode` is `web`-only and `depth: deep` is still `501`.** The gateway validates with
  `AskBody`, which happily accepts `auto`/`docs`/`deep`; the agent is what rejects them. Keep
  it that way — the gateway must not start making routing decisions (D2).
- **`mode: "auto"` is silently treated as web, and the bench defaults to it.**
  `benchmark/lib.mjs:78` sends `mode: 'auto'` whenever a caller omits it, and `index.ts:147`
  rejects only `'docs'` — so `auto` falls through to the quick web path with no `501` and
  nothing in the trace recording that a routing decision was skipped. Harmless until Phase 6
  owns routing, but log it as a known gap now rather than rediscovering it as a mystery then.

---

## BUG-AUDIT entries this phase resolves

| ID | Resolution |
|---|---|
| `GAP-004` | Closed by **Component 5** — `runs/<requestId>.json` written per answer, plus the `runs`/`requests` rows. |
| `GAP-005` | Closed by **Component 4** — `searchCached` reports real per-request hit/miss. |
| `TEMP-001` | Closed by **Component 9** — `VITE_API_URL` back to `http://localhost:8787`. |
| `TEMP-002` | Closed by **Component 9** — the agent's CORS shim deleted; the gateway owns CORS. |

Still open after Phase 3: `GAP-001` (TTFT, Phase 8), `GAP-002` (SerpApi path, before
submission), `SEC-001`'s outstanding action (rotate the Atlas password).

New entries to **add** to `.claude/BUG-AUDIT.md` during this phase:

- **`BUG-007`** — the gateway skeleton's error handler maps malformed JSON (`SyntaxError`,
  `status: 400`) to `502`, a status the contract reserves for upstream provider failure. Found
  by reading `index.ts:122–125` against `express.json`'s behaviour, not by any test — the
  bench's only body probe is valid JSON (**Component 6**).
- **`SEC-003`** — a caller-supplied `X-Request-Id` became a filename for `runs/<id>.json`
  with no validation; `RequestId` in the contract is only `z.string().min(1)`. Resolved by
  the regex + regenerate-on-invalid rule in **D3**.
- The `CreateThreadBody.title` optional vs. `ThreadDoc`/`ListThreadsResponse.title` required
  conflict, that existing rows did not satisfy `ThreadDoc`, and the persist-at-create +
  `titleAuto` resolution (**D4**).
- `MessageDoc._id` is a required `z.string()` but rows carried driver `ObjectId`s, and
  `newId()` has no `'msg'` prefix (**Component 3**).
- `StatsResponse.ttftP95Ms` / `searchCacheHitRatePct` having no declared home in `RequestDoc`
  or `RunDoc`, the additive extra fields chosen instead, and the global-vs-per-user scoping
  forced by `bench.mjs:809–813` (**Component 5**).
- Whatever is decided about the rate limit vs. the bench workload (**Component 8**).
- **`GAP-006`** — `mode: "auto"` is silently served as web; the bench defaults to it. Deferred
  to Phase 6.
- **`GAP-007`** — the search-cache gate has zero margin (20 repeats / 40 answers against
  `>= 50`), so it turns on the model reusing its own search string. Deferred to Phase 8.
