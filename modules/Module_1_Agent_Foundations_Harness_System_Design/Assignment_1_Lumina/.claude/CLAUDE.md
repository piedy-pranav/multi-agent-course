# CLAUDE.md — LUMINA build guide

This file is the condensed, phase-ordered map of this project's six source docs
(`README.md`, `PRD.md`, `TECHNICAL.md`, `SPEC.md`, `AGENTS.md`, `DESIGN.md`). Read it first
in any new conversation about building LUMINA. When this summary and a source doc disagree,
the source doc wins — especially `SPEC.md` and `packages/contract/`, and especially any
number, which lives only in `benchmark/sla.json`, `expectations.json`, `eval/rubric.json`.

## What LUMINA is

A Perplexity-style AI search engine: ask a question, get a streamed, cited answer built from
live web search and/or your own uploaded documents. It remembers facts across sessions. A
harder question triggers **Deep** mode: plan sub-questions, research each, merge citations.

**Two gears:** `Quick` (default, one pass, seconds) and `Deep` (opt-in only, plans
sub-questions, ~7x cost, up to a minute). The server **never** upgrades a request to deep on
its own.

## What's provided vs. what you build

| | |
|---|---|
| ✅ Provided — do not edit | `web/` (React UI), `packages/contract/` (zod schemas = the wire contract), `benchmark/`, `eval/`, `quality/`, `scripts/`. Editing these is a red line and is checked. |
| 🔨 You build | `backend/gateway/` — the edge (CORS, `X-User-Id`, request ids, pino logs, zod validation, rate limits, SSE pass-through, serves `web/dist`). No provider keys here. |
| 🔨 You build | `backend/agent/` — the work (agent loop, tools, memory, RAG, deep search, jobs worker, run logs). Provider keys live **only** here. |

Architecture is fixed: `Browser → Gateway (:8787) → Agent service (:8000) → Search/LLM/MongoDB Atlas`.
One MongoDB Atlas cluster holds everything, vectors included (Atlas Vector Search).

## The four rules that decide the grade (from PRD.md)

1. **Grounded or nothing.** Every `[n]` in an answer must resolve to something actually
   retrieved *in that request*. A bad citation is an automatic fail, regardless of whether the
   claim is true. Empty retrieval → say so, cite nothing. Never invent a URL/page/doc.
2. **Fail loud.** A provider exception → `502` + `terminated: "error"`. Never a
   `try/catch` that returns a plausible-looking answer. (Precedent: a past cohort's service
   silently served English translations for weeks after a dependency broke its translator.)
3. **Bounded and honest.** Per-gear caps on tool calls/wall-clock. Hitting a cap →
   `terminated: "cap"` with an honest partial answer — never reported as if it finished clean.
4. **Evidence over vibes.** Every graded number comes from a real run against the deployed
   app via `benchmark/bench.mjs` / `quality/check.mjs` / `eval/eval.mjs`. Thresholds are
   declared up front in `sla.json` / `expectations.json` / `rubric.json`.

## DESIGN.md (already answered in this repo)

Five questions, already written at `DESIGN.md` — refer back to it, don't re-litigate it
without reason:
1. **Components** — browser client, public gateway, private agent service, MongoDB Atlas,
   external LLM/search providers, ingestion worker.
2. **Responsibilities** — browser never touches secrets/DB/providers directly; gateway owns
   browser-facing concerns only (no provider keys, no research decisions); agent service is
   the only thing holding provider secrets and making retrieval/LLM decisions, including the
   deep-search spend cap (enforced next to the spend); worker owns long-running ingestion.
3. **Communication** — HTTP+SSE browser↔gateway, unbuffered SSE pass-through gateway↔agent,
   async job queue (not request/response) for ingestion, failures surface as 4xx/429/502 and
   `trace` events with `ok:false`, never silently retried.
4. **State** — MongoDB Atlas is authoritative (threads, messages, memories, documents, chunks,
   jobs, usage/caps); search cache (LRU + Mongo TTL) is non-authoritative and disposable;
   vector indexing is eventually consistent — a document is `indexed` only after a
   read-your-write probe.
5. **Trade-offs** — two services instead of one (secrets isolation vs. extra hop); MongoDB for
   everything instead of Redis/queue/dedicated vector DB (simplicity vs. polling + eventual
   consistency); SSE instead of WebSockets (simpler, matches the one-request-many-events
   shape); one orchestrator for deep search instead of multi-agent fan-out (cheaper, easier to
   trace, less parallelism). Least certain: Mongo-as-job-queue at larger scale.

## Hard non-negotiables (from AGENTS.md / SPEC.md — do not relax)

- Contract shapes/status codes match `packages/contract/` **exactly**: `401` no `X-User-Id`,
  `404` unknown id, `413` file too large, `429` rate limit/deep cap, `501` not implemented,
  `502` upstream failure.
- `POST /threads/{id}/ask` streams `trace → sources → token → done` (`plan` first on deep,
  before any retrieval). `sources` before the first `token`, always.
- Tools: `web_search`, `fetch_page`, `search_documents`, `recall_memory`, `save_memory`, and
  (deep only) `plan_research`. A quick run must never be able to reach `plan_research` —
  filter the toolset by depth before the first model call.
- Caps: quick = 8 tool calls / 90s; deep = 24 tool calls / 240s.
- Every answer writes `runs/<requestId>.json` (tokens, wallClockSec, costUsd, terminated,
  depth, ordered toolCalls). Keep a deliberately-broken run in `runs/failing/`, not `runs/`.
- Search: `SEARCH_PROVIDER=tavily|serpapi` swappable via env; two-tier cache (in-process LRU +
  Mongo `searchCache` TTL collection), key = SHA-256(normalized query, provider).
- Memory: thread history in `threads`+`messages`; long-term memory only via explicit
  `save_memory`; `GET /memory` lists everything remembered — nothing remembered that this
  endpoint doesn't show; `DELETE /memory/{id}` removes it; recall is semantic (Atlas Vector
  Search filtered by `userId`).
- RAG: upload → `202` in <300ms → GridFS + `pending` doc + `jobs` row → worker parses/chunks/
  embeds/indexes. Never synchronous parse-then-respond. One `chunks` collection, one vector
  index, `spaceId` filter **inside** `$vectorSearch` (not a later `$match`). `indexed` only
  after a read-your-write probe. Chunk locators: `{page}` for PDF, `{heading}`/`{line}` for text.
- Deep search: `plan` event with 3–6 sub-questions + reasons, before any retrieval. Every
  `trace`/`source` tagged with its `subQuestion`. Merge into one contiguous citation numbering
  (dedupe by url/docId+locator). Must retrieve ≥2× the distinct sources of the same question
  run quick. `DEEP_DAILY_CAP` (default 5) per `X-User-Id`, enforced in the **agent service**
  (never the gateway — that'd be bypassable).
- Observability: pino JSON logs both services; `X-Request-Id` reused/generated at gateway,
  forwarded, logged in both; `/health` names model/search-provider/vector-backend/Mongo status;
  `/stats` reconciles with logs.
- Hygiene: secrets from `.env` only, server-side, never bundled to the browser or returned by
  any endpoint. `.env`, `node_modules/`, `web/dist/`, `runs/`, `reports/` git-ignored.

## Reference material map

| Need | Go to |
|---|---|
| Wire format, exact schemas | `packages/contract/src/` (`sse.ts`, `http.ts` first) |
| Every requirement, status code, failure mode, unabridged | `SPEC.md` |
| Build guide: architecture, commands, checklists, troubleshooting | `TECHNICAL.md` |
| Thresholds (the only authority on numbers) | `benchmark/sla.json`, `expectations.json`, `eval/rubric.json` |
| Non-negotiables for a coding agent | `AGENTS.md` |
| Human product framing, no numbers | `PRD.md` |
| Already-answered 5-question design doc | `DESIGN.md` |
| Bugs fixed, temporary deviations still outstanding, known gaps | `.claude/BUG-AUDIT.md` |
| The step-by-step plan for the phase you are on | `.claude/plans/phase-N.md` |

**Read `.claude/BUG-AUDIT.md` before changing backend code.** It records why files differ from
the provided skeleton, and tracks two temporary deviations (`TEMP-001`, `TEMP-002`) that must
be undone in Phase 3 — including a CORS shim in the agent service that is an architectural
violation if left in.

---

## Build phases

Drive the build in this order. For **every phase**: implement the smallest vertical slice →
test independently (`curl -N`, no browser needed) → test through the API → test through the
UI → run the relevant grader/tests → commit → move to the next phase.

```text
Implement smallest vertical slice
        ↓
Test independently
        ↓
Test through API
        ↓
Test through UI
        ↓
Run relevant grader/tests
        ↓
Commit
        ↓
Move to next phase
```

### Phase 1 — MVP: Quick Web Search
Smallest end-to-end working search flow.
```text
User question → web search → fetch source pages → LLM synthesis → cited answer → SSE stream to UI
```
Build: `POST /threads` + basic thread handling · `POST /threads/:id/ask` · `web_search` tool ·
`fetch_page` tool · LLM integration · SSE events `trace → sources → token → done` · grounded
citations tied to fetched URLs · basic error handling.
**Goal:** ask a question from the UI, get a streamed, cited web answer.

### Phase 2 — Agent Loop + Budgets
Turn the fixed pipeline into a real tool-using agent.
```text
LLM → choose tool → execute → observe → repeat → answer
```
Build: explicit agent state · tool calling · search/fetch decision-making · tool-call limits ·
iteration/token/time budgets · termination reasons · trace events · run metadata.
**Goal:** the agent decides what it needs instead of following a hard-coded workflow.

### Phase 3 — Persistence + Gateway
Make the system durable and production-like.
Build: MongoDB persistence · threads + messages · conversation history for follow-ups ·
gateway proxy · `X-User-Id` · request IDs · zod validation · rate limiting · SSE pass-through ·
proper `4xx/429/502` behavior · run logging/observability · search cache (memory LRU + Mongo TTL).
**Goal:** conversations persist; requests reliably flow `UI → Gateway → Agent`.

### Phase 4 — Long-Term Memory
Build: `save_memory` · `recall_memory` · memory embeddings · vector similarity retrieval ·
`GET /memory` · `DELETE /memory/:id` · strict user isolation.
**Goal:** the agent deliberately remembers and retrieves user information across threads.

### Phase 5 — Spaces + Document RAG
Add private-document search.
```text
Upload → GridFS → ingestion job → worker → parse → chunk → embed → vector index → retrieve → cite
```
Build: Spaces · document upload · async ingestion jobs · worker · PDF parsing · chunking ·
embeddings · Atlas Vector Search · `search_documents` · document citations with page/location ·
ingestion status lifecycle.
**Goal:** ask questions about uploaded PDFs, get grounded document citations.

### Phase 6 — Retrieval Routing
Unify web and document retrieval. Support `mode = web | docs | auto`.
Build: explicit routing · auto source selection · web + document tool availability · space
scoping · retrieval isolation · mixed evidence handling where appropriate.
**Goal:** the agent chooses the correct knowledge source based on the question.

### Phase 7 — Deep Research
Build Deep mode using existing primitives.
```text
Question → research plan → 3–6 subquestions → parallel/sequential research → merge evidence → deduplicate sources → final synthesis
```
Build: `plan_research` · stream `plan` before retrieval · subquestion execution · shared
research budgets · source deduplication · unified citation numbering · deep-specific
limits/termination · ensure Quick mode never invokes Deep planning.
**Goal:** multi-step research answers, not single-pass search answers.

### Phase 8 — Hardening + Benchmarking
Make everything pass the assignment requirements.
Build/test: citation provenance · sources-before-tokens invariant · latency/TTFT · concurrent
requests · search during document ingestion · worker crash/retry behavior · provider failure
handling · cache behavior · user/Space isolation · budget enforcement · grading harness ·
deployment configuration.
**Goal:** turn the working prototype into a system that reliably passes the spec and grader.

---

## Submission (after Phase 8)

One Vercel URL. `/` works for a stranger, `/evals` renders the eval your run produced. Run
`/fde-lumina-eval --deploy-url https://<your-gateway>` in Claude Code to produce `report.json`.
No repo, no zip, no code submitted. Full flow: `TECHNICAL.md#submit`, course-wide rules:
`../../../SUBMISSION.md`.
