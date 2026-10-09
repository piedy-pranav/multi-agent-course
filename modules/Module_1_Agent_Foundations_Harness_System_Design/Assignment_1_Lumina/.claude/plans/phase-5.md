# Phase 5 — Spaces + Document RAG

Read first: `.claude/CLAUDE.md`, `.claude/BUG-AUDIT.md`, `SPEC.md` §5.4, `AGENTS.md`,
`packages/contract/src/{db,http,sse}.ts`, `scripts/indexes.json`, `benchmark/sla.json`,
`expectations.json`, `.claude/plans/phase-4.md`.

Goal: `upload → GridFS → pending doc + job → worker → parse → chunk → embed → probe →
indexed → search_documents → grounded doc citations`, plus an explicit `mode:"docs"` ask path.

Protected, do not edit: `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`,
`scripts/`. Nothing here needs to.

**Reviewed against the repo 2026-10-08.** Items marked **⚠** are what a fast pass gets wrong;
each costs a graded number. They are D4, D8, D10, D15, D16, D17a, D17b, D19 and §2.

---

## 1. Do not regress Phases 1–4

Agent loop · quick budgets · SSE order `trace* → sources → token* → done` · grounding guard ·
threads/history · search cache · memory · run logging · `/stats` · gateway
auth/validation/rate-limit/SSE proxy · request-id correlation.

Reuse: `collections.ts`, `embed.ts`, the vector-backend pattern, user-scoped retrieval,
fail-loud tool semantics, the memory pre-flight pattern (D17a).

Deferred: `mode:auto` (Phase 6), deep search (Phase 7), TTFT/cost, provider deadlines,
deployment (Phase 8).

---

## 2. Contract

```ts
POST /spaces   {name:string(1..120)}        → 201 {spaceId,name}
GET  /spaces                                → 200 {spaces:[{spaceId,name,createdAt}]}
POST /spaces/:spaceId/documents  multipart  → 202 {docId,status:"pending"}
GET  /spaces/:spaceId/documents             → 200 {documents:[{docId,title,status,pct,pages?,chunks?,error?}]}
```

All need `X-User-Id` (already central via the gateway's `ROUTES[].auth`). MIME list and size
cap come from `ACCEPTED_UPLOAD_TYPES` / `MAX_UPLOAD_BYTES` (`contract/src/http.ts:121-126`) —
never retyped. Status: `pending → parsing → embedding → indexed | failed`. Collections
`spaces`/`documents`/`chunks`/`jobs`; GridFS bucket `GRIDFS_BUCKETS.uploads`.

**⚠ `DocumentDoc` required fields** (`contract/src/db.ts:57-73`) — a missing one fails `.parse`:
`{_id:DocId, spaceId, userId, title, mimeType, bytes, status, pct, fileId, createdAt, pages?,
chunks?, error?}`.

- `title` = **original upload filename**. `bench.mjs:404-407` stem-matches it against the gold
  set's `doc` field; a PDF's internal title loses the recall hit.
- `fileId` = GridFS id as a **string** (`.toHexString()`).
- `pages` is `.positive()` — omit for md/txt, never `0`.

Indexes already exist in `scripts/indexes.json` (verified): `chunks_vector` = vector on
`embedding` + filters `spaceId` **and** `userId`; `chunks_text` = `dynamic:false`,
`text`→string, `spaceId`/`userId`→**token**.

---

## 3. Phase 5 / 6 boundary

```text
mode:"web"   unchanged
mode:"docs"  document-only retrieval, spaceId required   ← build this
mode:"auto"  unchanged / known incomplete (GAP-007)      ← Phase 6
```

Do **not** build a classifier/router, auto source selection, mixed web+docs, or router trace
reasoning.

Cost of deferring, precisely: `bench.mjs:440-462` runs exactly one `mode:'auto'` ask and fails
`cap('routerPicksDocs')`. `M.requests++` sits *after* it (`:449`), so it does **not** enter
`errorRate`. Expected damage: one failed cap row. Anything else moving means something
unplanned changed.

---

## 4. Decisions

**D1 — Isolation.** `spaces/documents/chunks` carry `{userId, spaceId}`; every query scopes by
**both** (Space lookup, document list, upload verification, both retrieval halves). Unknown and
foreign Space both `404` with an **identical** body — differing bodies make the route an
ownership oracle (same reasoning as GAP-013).

**D2 — Upload is async.** `auth → verify Space → validate → GridFS → pending DocumentDoc →
pending JobDoc → 202`. No parse/chunk/embed/wait/retrieve in the request. Target
`accept_202_p95_ms <= 300`. A failed durable accept is never a fake `202`.

**D3 — Multipart is an edge concern.** Gateway: auth, rate limit, request id, pass-through,
upstream error relay. Agent: GridFS, metadata, jobs, ingestion. No provider keys or PDF
parsing in the gateway.

The `express.json()` carve-out **already exists** — do not re-add it
(`agent/src/index.ts:128-132`, `gateway/src/index.ts:94-98`); the static catch-all already
excludes `/spaces` (`:181`).

**The upload cannot reuse `proxyToAgent()`** — it forces `content-type: application/json`,
sends `JSON.stringify(req.body ?? {})` (`{}`, since nothing parsed it) and caps at 15 s
(`gateway/src/proxy.ts:25-33`). Write `proxyUpload()`: body = raw `req` stream,
`duplex:'half'` (undici throws without it), inbound `content-type` copied **verbatim**
(boundary included), generous timeout, and relay the **upstream status** — the agent answers
`413` before draining the body, so a naive version sees a socket error and reports `502`,
failing the `413` check.

**D4 — Upload validation. ⚠**
```text
unsupported MIME → 400   missing file → 400   >25 MB → 413
unknown/foreign Space → 404   valid → 202
```
Don't trust the extension alone. `multer@^2` is **already a dependency** — use it, don't add
another: `multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } })`.
Map **at the route**: `MulterError LIMIT_FILE_SIZE → 413`; no file part or MIME outside the
list → `400`. A multer error reaching the agent's final handler becomes `502`
(`agent/src/index.ts:303-312`), so a too-large file would answer `502`, not `413`.

**D5 — Mongo job queue.**
```ts
JobDoc { kind:"index_document", status:"pending", payload:{docId,spaceId,fileId,…},
         userId, attempts:0, createdAt }
```
Atomic claim: `findOneAndUpdate({status:'pending'}, {$set:{status:'running',claimedAt,workerId}, $inc:{attempts:1}}, {sort:{createdAt:1}, returnDocument:'after'})`.
One owner per job; a sweeper requeues stale `running` rows (`JOB_STALE_AFTER_SECONDS`).

`JobDoc._id` is a plain `z.string()` and `newId()` has no `'job'` prefix
(`contract/src/ids.ts:28`) — mint a local `newJobId()`, as BUG-008 did with `newMessageId()`;
never let the driver assign an `ObjectId`.

`JOB_MAX_ATTEMPTS` bounds retries: past it, terminally `failed` with its error (D18). A corrupt
PDF fails deterministically, and a sweeper with no ceiling retries it forever.

**D6 — Worker isolation.** Separate process: `npm run worker`. **Scripts and file already
exist** — `agent/package.json` has `"worker": "tsx watch src/worker.ts"`, the root delegates,
and `agent/src/worker.ts` is a skeleton that logs and `exit(1)`s with the claim snippet in its
header. Build it out; don't create a new file. No heavy parsing/embedding on the API event
loop. Note `tsx watch` restarts on edit, which looks exactly like a crash — useful for
verification D, not a mystery.

**D7 — Truthful lifecycle.** `pending pct=0` → `parsing` → `embedding` (chunk/embed/persist,
update pct) → `indexed pct=100` **only after the D12 probe** → or `failed` with a non-empty
error. Never `indexed` after `insertMany()` alone.

**D8 — Parsing + locators. ⚠**

**No two chunks of one document may share a locator.** `bench.mjs:200-202` keys a chunk by
`` `${docId}:${page}:${heading}:${line}` `` and says so: *"two chunks of one document must not
share a key."* `bench.mjs:416-417` builds the grounding haystack as `Map(locatorKey →
snippet)`, so a duplicate key **overwrites**; `scoreGrounding` then checks source A's snippet
against source B's text and counts it **not grounded** — against `min_citation_grounding: 0.95`
and a named red line. Chunking a dense page at ~1 000 chars collides by default.

`Locator` allows any combination (`contract/src/sse.ts:96-104`) and the recall check reads
**only** `locator.page` for page-matched items (`bench.mjs:409`), so a sub-page discriminator
is free:

```ts
PDF → {page:N, line:startLineWithinPage}   Markdown → {heading:"…", line:startLine}
Text → {line:startLine}
```

Never a bare `{page}` or `{heading}` unless the chunker provably emits one chunk per
page/heading. Assert in C7: `new Set(chunks.map(locatorKey)).size === chunks.length`.

**PDF** — use the legacy build (the default entry assumes a browser):
```ts
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
getDocument({ data, useWorkerFetch:false, isEvalSupported:false, disableFontFace:true })
```
Pages are **1-based** (`getPage(i)`, `i` in `1..numPages`); gold pages are 1-based physical
pages, so an off-by-one fails 26 of the 30 measured items at once. Never merge two pages into
one chunk. Set `DocumentDoc.pages = numPages`. No usable text → document + job `failed` with
error.

**D9 — Config, not magic numbers.**
```text
DOC_CHUNK_TARGET_CHARS  DOC_CHUNK_OVERLAP_CHARS  DOC_EMBED_BATCH_SIZE
DOC_VECTOR_TOP_K  DOC_TEXT_TOP_K  DOC_RRF_K  DOC_FINAL_TOP_K
JOB_STALE_AFTER_SECONDS  JOB_POLL_INTERVAL_MS  JOB_MAX_ATTEMPTS
```
Two have floors: `DOC_CHUNK_TARGET_CHARS` ≈ 800–1 200 (the whole chunk becomes the snippet,
D16) and `DOC_FINAL_TOP_K` **≥ 5** (`bench.mjs:399` slices emitted doc sources to 5). Score
thresholds are config too — one that drops the set below 5 costs recall directly. Tune against
the gold corpus, not one PDF. Document new knobs in `.env.example`.

**D10 — Chunk persistence + retry idempotency. ⚠**
```ts
ChunkDoc { _id:string, docId, spaceId, userId, text, locator, ord, embedding:number[1536], createdAt? }
```
`ChunkDoc.parse` before insert; never expose `embedding` over HTTP; locators unique per D8.

Retry safety is **two** things:
```text
1. deterministic _id: `${docId}:${ord}`
2. deleteMany({docId,userId}) at the START of the embedding stage, before the first insert
```
The id alone is not enough: a retry that re-chunks into *fewer* chunks leaves the previous
attempt's higher-`ord` rows in the vector index, poisoning retrieval. Nothing in the DB stops
it — `chunks`' `{docId:1, ord:1}` is **non-unique**.

Order: `deleteMany → insert → DocumentDoc.chunks = inserted count → probe → indexed`.

**D11 — Reuse Phase 4 embeddings.** Reuse `embed.ts`; no second OpenAI implementation. Same
model, 1536 dims, same timeout/failure behaviour. Batching is fine. Ingestion embedding cost is
**not** answer `RunState.costUsd` — log it in worker logs; invent no HTTP shape.

**D12 — Read-your-write probe.** After insert: pick a known new chunk → query `chunks_vector`
with `spaceId` + `userId` filters **inside** `$vectorSearch` → confirm the hit belongs to this
doc. Only then `indexed`, `pct=100`, job `done`. Bounded retry/backoff for index lag; no
reparse/re-embed between retries; permanent failure → document + job `failed` with error.

**The probe must not apply C9's `indexed`-only filter** — at probe time the document is still
`embedding` by construction. Query by `docId` directly as its own query, not by calling the
retrieval function, or no document can ever reach `indexed`.

**D13 — Hybrid retrieval.**

*Dense:* `$vectorSearch` on `chunks_vector`, `spaceId` **and** `userId` filters **inside** the
stage — never a later `$match`.

*Sparse:* `chunks_text` maps `spaceId`/`userId` as **`token`**, so the scoping operator is
`equals`, not `text`. A `text` operator on a `token` path matches **nothing**, returns empty
with no error, and RRF silently degrades to dense-only:
```text
$search: index chunks_text, compound:
  filter: [ equals{path:'spaceId',value}, equals{path:'userId',value} ]
  must:   [ text{path:'text', query} ]
```
Because an empty sparse half is invisible, **assert it** (verification K): a non-zero BM25 hit
count against the indexed gold corpus. Until that number is seen, "hybrid" is unproven.

*Fusion:* RRF, `score = 1/(RRF_K+vectorRank) + 1/(RRF_K+textRank)`, dedupe by chunk `_id`,
return `DOC_FINAL_TOP_K`.

*Rerank:* SPEC §5.4 allows RRF plus rerank **or** a documented reason for skipping. Start
without an LLM rerank, document it (GAP-020), add it only if recall@5 needs it — tune
deterministic retrieval before buying cost and latency.

**D14 — Local fallback.** `VECTOR_BACKEND=mongo-cosine-scan`: exact-scan already-scoped chunks.
If Atlas text search is unavailable locally, use an explicitly labelled dev-only lexical
fallback — do **not** call it BM25. The graded path uses Atlas indexes; `/health` names what is
live.

**D15 — `search_documents` scope. ⚠**

Model input `{query:string}`. Tenancy via `ToolExecContext` (`tools/registry.ts:11-18`, already
carries `userId`/`signal`) — add `spaceId`. The model never chooses a Space id. Result may
carry chunk text, `docId`, `title`, `locator`, retrieval metadata — **never embeddings**.
Legitimate empty → `ok:true, results:[]`; infra failure → `ok:false` + error.

**The toolset filter must become mode-aware.** `toolsForDepth(depth)` filters **only** by depth
(`registry.ts:81-87`), so adding `search_documents` to `REGISTRY` hands it to every quick run —
including `mode:'web'` (the bench's whole 40-query workload) and `mode:'auto'` (the UI default,
`Composer.tsx:19`, the case this phase defers). With no `spaceId` in context it throws:
`ok:false` trace steps on ordinary web asks, burning one of quick's 8 tool-call slots (already
7 in practice — GAP-012).

Widen the filter, not the registry:
```text
toolsFor({ depth, mode, hasSpace })
  search_documents        only when a valid Space was resolved for THIS request
  web_search, fetch_page  excluded when mode === 'docs'
  plan_research           unchanged: deep only (R2)
```
Structural, before the first model call — the guarantee R2 relies on, for the same reason.

**D16 — Document evidence. ⚠** `Source {n, kind:"doc", docId, title, locator, snippet}`.

*`snippet` is the whole `ChunkDoc.text`, not a slice.* Do not copy the web path's
`e.text.slice(0, 400)` (`ask.ts:99`): the anchor-matched gold items (g27–g30 of the measured
30, the two `.md` files) are decided by `snippetIsGrounded(item.anchor, s.snippet, 6)`
(`bench.mjs:410`) — the anchor must be **inside the emitted snippet**, and past char 400 the
item is silently lost. For doc citations the snippet is also the entire grounding haystack
(`bench.mjs:416-417`). Hence D9's upper bound on chunk size.

*`sources` carries the full fused top-k, in rank order, numbered from 1 — cited or not.*
`bench.mjs:398-399`: *"The `sources` event IS the retrieval surface: top-5 of it is what
recall@5 means here."* Emitting only cited chunks turns recall@5 into a measure of the model's
citation appetite and collapses it. Safe for grounding: `scoreGrounding` iterates only the
`[n]` present in the text (`:235`), and `ask.ts`'s grounding guard is one-directional —
dangling citations fail, unused sources don't.

Grounding chain: `[n]` → emitted source → source snippet → chunk retrieved **in this request**.
Never cite raw GridFS, an unindexed chunk, a guessed page, or a chunk this request didn't
retrieve.

**D17 — Explicit docs path.** `mode:"docs"` + `spaceId`. Missing `spaceId` → `400`;
unknown/foreign → `404`; valid → document retrieval only (web tools excluded structurally by
D15). Keep memory tools as the architecture has them. `mode:auto` stays Phase 6.

**D17a — Docs retrieval is deterministic, not model-elected. ⚠**

Run `search_documents` **once, deterministically, before the first model call** on a
`mode:'docs'` ask, with the user's query verbatim — same shape as `loop.ts#runMemoryPreflight`,
reusing its `startStep` trace bookkeeping. Emit its trace step; turn its results into this
request's evidence. The tool stays registered so the model may re-query with better terms.

Why not model-elected:
- `expectations.json` declares `minRetrievalRate: 1.0`, and `bench.mjs:840-843` requires
  **every** completed answer's trace to contain `web_search` or `search_documents`. In docs
  mode `web_search` is gone, so one model turn that answers directly misses the gate — gate 4
  blocks.
- The same ask must surface ≥1 doc source in its top 5, 30 times over.
- `callAgentTurn` uses `tool_choice:{type:'auto'}` — nothing compels a call.
- **Settled precedent:** GAP-011 records Phase 4 doing exactly this for `recall_memory`,
  because `bench.mjs:779` demands that trace step on a question giving the model no reason to
  call it.

Cost it honestly: it takes one quick tool-call slot (GAP-012's reasoning unchanged) and is real
work. Record it as a gap; do not exempt it from the budget.

**D17b — The synthesis path assumes web. ⚠** Two places in `llm.ts` are wrong for docs mode and
will otherwise return "no supporting document evidence" on every gold question:

1. `GATHER_SYSTEM_PROMPT` says *"the final answer can only cite a page you actually fetched
   with fetch_page … after a search, fetch_page at least one of the most relevant results."*
   That text **is** the BUG-010 fix and must stand for web mode; in docs mode there is no
   `fetch_page`. Make the prompt mode-aware: a retrieved chunk **is** citable evidence, no
   fetch required or possible.
2. `FinalSource` (`llm.ts:165-168`) requires `url: string`, and `buildFinalSourcesMessage`
   renders `` `[${s.n}] ${s.title} (${s.url})` `` (`:202`). A doc source has no url. Make `url`
   optional, add `docId`/`locator`, render a doc source as `filename, p. N` (SPEC §5.4's own
   wording).

Do not touch the web-mode wording of either prompt — BUG-010 is a fixed defect.

**D18 — Worker failures are inspectable.** Terminal failure → `JobDoc.status='failed'` +
non-empty `error`, and `DocumentDoc.status='failed'` + non-empty `error`. Log `jobId, docId,
spaceId, userId, workerId, stage, attempt, ms, error`. Never raw document bodies or secrets.

**D19 — Raise the gateway rate limit. ⚠**

The current default breaks the RAG gate before any retrieval code is wrong.
`gateway/src/rateLimit.ts` is a per-user fixed window of `env.rateLimitPerMinute` over 60 s,
default **30** (`gateway/src/env.ts:20`, `.env.example`); only `/health` is exempt. But
`bench.mjs:332-339` polls `GET /spaces/:id/documents` every 1 200 ms (≈**50/min**) for up to
240 s per file across 4 files, and `web/src/components/SpacesPanel.tsx:42-47` polls every
1 500 ms (≈**40/min**) while anything is pending. Both exceed 30/min on polling alone.

The failure is not soft: `client.get` throws on the `429` → `uploadAndWait` throws → the file
is recorded not-indexed → `cap('indexedViaWorker')` fails and `M.recall.asked` stays 0 →
`recallAt5` is `null`, and `assertSla`'s `row()` treats a null actual as **fail**
(`bench.mjs:921-923`). Recall@5 fails without ever being measured, and the UI errors mid-ingest.

**Change:** default `RATE_LIMIT_PER_MINUTE` to **120**, reason noted in `.env.example`. Bench
phases are sequential (`:973-978`), so the real peak is RAG polling plus one-at-a-time gold
asks, ≈60–70/min. Keep the `429` path, `resetsAt`, the `/health` exemption and GAP-009's
verification exactly as they are. No number in `sla.json`/`SPEC.md`/`AGENTS.md`/`TECHNICAL.md`
declares 30 — this re-picks an undeclared Phase 3 default against newly-known load, it does not
loosen a gate. **Rejected:** exempting `GET …/documents` — it is a real route a client can
hammer, and carving a hole in the limiter to pass a poll loop leaves a worse system behind.

---

## 5. Components

| # | Build | Files | Done when |
|---|---|---|---|
| **C1** | `createSpace/listSpaces/getSpace` + both `/spaces` routes | `collections.ts`, `spaces.ts`, `index.ts` | create `201`; list user-scoped; ISO `createdAt`; exact contract fields; no internal leaks |
| **C2** | Upload → verify Space → validate → GridFS → pending doc + job → `202` | `documents.ts`, `uploads.ts`, `index.ts` | 3 MIME types ok; bad type `400`; >25 MB `413`; foreign Space `404`; bytes in GridFS; exactly one document + one job row; zero parsing in-request. Roll back an orphan GridFS file if metadata fails; never a pending document with no job |
| **C3** | `listDocuments(userId,spaceId)` + route | `documents.ts`, `index.ts` | fresh Space `[]`; doc visible; lifecycle visible; no `fileId/userId/_id` leak; unknown/foreign `404` |
| **C4** | Gateway wiring for all four routes + `proxyUpload` (D3) | `gateway/src/index.ts`, `proxy.ts` | all four work through `:8787`; boundary preserved; `202/400/404/413/502` relayed |
| **C5** | `enqueueIndexJob/claimNextJob/markDone/markFailed/requeueStaleJobs` + worker loop | `jobs.ts`, `worker.ts` | atomic single claim; `attempts` increments; killing the worker leaves a stale `running` row; sweeper requeues; failed job has an error; retry duplicates nothing |
| **C6** | Parsers + chunker → `{text,locator,ord}` | `ingest/parsePdf.ts`, `ingest/parseText.ts`, `ingest/chunk.ts` | PDF pages 1-based and correct; md headings+lines stable; no empty chunks; **locators unique per document (D8)**; parse failure explicit |
| **C7** | Embed + persist + progress | `ingest/indexDocument.ts` | 1536 dims; deterministic string ids; correct tenancy; truthful pct/status; `deleteMany` before insert (D10); provider failure → `failed` |
| **C8** | Read-your-write probe | `ingest/indexProbe.ts` | no early `indexed`; lag tolerated; permanent failure → `failed`; probe bypasses the status filter (D12) |
| **C9** | verify Space → embed query → vector top-k → BM25 top-k → RRF → dedupe → final top-k | `retrieval/docSearch.ts`, `retrieval/rrf.ts` | both halves scoped by `userId`+`spaceId`; cross-Space leak impossible; RRF deterministic; **BM25 half non-zero (D13)**; non-`indexed` documents excluded; empty → `[]`; K in config |
| **C10** | Register `search_documents`; mode-aware `toolsFor` (D15) | `tools/documents.ts`, `tools/registry.ts` | trace shows it; **not offered on web/auto**; no web tools on docs; no foreign Space reachable; empty `ok:true`; infra failure `ok:false`+error; no embedding leak |
| **C11** | Doc sources/citations; `FinalSource` + prompt (D16, D17b) | `loop.ts`, `ask.ts`, `llm.ts`, `run.ts` (`Evidence` gains `kind:'doc'`) | `trace search_documents → sources(kind=doc) → token* → done`; every citation resolves; PDF source has a page locator; snippet = full chunk; **full top-k emitted**; empty retrieval → no citations |
| **C12** | Docs-only ask path (D17, D17a) | `index.ts`, `ask.ts`, `loop.ts` | missing `spaceId` `400`; foreign/unknown `404`; valid ask deterministically retrieves; `mode:web` unchanged; `mode:auto` deferred |
| **C13** | Observability, `.env.example` knobs, audit | worker/jobs files, `.env.example`, `.claude/BUG-AUDIT.md` | D18's log fields present; no secrets or raw file content; only confirmed findings recorded |

Order C1→C13. Passes: **1** C1–C4 · **2** C5–C8 · **3** C9–C13. Per-component rhythm
(`.claude/CLAUDE.md`): smallest slice → `curl -N` → through the API → through the UI → grader →
commit.

---

## 6. Retrieval quality

Target `recall@5 >= 0.70` on `eval/gold/rag_gold.jsonl`. The bench measures the **first 30** of
39 items (`doc_queries_from_gold`): **26 page-matched PDF items** (`retrieval-basics.pdf` pp.
1–4, `vector-search-on-mongodb.pdf` pp. 1–3) plus **4 anchor-matched Markdown items**
(g27–g30). Page correctness dominates; snippet completeness decides the rest.

Tune in order: parsing → locators → chunk coherence → size/overlap → vector top-k → BM25 top-k
→ RRF constant → final top-k → rerank only if needed. Do not mask poor parsing with a huge
top-k.

---

## 7. Verification

**A. Routes** through `:8787` — `401` missing user · `404` unknown/foreign Space · `400`
invalid upload · `413` too large · `202` accepted.

**B. Async upload** — `202 pending` returns before any parse/embed/index; `202` p95 ≤ 300 ms.

**C. Lifecycle** — `pending → parsing → embedding → indexed`, plus the `failed + error` path.

**D. Worker recovery** — upload → claim → kill worker → stale `running` row → sweeper requeues
→ restart → finishes → **no duplicate chunks** (count rows by `docId`).

**E. PDF citation** — known page N text yields `{kind:"doc", title:"file.pdf",
locator:{page:N, line:…}, snippet:"…"}`. Page is parser-derived, never inferred from chunk
order.

**F. Isolation** — two users, two Spaces: neither can list, upload into, retrieve from, or
receive evidence from the other's; `404` bodies identical.

**G. Empty retrieval** — `ok:true`, `sources:[]`, the answer says there is no supporting
document evidence, no `[n]`.

**H. Failure injection**

| Failure | Expected |
|---|---|
| bad PDF | document + job `failed` + error |
| embedding failure | `failed`, never `indexed` |
| probe never succeeds | bounded retries then `failed` |
| killed worker | stale job requeued |
| Mongo failure before durable accept | no fake `202` |
| retrieval index/DB error | `ok:false` + error |
| job past `JOB_MAX_ATTEMPTS` | terminally `failed`, not requeued |

**I. Search during ingest** — ingest a large PDF while web asks run; prove ingestion is off the
API path/event loop. The `<= 1.3` ratio itself is Phase 8.

**J. Locator uniqueness (D8)** — per document,
`new Set(chunks.map(locatorKey)).size === chunks.length`.

**K. BM25 is alive (D13)** — non-zero sparse hit count against the indexed gold corpus; log
both half-counts on a docs ask.

**L. Rate limit (D19)** — poll the document list continuously for 90 s as one user: no `429`.
Then confirm the limit still fires above the new ceiling.

**M. Regression** — web asks, memory, thread history, search cache, `/stats`, `/health`,
request-id, rate limit, SSE ordering. Still deferred: `mode:auto`, mixed retrieval, deep search.

---

## 8. Graders

```bash
node scripts/create-indexes.mjs --status    # all 3 search indexes READY/queryable
node quality/check.mjs .
node benchmark/bench.mjs
```

Inspect `reports/bench.json`, `reports/eval.json`. Phase 5 proves: upload `202`; worker reaches
`indexed`; doc citation emitted; PDF locator correct; `search_documents` used; recall@5
measured. `cap('routerPicksDocs')` stays failed — Phase 6 (§3).

---

## 9. BUG-AUDIT candidates

Add only if confirmed:
```text
GAP-018  explicit docs retrieval built; mode:auto deferred to Phase 6
GAP-019  ingestion embedding cost sits outside answer RunState accounting
GAP-020  RRF without LLM rerank, with documented reason
GAP-021  local lexical fallback differs from Atlas BM25 (if used)
GAP-022  docs retrieval deterministic, not model-elected (D17a; mirrors GAP-011)
GAP-023  the docs pre-flight consumes one quick tool-call slot (mirrors GAP-012)
ENV/GAP  RATE_LIMIT_PER_MINUTE default raised 30 → 120 (D19), with evidence
```

Watch for real defects: orphan GridFS file after partial persistence · pending document with no
job · retry duplicating chunks · `ObjectId` where the contract wants a string · multipart route
JSON-parsed · vector filter after `$vectorSearch` · `indexed` before the probe · PDF page
boundary lost · two chunks sharing a locator · truncated snippet missing its anchor ·
`search_documents` offered on a web/auto run.

---

## 10. Exit criteria

```text
[ ] Spaces create/list user-scoped
[ ] PDF/Markdown/text <=25MB upload; >25MB → 413
[ ] valid upload → fast 202 pending; GridFS holds the bytes; document + job rows durable
[ ] worker atomically claims; stale jobs recover; retries do not duplicate chunks
[ ] PDF page locators correct (1-based); md/text locators correct
[ ] no two chunks of one document share a locator
[ ] chunks satisfy ChunkDoc; embeddings 1536 dims
[ ] vector + BM25 both demonstrably return hits; RRF fuses them
[ ] userId + spaceId isolation holds on both retrieval paths
[ ] indexed only after the probe
[ ] search_documents registered, trace-visible, NOT offered on web/auto
[ ] docs-only ask emits grounded kind=doc sources — full top-k, full-chunk snippets
[ ] empty retrieval cites nothing
[ ] recall@5 >= 0.70
[ ] continuous document-list polling does not 429
[ ] Phases 1–4 still work; protected folders untouched
[ ] quality/check has no new error-level failure
```

After Phase 5 — **6:** `mode:auto`, routing trace, mixed sources. **7:** deep search. **8:**
SLA, ingestion concurrency, deployment.

Start at **C1**.
