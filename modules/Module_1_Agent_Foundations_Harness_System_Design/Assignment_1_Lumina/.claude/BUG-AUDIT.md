# Bug & change audit trail — LUMINA

Every defect found, every fix applied, and every deliberate temporary deviation made while
building. Kept so that nothing changes silently: if a file differs from the provided
skeleton, the reason is in here.

**No secret values appear in this file by design** — findings reference credentials without
reproducing them.

Conventions: `SEC-*` security, `BUG-*` code defect, `ENV-*` environment/infra,
`TEMP-*` deliberate temporary deviation, `GAP-*` known gap deferred to a later phase.

---

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| [SEC-001](#sec-001) | Live Atlas credentials pasted into tracked `.env.example` | **Critical** | Fixed — rotation still advised |
| [SEC-002](#sec-002) | `atlas-credentials.env` not covered by `.gitignore` | **Critical** | Fixed |
| [BUG-001](#bug-001) | Mongo driver wrote `undefined` optionals as `null` | High | Fixed |
| [BUG-002](#bug-002) | Internal Mongo fields leaked into a contract response | High | Fixed |
| [BUG-003](#bug-003) | `max_tokens` too low — answers truncated mid-sentence | Medium | Fixed |
| [BUG-004](#bug-004) | Write-after-end could crash the process on client disconnect | High | Fixed |
| [BUG-005](#bug-005) | Client disconnect did not abort the LLM stream (wasted spend) | Medium | Fixed |
| [BUG-006](#bug-006) | Persistence failure emitted `error` after `done` already sent | Medium | Fixed |
| [ENV-001](#env-001) | Atlas refused TLS — IP not on access list | — | Resolved |
| [ENV-002](#env-002) | Port 8000 occupied by a stale dev process | — | Resolved |
| [TEMP-001](#temp-001) | `VITE_API_URL` repointed at the agent service | — | **Closed in Phase 3 C9** |
| [TEMP-002](#temp-002) | CORS dev shim added to the agent service | — | **Closed in Phase 3 C9** |
| [GAP-001](#gap-001) | TTFT ~5× over the declared SLA target | — | Deferred to Phase 8 |
| [GAP-002](#gap-002) | SerpApi provider path never exercised | — | Deferred |
| [GAP-003](#gap-003) | `synthesizeAnswer` is now dead code | Low | Closed in Phase 2 |
| [GAP-004](#gap-004) | Run log file not yet written | — | **Closed in Phase 3 C5** |
| [GAP-005](#gap-005) | `searchCached` hardcoded `false` | — | **Closed in Phase 3 C4** |
| [BUG-008](#bug-008) | `MessageDoc._id` required a string; the driver was assigning `ObjectId` | Medium | Fixed (Phase 3 C3) |
| [BUG-009](#bug-009) | `ThreadDoc.title`/`ListThreadsResponse.title` are required but `CreateThreadBody.title` is optional | Medium | Fixed (Phase 3 D4) |
| [ENV-003](#env-003) | Legacy dev-data threads from Phases 1–2 predate the title-required contract | — | Backfilled, dev DB only |
| [BUG-007](#bug-007) | Gateway mapped malformed-JSON `SyntaxError` (`status: 400`) to `502` | Medium | Fixed (Phase 3 C6) |
| [SEC-003](#sec-003) | Caller-supplied `X-Request-Id` was an unvalidated filename (`runs/<id>.json`) | High | Fixed (Phase 3 C5/C6, D3) |
| [SEC-004](#sec-004) | A 65 MB `Assignment_1_Lumina.zip` containing live `.env` secrets was committable | **Critical** | Fixed — rotation advised |
| [GAP-006](#gap-006) | `StatsResponse.ttftP95Ms`/`searchCacheHitRatePct` have no declared home on `RequestDoc` | — | Resolved via additive fields (Phase 3 C5) |
| [GAP-007](#gap-007) | `mode: "auto"` silently served as web | — | Deferred to Phase 6 |
| [GAP-008](#gap-008) | Search-cache gate (`>= 50%` hit rate) has zero margin | — | Deferred to Phase 8 |
| [GAP-009](#gap-009) | Per-user rate limiting (`429`) and SSE pass-through for `/ask` not yet built | — | **Closed in Phase 3 C7/C8** |
| [BUG-010](#bug-010) | Gather prompt allowed answering with zero fetched pages; final prompt lacked a hard citation ceiling | High | Fixed |
| [GAP-010](#gap-010) | Embedding tokens have no declared home on `RunLog`/`RequestDoc` | — | Resolved via additive fields (Phase 4 C8) |
| [GAP-011](#gap-011) | Recall pre-flight is deterministic, not model-elected | — | By design (Phase 4 D1) |
| [GAP-012](#gap-012) | The pre-flight consumes one quick tool-call budget slot | — | By design, documented |
| [GAP-013](#gap-013) | Memory `DELETE` is unconditional/idempotent — `204` even on a foreign or malformed id | — | By design (Phase 4 D4) |
| [GAP-014](#gap-014) | No startup check/log for the memory vector index's queryable state | — | Deferred |
| [GAP-015](#gap-015) | Recall falls back to a visible recency list when vector search returns nothing for a user who has memories | — | By design (Phase 4 D6) |
| [GAP-016](#gap-016) | Provider calls still lack a universal hard deadline beyond client-disconnect abort | — | Deferred to Phase 8 |
| [GAP-017](#gap-017) | Explicit-save backstop is a deterministic text-strip, not a second model call | — | By design (Phase 4 D8a) |
| [BUG-011](#bug-011) | Strict declared-MIME check would reject a browser `.md` upload | Medium | Fixed (Phase 5 C2) |
| [ENV-004](#env-004) | `.env` pinned `RATE_LIMIT_PER_MINUTE=30`, making D19's new default inert | — | Fixed |
| [ENV-005](#env-005) | Atlas connection dropped mid-session over a phone hotspot (ENV-001 recurrence) | — | Resolved (self-recovered) |
| [GAP-024](#gap-024) | `accept_202_p95_ms` not yet measurable — network-bound on the current link | — | Deferred to Phase 8 |
| [BUG-012](#bug-012) | A processing failure was terminal on the first attempt | Medium | Fixed (Phase 5 C5) |
| [GAP-025](#gap-025) | Atlas vector-index lag measured at 0.1–3.7 s — the probe is load-bearing | — | By design (Phase 5 D12) |
| [GAP-026](#gap-026) | `line` indexes the parser's wrapped line view, not raw source lines | — | By design (Phase 5 D8) |
| [GAP-027](#gap-027) | `search_p95_during_ingest` ratio — 0.93× vs a 1.3× gate, after three bad measurements | — | Resolved locally |
| [GAP-030](#gap-030) | Cost per quick answer over the declared gate, both gears | — | Deferred to Phase 8 |
| [BUG-013](#bug-013) | Extension fallback overrode an explicit, unaccepted MIME type | Medium | Fixed (Phase 5 C9–C13) |
| [GAP-028](#gap-028) | `202` accept was over its 300 ms budget by arithmetic; fixed by concurrent writes | — | Resolved (GAP-024 closed) |
| [GAP-029](#gap-029) | Probe budget can be exceeded under bulk ingestion; the retry path absorbs it | — | By design |
| [ENV-006](#env-006) | Anthropic credit balance exhausted — all LLM-dependent verification blocked | — | Resolved (credits restored; all three checks re-run) |

---

## Security

### SEC-001
**Live Atlas credentials pasted into tracked `.env.example`** · Critical · Fixed

- **Symptom:** `git status` showed `.env.example` modified. The diff replaced the placeholder
  `MONGODB_URI` with the real Atlas connection string, including username and password.
- **Why it matters:** `.gitignore` ignores `.env` and `.env.*` but explicitly un-ignores
  `.env.example` (`!.env.example`), so this file **was staged to be committed**. Committing
  secrets is a named red line in `AGENTS.md` and an automatic fail.
- **Root cause:** the real URI was written into the template file instead of (in addition to)
  the ignored `.env`.
- **Fix:** `git checkout -- .env.example` restored the provided placeholder. Verified `.env`
  (correctly ignored) still holds the working URI — the app connects, nothing was lost.
- **Detected:** reviewing `git status`/`git diff` before Phase 2, not by any test.
- **Action still required:** the password was written to a tracked file in the working tree.
  If this repo was ever pushed from this state, **rotate the Atlas password** and update
  `.env`. Rotating regardless is the cheap, safe choice.

### SEC-002
**`atlas-credentials.env` not covered by `.gitignore`** · Critical · Fixed

- **Symptom:** `git check-ignore -v atlas-credentials.env` returned not-ignored, so the file
  appeared as untracked-and-committable. The file contains a plaintext `MONGODB_PASSWORD` and
  its own header says "DO NOT commit this file to version control."
- **Root cause:** the ignore patterns `.env` and `.env.*` only match names *starting with*
  `.env`. Atlas's onboarding writes `atlas-credentials.env`, which matches neither.
- **Fix:** added `*credentials*.env` to `.gitignore`, placed after the `!.env.example`
  negation so it cannot re-ignore the template. Verified now ignored.
- **Verification:** a repo-wide grep for the live URI, `tvly-`, and `sk-ant-` prefixes now
  reports no hits outside `.env`.

### SEC-004
**A 65 MB `Assignment_1_Lumina.zip` containing live `.env` secrets was committable** ·
**Critical** · Fixed — rotation advised · found while preparing the first commit of this build

- **Symptom:** `git status` listed an untracked
  `modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina.zip` (65 MB).
  `unzip -l` shows it contains `Assignment_1_Lumina/.env`, `.env.mongo`, and
  `atlas-credentials.env` — the live Atlas URI, the Anthropic, OpenAI and Tavily keys.
  `git check-ignore` confirmed it was **not ignored**, so it was one `git add -A` away from
  being committed.
- **Root cause — the same blind spot as SEC-002, one level up.** The assignment's own
  `.gitignore` is thorough about `.env`, `.env.*` and `*credentials*.env`, but it can only
  match paths *inside* `Assignment_1_Lumina/`. This file sits **beside** that directory, so
  none of those patterns could ever see it, and the repo-root `.gitignore` had no archive
  rule. An archive of a project directory inherits every secret the directory held while
  being invisible to the ignore rules written to protect it.
- **Fix:** archive patterns (`*.zip`, `*.tar`, `*.tar.gz`, `*.tgz`, `*.7z`, `*.rar`) added to
  the **repo-root** `.gitignore`, where they cover sibling paths. Verified safe first: no
  archive is tracked anywhere in the repo (`git ls-files`) and none was ever added in history,
  so ignoring the family breaks nothing.
- **Verified clean:** `git log --all` shows the zip was **never committed**, so no history
  rewrite is needed.
- **Action still required by the user:**
  1. Delete the zip, or move it outside the repository. An ignore rule stops git committing it;
     it does not stop a backup tool, a cloud-sync folder, or a shared drive from copying it.
  2. If that zip was ever uploaded, shared, or synced anywhere, treat the Atlas password and
     the Anthropic / OpenAI / Tavily keys as exposed and rotate them. SEC-001 already advised
     rotating the Atlas password; this is a second, independent reason.
- **Pattern worth naming:** this is the third secret-exposure finding in this build
  (SEC-001 live creds pasted into a tracked template, SEC-002 a credentials file the patterns
  missed, SEC-004 an archive the patterns could not see). None was found by a test. All three
  were found by reading `git status` before committing.

### SEC-003
**Caller-supplied `X-Request-Id` was an unvalidated filename** · High · Fixed
`backend/agent/src/index.ts`, `backend/gateway/src/index.ts` · found in Phase 3 Components
5/6 (D3), by reading `packages/contract/src/ids.ts` against how the id gets used downstream

- **Symptom:** latent — nothing had tried it yet. `RequestId` in the contract is only
  `z.string().min(1)`, and Component 5 makes that id a filename: `runs/<requestId>.json`.
  A header like `x-request-id: ../../etc/pwned` would be a path traversal on that write.
- **Root cause:** the gateway skeleton's original request-id middleware reused any
  non-empty inbound header verbatim; the agent (pre-Phase 3) always minted its own via
  `newId('req')`, so the hole only opened once the agent started trusting an inbound id too.
- **Fix (D3):** both services now accept an inbound `X-Request-Id` only if it matches
  `^[A-Za-z0-9_-]{1,64}$`; an unacceptable one is never a `400` (a caller may not control
  that header — a corporate proxy, a platform's own router) but is logged once and silently
  replaced with a freshly generated id, which is the only one that ever reaches the response
  header, both services' logs, or `runs/`.
- **Verification:** `x-request-id: ../../pwned` through either service gets a generated
  `req_…` id back and writes no file outside `runs/`; a normal id (`req_manual_c4c6`) is
  adopted as-is and names `runs/req_manual_c4c6.json` exactly.

---

## Code defects

### BUG-013
**Extension fallback overrode an explicit, unaccepted MIME type** · Medium · Fixed
`backend/agent/src/documents.ts` · found in Phase 5 C9–C13 verification, by re-testing the
MIME matrix after an unrelated change

- **Symptom:** a `.txt` file uploaded with `content-type: image/png` was accepted `202`,
  because BUG-011's extension fallback saw `.txt` and resolved it to `text/plain`.
- **Why it was wrong:** BUG-011's fallback exists for ONE case — the browser that reports no
  MIME type for `.md` on Windows. `image/png` is not a missing signal, it is a definite one,
  and overriding it on the strength of a filename is guessing against evidence. It also made
  the earlier verification weaker than it looked: "still rejects a genuinely unsupported
  file" only ever proved that a file with no *recognised extension* is rejected.
- **Fix:** the fallback now applies only when the declared type is absent or generic
  (`''`, `application/octet-stream`, `binary/octet-stream`). A definite-but-unaccepted type is
  a `400`.
- **Verification** (full matrix, each case checked rather than inferred): `.txt`+`image/png`
  → `400`; `.txt`+`text/plain` → `202`; `.md`+no type → `202`; `.md`+`octet-stream` → `202`;
  `.txt`+`application/pdf` → `202` (a declared accepted type still wins over a disagreeing
  extension, and then fails honestly at parse with "Invalid PDF structure"). A 26 MB file with
  a bad type returns `413` rather than `400`, because multer's size limit aborts the stream
  before the type is ever inspected — correct, and worth knowing so the two are not conflated
  in testing.

### BUG-012
**A processing failure was terminal on the first attempt** · Medium · Fixed
`backend/agent/src/worker.ts`, `backend/agent/src/jobs.ts` · found in Phase 5 C5 verification

- **Symptom:** a corrupt PDF correctly ended `failed` — but with `attempts: 1`. `JOB_MAX_ATTEMPTS`
  only ever guarded the *sweeper's* crash-requeue loop; a failure thrown from inside
  `indexDocument` went straight to terminal.
- **Why it matters:** an embedding timeout, a provider `503`, or an Atlas blip fails in exactly
  the same shape as a corrupt file, and the difference only shows on the next attempt. Under
  the old behaviour one transient hiccup permanently failed that document, and the user's only
  recourse was to re-upload. On this build's own network that is not hypothetical — ENV-005 is
  a recorded mid-session Atlas outage — and a corpus file lost that way takes recall@5 down
  with it.
- **Fix:** a processing failure now calls `markJobForRetry` while attempts remain (job back to
  `pending`, error **kept** on the row for diagnosis, `claimedAt`/`workerId` cleared) and only
  goes terminal on the last attempt. Retrying is safe precisely because D10 already made the
  write idempotent. The document is deliberately left at its current stage rather than flipped
  to `failed` and back — it has neither finished nor given up, which is what `parsing`/
  `embedding` already mean, and flickering through `failed` would tell the UI and the bench
  that ingestion was over when it was not.
- **Cost of over-retrying a permanent failure: negligible.** A corrupt PDF throws before any
  provider call, so three attempts are milliseconds apart. Verified: both a garbage-bytes PDF
  and a whitespace-only text file logged `attempt=1 left=2`, `attempt=2 left=1`, then
  `failed terminally` at `attempt=3`, each with its real error preserved on both rows
  (`Invalid PDF structure.` / `no usable text in the document`) and zero chunks written.

### BUG-011
**Strict declared-MIME check would reject a browser `.md` upload** · Medium · Fixed
`backend/agent/src/documents.ts`, `backend/agent/src/index.ts` · found in Phase 5 C2 by
reading `web/src/api.ts:105-108` against the check, not by any test

- **Symptom:** latent against the bench, fatal in the UI. The upload route first validated
  `file.mimetype` against `ACCEPTED_UPLOAD_TYPES` and nothing else, per D4's "do not rely only
  on filename extension."
- **Why the bench would never catch it:** `bench.mjs:319-324` builds every upload as
  `new Blob([buf], { type: MIME[ext] })` — always an explicit, accepted type. The provided UI
  does `form.append('file', file)`, which sends whatever the OS told the browser, and `.md` has
  **no registered MIME type on Windows** and some Linux desktops. Such an upload arrives as
  `''` or `application/octet-stream` and was answered `400` — so Markdown upload was broken for
  a real user while every automated check stayed green. `AGENTS.md` #1 makes the UI the
  acceptance test, so this was a real failure, not a cosmetic one.
- **Fix:** `resolveUploadType()` — the declared type wins whenever it is one we accept;
  otherwise the filename extension is consulted as an explicit **fallback**, never as the
  primary signal; a file with neither an accepted type nor a known extension is still `400`.
  This still satisfies D4 (the extension is never the only thing trusted) while keeping the
  acceptance test working.
- **Verification:** a `.md` blob sent with no type, with `application/octet-stream`, and with
  `text/markdown` all `202`; `notes.rtf` and an extensionless file with no type both still
  `400`; a file whose declared type is accepted keeps it even when the extension disagrees.

### BUG-010
**Gather prompt let the model stop after a search with zero fetches; final prompt had no
hard citation ceiling** · High · Fixed · `backend/agent/src/llm.ts` · found via live UI
testing, not a test suite

- **Symptom:** a large fraction of quick asks (e.g. "who is Lionel Messi?") returned "I'm
  unable to provide a sourced answer — no sources were successfully retrieved," even for
  well-known topics with an obviously-relevant top search result. Separately, one request
  that *did* fetch exactly one page still had its stream killed by the grounding guard with
  `ungrounded citation(s) [2] do not match any emitted source` — the model cited a source
  number one higher than the number of sources it was actually given.
- **Root cause (two related gaps in the prompts, not the retrieval code):**
  1. `GATHER_SYSTEM_PROMPT` told the model to stop once it had "enough grounded evidence,"
     but never told it that a `web_search` snippet is NOT grounded evidence — only a
     `fetch_page` result is (the final turn's sources are built exclusively from
     `state.evidence`, which `loop.ts` only populates on `fetch_page`). The model
     reasonably treated a good-looking snippet as "enough" and skipped fetching, leaving
     `state.evidence` empty and the final turn with nothing to cite.
  2. `FINAL_SYSTEM_PROMPT` said "never invent a source number that is not listed" but
     never stated the actual count, so a model that miscounted by one had nothing concrete
     to check itself against.
  - Confirmed live: reproducing the exact question showed `trace: web_search (cache hit,
    0ms)` followed immediately by `sources: []` and `done` — zero `fetch_page` calls in
    the whole run.
- **Fix:** `GATHER_SYSTEM_PROMPT` now explicitly states a search result is a snippet, not
  citable evidence, and instructs fetching at least one relevant result before stopping
  (unless the question plainly needs no sourcing). `FINAL_SYSTEM_PROMPT` now states that
  citing outside the given range is "a hard failure, worse than citing nothing," and
  `buildFinalSourcesMessage` now states the exact count next to the list itself every time
  (`"There are EXACTLY N source(s) below, numbered 1 through N"` / `"There are 0 sources
  below... cite nothing"`) — reinforced where the model is actually looking when it writes
  a citation, not just once in the system prompt.
- **Verification:** the same question, re-asked, now shows `trace: web_search → fetch_page`
  before `sources`/`done`, returns a real cited answer, and the grounding guard no longer
  trips on it.
- **Residual cost/latency note (not a regression, a consequence of actually answering):**
  an answer built from a real fetched page costs more and takes longer than a one-line
  refusal — the retested run was `$0.094`/`15.3s ttft` against one well-known biography
  question, over the declared `$0.05` cost gate. This compounds `GAP-001` (TTFT already
  ~5× over target) and is a Phase 8 tuning concern (shorter extracts, tighter max_tokens on
  the final turn), not something to chase down further in this fix.

### BUG-001
**Mongo driver wrote `undefined` optionals as `null`** · High · Fixed
`backend/agent/src/db.ts` · found in Component 1 (thread store)

- **Symptom:** creating a thread without a title and reading it back returned
  `{"threadId":"thr_…","title":null,"messages":[]}` — a `null` title that was never set.
- **Root cause:** the Node MongoDB driver serializes an `undefined` field to BSON `null` by
  default rather than omitting the key.
- **Why it matters:** every optional in `packages/contract` is `.optional()`, never
  `.nullable()`. A `null` where the contract says "absent or string" fails validation. The
  blast radius was larger than `title`: `messages` documents carry several optionals
  (`sources`, `answerId`, `done`, `subQuestions`), all of which would have been poisoned the
  same way once Component 5 started writing them.
- **Fix:** `ignoreUndefined: true` on the `MongoClient` — one place, covers every collection.
- **Verification:** unset title is now omitted from the response; a set title still appears.

### BUG-002
**Internal Mongo fields leaked into a contract response** · High · Fixed
`backend/agent/src/threads.ts` · found in Component 5

- **Symptom:** `GET /threads/:id` returned each message with an extra `_id`, plus the internal
  `threadId` and `userId` scoping fields.
- **Root cause:** the read mapped documents through without projecting away Mongo's
  auto-generated `_id`; the original destructure stripped only `threadId`/`userId`.
- **Why it matters:** `AGENTS.md` requires response shapes match `packages/contract` exactly.
  Leaking `userId` into a response body is also needless user-data exposure.
- **Fix:** `{ projection: { _id: 0, threadId: 0, userId: 0 } }` on the `find`, so the
  unwanted fields are never fetched rather than fetched-then-dropped.
- **Verification:** `jq '.messages[] | keys'` now returns exactly the `ThreadMessage` fields.

### BUG-003
**`max_tokens` too low — answers truncated mid-sentence** · Medium · Fixed
`backend/agent/src/llm.ts` · found in Component 5

- **Symptom:** the first full end-to-end answer ended mid-word (`"…successor to Yandex's non-"`)
  with `tokens.out: 1024` — exactly the configured ceiling, i.e. the cap, not a natural stop.
- **Root cause:** `max_tokens: 1024` is below what a multi-source cited answer needs.
- **Fix:** raised to `1536` in both the streaming and non-streaming call paths.
- **Verification:** re-ran the same question — answer completed naturally at 1210 output
  tokens and ended on terminal punctuation.
- **Residual risk:** this is a ceiling, not a guarantee. A proper fix reads `stop_reason` and
  reports a truncated answer honestly rather than presenting it as complete. Logged as
  follow-on work for Phase 2, where termination reasons become explicit.

### BUG-004
**Write-after-end could crash the process on client disconnect** · High · Fixed
`backend/agent/src/ask.ts` · found in Component 6

- **Symptom:** latent, not observed in normal use. If a browser tab closed mid-answer, the
  loop kept calling `res.write` for every remaining token.
- **Why it matters:** writing to an ended/closed response can raise an `'error'` event on the
  response object. With no listener attached, Node turns that into an uncaught exception,
  which takes down the **entire agent service** — every other in-flight request with it.
- **Fix:** `send()` now returns early when `res.writableEnded`, so every call site is guarded
  by one check; the final `res.end()` in the catch block is guarded the same way.
- **Verification:** killed a connection mid-synthesis; service answered `/health` with `200`
  immediately after, and the log showed a clean handled error rather than a crash.

### BUG-005
**Client disconnect did not abort the LLM stream** · Medium · Fixed
`backend/agent/src/ask.ts`, `backend/agent/src/llm.ts` · found in Component 6

- **Symptom:** after a client disconnected, generation continued to completion against the
  provider — tokens billed for an answer nobody would read.
- **Fix:** an `AbortController` wired to the response's `'close'` event (guarded by
  `writableEnded` so a normal `res.end()` isn't mistaken for a disconnect), with its signal
  threaded into the provider `fetch` via a new optional `signal` parameter on `streamAnswer`.
- **Verification:** disconnected mid-stream; log showed the `AbortError` propagating from the
  aborted fetch, and the process stayed healthy.

### BUG-006
**Persistence failure emitted `error` after `done` already sent** · Medium · Fixed
`backend/agent/src/ask.ts` · found in Component 6

- **Symptom:** latent. The assistant message was persisted *inside* the main `try`, after the
  `done` event. A Mongo write failure there fell through to the catch block, which appended an
  `error` event to a stream the client had just been told succeeded.
- **Why it matters:** the contract ends a stream with `done` **or** `error`. Both is
  incoherent, and the client had already rendered a complete, correct answer.
- **Fix:** `done` is sent and the response ended first; persistence then runs in its own
  `try/catch` that logs loudly and never writes to the closed stream. The distinction is
  deliberate — a provider exception must fail loud to the caller, but a storage failure after
  a delivered answer is a server-side problem to log, not a retroactive error.
- **Note:** this is a narrowing of error surfacing, which is exactly the shape of mistake that
  rule A1 warns about, so the reasoning is recorded here on purpose. It is *not* a swallowed
  provider error: all search/fetch/LLM failures still fail loud. Only post-delivery
  persistence is downgraded to a log.

### BUG-008
**`MessageDoc._id` required a string; the driver was assigning `ObjectId`** · Medium · Fixed
`backend/agent/src/threads.ts` · found in Phase 3 Component 3

- **Symptom:** latent — nothing ever read `_id` back, because BUG-002's projection already
  dropped it from every response. Only surfaced while reading `packages/contract/src/db.ts`
  for Component 3's history read.
- **Root cause:** `appendMessage` let the Mongo driver assign its default `ObjectId`, but
  `MessageDoc._id` is `z.string()` — and `newId()`'s prefix union (`ids.ts:28`) has no
  `'msg'` member, so the obvious fix (`newId('msg')`) isn't available without editing the
  contract (a red line).
- **Fix:** a small local `newMessageId()` in `threads.ts`, same shape as `newId()`
  (`msg_<base36 timestamp><random>`), used instead of letting the driver assign one.
- **Verification:** `_id` is still never returned (BUG-002's projection stands), but a
  direct `db.messages.findOne()` now shows a `msg_…` string id, not an `ObjectId`.

### BUG-009
**`ThreadDoc.title` / `ListThreadsResponse.title` required, `CreateThreadBody.title` optional**
· Medium · Fixed · `backend/agent/src/threads.ts` · found in Phase 3 Component 2 (D4)

- **Symptom:** `createThread` stored `title: undefined` for a titleless thread (dropped
  entirely by `ignoreUndefined`), so the row never satisfied `ThreadDoc.title: z.string()` —
  a `GET /threads` listing it would fail `ListThreadsResponse.parse`.
- **Root cause:** a real conflict between two contract schemas, not a coding mistake:
  `CreateThreadBody.title` is `.optional()` (the UI's `createThread` sends `{}`), but every
  schema describing a *stored or listed* thread requires a string.
- **Fix (decision D4 in `.claude/plans/phase-3.md`):** persist a conforming title at
  create time — `"New thread"` + an additive `titleAuto: true` flag when none is supplied —
  and swap in the user's first query (truncated to 200 chars) via a conditional atomic
  update (`{_id, userId, titleAuto: true} → $set title, $unset titleAuto`) on that thread's
  first ask. Gated on the flag, not the literal string, so a user who titles a thread
  exactly "New thread" is never overwritten. The update is naturally idempotent, so two
  concurrent first asks can't race each other.
- **Verification:** a thread created with `{}` lists as `"New thread"` immediately, and as
  its first query after one ask; a second ask leaves the title untouched;
  `ListThreadsResponse.parse` passes on the listing; no `titleAuto` key reaches the response
  (an inclusion projection on `_id, title, createdAt` only).

### BUG-007
**Gateway mapped malformed-JSON `SyntaxError` (`status: 400`) to `502`** · Medium · Fixed
`backend/gateway/src/index.ts` · found in Phase 3 Component 6, by reading the skeleton
against `express.json`'s documented behaviour, not by any test

- **Symptom:** latent in the provided skeleton — `bench.mjs`'s only body probe (`{}` against
  `AskBody`) is *valid* JSON that fails schema validation, so it never exercises this path.
  A literally malformed body (`{"title":`) with a valid `X-User-Id` returned `502` — a status
  the contract reserves for upstream provider failure — instead of `400`.
- **Root cause:** `express.json()` throws a `SyntaxError` carrying `status: 400` (and
  `status: 413` for a body over the 1mb limit) when it can't parse the body, but the
  skeleton's error handler mapped every thrown `Error` straight to `502` regardless of any
  status already attached to it.
- **Fix:** the handler now honours `err.status ?? err.statusCode` for anything in the 4xx
  range (with a clearer message for the 413 case specifically) and falls through to `502`
  only for a genuinely unknown error — never a swallowed exception dressed as success
  (rule A1 still holds: this narrows which errors are 4xx, not whether failures surface).
- **Verification:** malformed JSON + valid `X-User-Id` → `400`; malformed JSON + no
  `X-User-Id` → `401` (auth middleware runs before body parsing, so it never reaches the
  JSON parser at all); the agent being unreachable still → `502`.

---

## Environment

### ENV-004
**`.env` pinned `RATE_LIMIT_PER_MINUTE=30`, making D19's new default inert** · Fixed

- **Symptom:** after Phase 5 D19 raised the code default from 30 to 120
  (`backend/gateway/src/env.ts`) and documented it in `.env.example`, the live limiter was
  still rejecting at 30: 70 of 100 sequential polls got `429`, and 15 of 135 requests got
  `429` right at the 30 mark.
- **Root cause:** not a code defect — `.env` (gitignored, copied from `.env.example` back in
  Phase 3) carried an explicit `RATE_LIMIT_PER_MINUTE=30`, and `num(process.env.X, fallback)`
  only falls back when the variable is **absent**. The new default was unreachable.
- **Why it matters beyond this phase:** this is the general shape of the trap — raising a
  default in `env.ts` changes nothing for anyone whose `.env` already pins that key, which
  includes the deployed services (`fly secrets`) and every other learner. A D19-style fix has
  to land in **both** places or it is decorative.
- **Fix:** `.env` updated to 120 alongside `.env.example`. Verified: 110 polls in one window
  → zero `429`; a 90 s loop at the bench's real 1.2 s cadence → 68 polls, zero `429`; the
  limit still fires at exactly 120 (15 of 135) with a parseable `ErrorBody.resetsAt`.
- **Action still required before deploy:** set `RATE_LIMIT_PER_MINUTE=120` in the deployed
  environment too, or the graded bench run hits the same wall.

### ENV-005
**Atlas connection dropped mid-session over a phone hotspot** · Resolved (self-recovered)

- **Symptom:** mid-verification, 15 consecutive uploads each took **exactly 5.00 s** and the
  agent logged `MongoServerSelectionError` with `SSL alert number 80` — the same misleading
  TLS wording as ENV-001. 5.00 s is `serverSelectionTimeoutMS` (`db.ts:13`), i.e. every
  operation was waiting out the full server-selection budget, not doing work.
- **Diagnosis:** ENV-001 recurring, as its own note predicted ("this recurs on every network
  change"). Testing was running over a phone hotspot (WiFi down); the egress IP for that
  range rotates, so the Atlas access-list entry goes stale without warning. It recovered on
  its own within ~15 s, so the IP evidently rotated back rather than away permanently.
- **Silver lining — fail-loud verified for real, not simulated:** during the outage an upload
  returned `502` with the provider's own error text and **no `202` was ever fabricated**, and
  `/health` answered `503` with `db: "down"`. That is verification H's "Mongo failure before
  durable accept → no fake 202" row, exercised by accident against a genuinely dead
  dependency. Zero orphan GridFS files were left behind, because the failure landed on the
  `getSpace` lookup, before any write.
- **Operational note:** expect this to recur on a hotspot. `curl -s https://api.ipify.org`
  gives the current egress IP for the Atlas access list.

### ENV-003
**Legacy dev-data threads from Phases 1–2 predate the title-required contract** · dev DB only

- **Symptom:** `GET /threads` against the shared local dev Atlas DB failed
  `ListThreadsResponse.parse` — 19 rows created during Phase 1/2 manual testing had either
  no `title` field or (one row, predating BUG-001's `ignoreUndefined` fix) a literal `null`.
- **Why it's not a code defect:** every row created going forward by `createThread` (D4,
  BUG-009) satisfies `ThreadDoc` from the moment it exists. This is old data, not new
  behavior — a fresh database would never produce it.
- **Fix:** one-time backfill (run by hand, not checked in as a script) —
  `updateMany({$or:[{title:{$exists:false}},{title:null}]}, {$set:{title:'New thread', titleAuto:true}})`
  — 19 rows updated. The now-placeholder titles will self-correct the next time each of
  those threads gets an ask, same as any other `titleAuto` row.
- **Note for later:** if the deployed/graded environment starts from a fresh Atlas cluster
  (likely, per `TECHNICAL.md#submit`), this never recurs. Recorded so the fix isn't
  mistaken for a design decision about tolerating missing titles at read time — D4 is
  explicit that Component 2 does **not** synthesize titles at read time.

### ENV-001
**Atlas refused TLS — IP not on access list** · Resolved

- **Symptom:** `/health` reported `db: "down"`; a direct driver connect failed with
  `SSL routines:ssl3_read_bytes:tlsv1 alert internal error ... alert number 80`.
- **Diagnosis:** the TLS-alert wording is misleading — this is Atlas rejecting the connection
  at the network layer, not a certificate or driver fault. Typical causes are the client IP
  missing from the project's IP access list, or a paused cluster.
- **Resolution:** current IP added to the Atlas access list; `db: "ok"`.
- **Note for later:** this recurs on every network change, and will recur for deployed
  services, which need their egress IPs (or `0.0.0.0/0` plus strong credentials) allowed.

### ENV-002
**Port 8000 occupied by a stale dev process** · Resolved

- **Symptom:** `EADDRINUSE :::8000` on start; a `/health` probe answered from an old build
  that predated the current code, which briefly looked like edits having no effect.
- **Resolution:** `lsof -ti:8000 | xargs kill -9` before each restart.
- **Lesson recorded:** when behaviour doesn't match the code, confirm which process is
  actually listening before debugging the source.

---

## Temporary deviations — must be undone

### TEMP-001
**`VITE_API_URL` repointed at the agent service** · **Closed in Phase 3 Component 9**

- **What:** `.env` held `VITE_API_URL=http://localhost:8000` instead of the correct
  `http://localhost:8787`.
- **Why it existed:** the browser needed a backend to exercise Phase 1, and the gateway was
  Phase 3 work that still answered `501` on every route.
- **Fix:** `.env` now holds `VITE_API_URL=http://localhost:8787`, now that the gateway
  actually proxies every route the agent implements (Components 6–7) and rate-limits them
  (Component 8). Verified the UI dev server loads and that the API calls it would make
  (create thread, list threads, stream an ask) succeed through `:8787`.

### TEMP-002
**CORS dev shim added to the agent service** · **Closed in Phase 3 Component 9**

- **What:** a permissive CORS middleware (`Access-Control-Allow-Origin: http://localhost:5173`
  plus `OPTIONS` preflight handling) at the top of `backend/agent/src/index.ts`, inside a
  banner comment marking it temporary.
- **Why it existed:** with the UI pointed at `:8000`, the browser's preflight got `404` and
  every request failed as "Failed to fetch". `curl` was unaffected, which is why the pipeline
  tested clean while the UI did not — only browsers enforce CORS.
- **Fix:** the entire shim block deleted (not disabled). The gateway's `cors()` middleware
  is now the only CORS in the system.
- **Verification:** `grep -rn "Access-Control-Allow-Origin" backend/agent/` returns nothing;
  an `OPTIONS` preflight sent directly to `:8000` gets no `Access-Control-*` headers back
  (a real browser would block the request), while the same preflight through `:8787` gets
  the expected `Access-Control-Allow-Origin: http://localhost:5173`.

---

## Known gaps (deferred by design, not defects)

### GAP-001
**TTFT ~5× over the declared SLA target** · Deferred to Phase 8

Observed `ttftMs` of 11.8s and 13.2s against `ttft_p95_ms: 2500` in `benchmark/sla.json`.
Root cause is structural, not a bug: all four pages are fetched **sequentially** (one took
7.8s alone) and synthesis only starts once every fetch is done. Fixes available later:
fetch concurrently, cap per-page fetch time, reduce page count or extract length. Phase 2
should at minimum keep fetches concurrent; Phase 8 owns hitting the number.

**Phase 4 update — measured pre-flight impact:** the memory pre-flight (D1) runs before the
gather loop even starts, so every millisecond it spends is added one-for-one to `ttftMs`.
Measured directly against the dev cluster: a user with zero stored memories pays only
`countDocuments` — observed 37–104ms (no embedding call at all, D1's whole point). A user
with at least one memory pays a real OpenAI embedding call plus an Atlas `$vectorSearch` —
observed 583–1517ms across several runs, i.e. the pre-flight alone can cost over a second
before the question itself is even looked at. This is additive on top of GAP-001's existing
gap (one run during this same verification pass hit `ttftMs: 10851` on a trivial question
that triggered heavy search/fetch), not yet separated out as its own line item — Phase 8
should decide whether the pre-flight needs its own budget/timeout independent of the
embedding client's own ~8s ceiling (`EMBEDDING_TIMEOUT_MS`), since right now a slow-but-
not-yet-timed-out embedding call is pure, unbudgeted TTFT tax on every request from a
returning user.

### GAP-002
**SerpApi provider path never exercised** · Deferred

`SEARCH_PROVIDER=serpapi` is implemented to the same normalized shape as Tavily but has never
run — no SerpApi key available. `AGENTS.md` requires provider swapping with no code change, so
this needs one real run before submission, or the claim is untested.

### GAP-003
**`synthesizeAnswer` is now dead code** · Low · Closed in Phase 2

Built and verified in Phase 1 Component 4, then superseded by `streamAnswer` in Component 5.
Nothing in the request path called it. Phase 2 Component 4 rewrote synthesis into a pinned
final turn that continues the agent loop's own history (`streamFinalTurn` in `llm.ts`) — at
that point `streamAnswer` itself also became dead (its query-only signature can't continue a
tool-aware history), so both were deleted together rather than carrying two unused prompt
paths that could drift out of sync with the real one.

### GAP-004
**Run log file not yet written** · **Closed in Phase 3 Component 5**

`AGENTS.md` requires `runs/<requestId>.json` per answer in the `RunLog` shape
(`packages/contract/src/db.ts`), and `quality/check.mjs` reads it. Phase 2 Component 5
(`backend/agent/src/runlog.ts`) built and validated the in-memory `RunLog` record and only
logged it. Phase 3's `persistRun` (same file) now writes the Mongo `runs` row first (the
durable record — `scripts/export-runs.mjs` regenerates the file from it, never the
reverse), then the file, then enriches the `requests` row — each in its own `try/catch` so
one failing sink can't take the other three (the message append included) down with it.
Verified: one ask leaves exactly one `runs/<id>.json`, one `runs` row, and one `requests`
row, all three keyed by the same (effective, D3-validated) request id; `quality/check.mjs .`
reports no error-severity failure.

### GAP-005
**`searchCached` hardcoded `false`** · **Closed in Phase 3 Component 4**

Was honest at the time (no cache existed, so nothing was ever a hit). The two-tier cache
(`backend/agent/src/cache/searchCache.ts`: in-process LRU, default capacity 500 —
`SEARCH_CACHE_LRU_MAX`, undeclared anywhere beyond "in-process LRU" per D5 — in front of the
Mongo `searchCache` TTL collection) now lands, and `done.searchCached` /
`requests.searchCached` report real per-request hit/miss via `RunState.searchesTotal` /
`searchesCacheHits` (`run.ts`'s `recordSearch`/`allSearchesCached`). `true` only when the
request made at least one search and every one hit; a zero-search answer reports `false` on
the wire but is omitted from the `requests` row's `searchCached` field entirely, so `/stats`'
hit-rate denominator (Component 5) can tell "didn't search" apart from "searched and
missed". Verified: the same query asked twice (different threads) showed `searchCached:
false` then `true`; the Mongo `searchCache` row's `_id` matched
`sha256(normalized-query + '\0' + provider)`.

### GAP-006
**`StatsResponse.ttftP95Ms`/`searchCacheHitRatePct` have no declared home on `RequestDoc`**
· Resolved via additive fields · Phase 3 Component 5

Neither `RequestDoc` nor `RunDoc`/`RunLog` declares a ttft or cache-hit field. Resolved by
storing `ttftMs` and (when the request searched at all) `searchCached` directly on the
`requests` row as additive fields — safe since nothing in the contract is `.strict()`. Using
`RequestDoc.ms` as a stand-in for ttft was considered and rejected: `ms` is total request
latency, and reporting that as "time to first token" would be a dishonest number dressed up
as a real one. `requests`/`answers` are scoped GLOBAL (all users, all time) rather than
per-calling-user, per `bench.mjs:809–813`'s `stats.answers >= ours` assertion over every
id the bench uses (`bench-deep-*`, `bench-mem-*`, `bench-deepcap-*` included); `deepToday`
is the one per-user field, per `TECHNICAL.md`'s troubleshooting note. "Today" means UTC
throughout, computed from the persisted collections each call — never an in-process counter
— so the numbers survive a restart.

### GAP-007
**`mode: "auto"` silently served as web** · Deferred to Phase 6

`AskBody` defaults `mode` to `'auto'`, and the agent's ask route only rejects `'docs'`
explicitly — an `'auto'` request falls through to the quick web path with nothing in the
trace recording that a routing decision was skipped. Harmless until Phase 6 owns routing
(web vs. docs vs. auto); noted now per the phase-3 plan so it isn't rediscovered as a
mystery then. The gateway's `validateBody(AskBody)` applies the same default and forwards
it unchanged (D1) — the gateway must not start making routing decisions itself.

### GAP-008
**Search-cache gate (`>= 50%` hit rate) has zero margin** · Deferred to Phase 8

`benchmark/sla.json`'s `min_search_cache_hit_rate_pct: 50` against a 40-answer workload with
exactly 20 repeats means *every* repeat must report `searchCached: true` to clear the bar —
and `searchCached` is all-or-nothing per request (Component 4), so one rephrased search
string or one extra search on a repeated question drops the run below 50%. Phase 3 builds
the cache correctly (key = normalized `web_search` tool input + provider) but cannot
guarantee the model repeats its own search phrasing; the likely Phase 8 fix (steer the
gather prompt to search with the user's own wording first) is recorded here rather than
attempted now.

### GAP-009
**Per-user rate limiting and SSE pass-through for `/ask`** · **Closed in Phase 3 Components 7–8**

`backend/gateway/src/proxy.ts`'s `proxyAskStream` now pipes the agent's `/ask` response
byte-for-byte via `Readable.fromWeb(upstream.body)` — no parsing/re-emitting of `data:`
frames, `sseHeaders()` for the four anti-buffering headers, an `AbortController` wired to
the client response's `close` event (mirroring BUG-005 one layer up). A non-streaming
response (detected by content-type, not status) — `404` unknown thread, `400`/`502` before
the agent starts the loop — is forwarded as JSON, never mistaken for a stream.
`backend/gateway/src/rateLimit.ts` adds a per-`X-User-Id` fixed window at
`env.rateLimitPerMinute` (default 30, `RATE_LIMIT_PER_MINUTE`), wired before body parsing
(Component 6's ordering) so a `429` and a `401` are also unambiguous; `/health` is exempt.

Verified: through the gateway, event order (`trace → sources → token → done`) and
incremental timing (45 distinct write timestamps across ~1.4s, not one burst at the end)
matched what the agent produces directly; `x-request-id` survived onto the streamed
response; killing the client mid-stream (`curl --max-time`) left both services on `/health`
`ok`; a loop of 32 requests from one user got `429` on requests 31–32 with a parseable
`ErrorBody{resetsAt}`, a different user in the same window was unaffected, and `/health`
never `429`d.

### GAP-010
**Embedding tokens have no declared home on `RunLog`/`RequestDoc`** · Resolved via
additive fields · Phase 4 C8

Same shape of gap as GAP-006: neither `RunLog` nor `RequestDoc` declares an embedding-
specific token field — only the LLM's `tokens`/`tokensIn`/`tokensOut`. D5 is explicit that
embedding tokens must stay a separate counter from the LLM's `done.tokens`, so folding them
into the existing field was never an option. Resolved the same way GAP-006 was: an additive
`embeddingTokens` field on the `runs`/`requests` Mongo rows and on `runs/<requestId>.json`
(`runlog.ts`'s `persistRun`), safe because nothing in `packages/contract` is `.strict()`.
`embeddingCostUsd` is not broken out separately on the wire — it is already folded into the
one true `costUsd` via `recordEmbeddingUsage` (`run.ts`), so a reader doesn't have to add
two numbers to get the real spend. Verified: `runs/<id>.json` for a save-only request shows
`embeddingTokens: 6` alongside the unchanged `tokens`/`costUsd`/`toolCalls` fields; the LLM
token counters (`tokens`, and `done.tokens.{in,out}` on the wire) are untouched by this —
confirmed via `quality/check.mjs`'s B1 (token budget) still passing on the same runs.

### GAP-011
**Recall pre-flight is deterministic, not model-elected** · By design · Phase 4 D1

Worth recording as a gap-shaped design choice, not a defect: `recall_memory` runs
automatically before every quick ask's first model call (`loop.ts#runMemoryPreflight`),
regardless of whether the question looks like it needs memory. This trades a little
wasted recall (a user with memories who asks something memory-irrelevant still pays a
real embedding+vector-search call) for the reliability the bench actually grades on —
`bench.mjs:779` requires a successful `recall_memory` trace on a question ("capital of
Portugal") that gives the model no obvious reason to call it itself. A purely model-elected
recall could not be made reliable enough to trust for grading without this.

### GAP-012
**The pre-flight consumes one quick tool-call budget slot** · By design, documented

`checkGatherBudget` (`run.ts`) counts `state.toolCalls.length` against the quick cap of 8,
and the pre-flight's `recordToolCall` runs before the gather loop's first budget check — so
a quick ask effectively has 7 tool calls left for the model, not 8, every time the
pre-flight actually runs (it is free, in call-count terms, only in the zero-memory case,
where it still records one `ok:true` entry). Deliberate, not fixed: the pre-flight **is** a
real tool call (it does real work — an embedding call and a vector search — whenever a user
has memories), and the alternative (exempting it from the budget) would let total per-
request tool-call spend drift above what `AGENTS.md`'s cap table declares. Recorded here so
a future "why did research stop after 7 calls, not 8" question isn't a mystery.

### GAP-013
**Memory `DELETE` is unconditional/idempotent** · By design · Phase 4 D4

`DELETE /memory/:memoryId` always answers `204` after auth, whether or not `{_id, userId}`
matched a row — never `404`. This looks backwards next to `DELETE /threads/:threadId`-style
expectations, so it is called out explicitly rather than left to look like an oversight.
`phase-4.md`'s D4 has the full evidence trail: `SPEC.md:233` declares only `204`; `web/`'s
`api.ts` throws on any non-2xx; `bench.mjs`'s `cap()` is a plain overwrite sitting inside
`runMemory`'s one `try/catch`, so a single `404` on a repeat or foreign-id delete would
retroactively flip `memorySaved` to `false` and fail all three memory checks. `{_id,
userId}` plus unconditional `204` also avoids turning the endpoint into an existence/
ownership oracle. Verified (Phase 4 full verification pass, this session): own delete
→ `204`; immediate repeat → `204`; another user's id → `204` with the row surviving;
a malformed id (`not-a-real-id`) → `204` with nothing deleted.

### GAP-014
**No startup check/log for the memory vector index's queryable state** · Deferred

D10 calls for "if the vector index is not queryable, log a startup warning only" without
touching `/health`'s shape. Not built — no code added to `index.ts` to probe
`memories_vector`'s state at process start (out of this phase's component boundaries: C1–C8
touch `embed.ts`/`memories.ts`/`run.ts`/`runlog.ts`/tools/`ask.ts`/`loop.ts`/the memory
routes, never the startup sequence in `index.ts`). Today, an unqueryable index instead fails
where it is actually used: `recallMemories`'s `$vectorSearch` aggregate throws, the catch in
`runMemoryPreflight` turns that into a visible `ok:false` trace with a real error message
(D9), and the ask continues without memory context — so the failure is not silent, just not
pre-announced at boot. `node scripts/create-indexes.mjs --status` is the operator-facing
check in the meantime (confirmed `memories/memories_vector: READY (queryable)` against the
dev cluster throughout this phase's verification). A real startup check is cheap to add
later; recorded here so it isn't mistaken for having been done.

### GAP-015
**Recall falls back to a visible recency list when vector search returns nothing for a user
who has memories** · By design · Phase 4 D6

`recallMemories` (`memories.ts`) treats "`$vectorSearch` returned zero rows, but
`countMemories` says this user has some" as a case needing a fallback, not as a legitimate
empty recall — because the overwhelmingly common cause early in a document's life is Atlas
Vector Search's own indexing lag (new/changed documents are eventually, not immediately,
reflected — `DESIGN.md`'s state section says the same of `chunks`), not an actual absence of
relevant memories. The fallback returns the user's newest ≤10 memories instead, and the
pre-flight's trace `reason` says so explicitly (`"vector search returned nothing; fell back
to N most recent memor(y/ies)"`) rather than reporting a plain, indistinguishable `ok:true`
empty-list success. Verified directly: a memory saved and recalled within ~1s of each other
hit this fallback (`usedFallback: 'recency'`); the identical query re-run after a 15s wait
hit the real vector path (`usedFallback: 'none'`) — confirming the fallback is covering a
real, reproducible indexing-lag window, not masking a bug.

### GAP-016
**Provider calls still lack a universal hard deadline beyond client-disconnect abort**
· Deferred to Phase 8

Phase 4 adds one new provider call site with a real timeout composed with the caller's
abort (`embed.ts`'s `AbortSignal.any([signal, AbortSignal.timeout(env.embeddingTimeoutMs)])`
— D5). The pre-existing LLM call sites (`llm.ts#callAgentTurn`/`streamFinalTurn`) still have
no timeout of their own: they only abort when the client disconnects (`ask.ts`'s
`AbortController` on `res`'s `'close'` event, BUG-005's mechanism) or when the provider
itself answers slowly-but-eventually. A connected client whose request the provider is
simply slow to answer has no server-side ceiling forcing a `cap`/`error` termination beyond
the overall wall-clock budget check, which only runs *between* calls, not around one. Not
new to this phase — the original Phase 3 GAP list already implied this gap without naming
it — but naming it now because D5 made the inconsistency concrete: one provider call in this
codebase has a real timeout and the rest do not. Phase 8 (declared owner of SLA tuning) is
the right place to decide the universal deadline, not a one-off fix here.

### GAP-017
**Explicit-save backstop is a deterministic text-strip, not a second model call** · By
design · Phase 4 D8a

`runSaveBackstop` (`loop.ts`) does not make another LLM call to "extract" the fact to save
when a model-elected `save_memory` never succeeded for an unambiguous save request
(`saveIntent.ts#isExplicitSaveRequest`) — it strips the "remember that/this ..." wrapper off
the query text itself with a fixed set of regexes (`extractMemoryText`) and saves what is
left verbatim. Deliberate, not a shortcut: a backstop whose own mechanism is another
provider call can fail for the exact same class of reason (a flaky model turn, a provider
hiccup) the save it exists to back up might have failed for, which would defeat the point of
a *deterministic* backstop. The trade-off is fidelity — the saved text is the user's own
wording with a wrapper stripped, not a model's paraphrase — which is an acceptable loss for a
fallback path that is supposed to fire rarely. Verified against all of D8a's own worked
examples (three positive, three negative) plus the benchmark's literal save sentence, with
the extracted text printed for inspection in every case.

### ENV-006
**Anthropic credit balance exhausted — all LLM-dependent verification blocked** · **Action
required**

- **Symptom:** every ask now ends with `event: error` carrying
  `anthropic messages (agent turn) 400: ... "Your credit balance is too low to access the
  Anthropic API."` and the request is a `502`.
- **How it was caught, and why that matters:** it was NOT caught by the error appearing — it
  was caught because a decoupling measurement produced web asks that completed in 0.5–0.9 s,
  which is impossible for search + fetch + synthesis. The asks had been piped to `/dev/null`,
  so only the timing was visible. **The GAP-027 ratio first computed from that run (0.76×)
  was measuring the latency of six identical failures and is void.** Recorded as a precedent
  in its own right: a latency measurement that does not also assert the response succeeded is
  not a latency measurement, which is the quality bar's first law ("a thing that ran is not a
  thing that worked") applied to benchmarking rather than to features.
- **What the system did right:** failed loud, exactly as rule A1 requires — `502`, an `error`
  SSE event carrying the provider's own message, no fabricated answer, and no run log written
  on the error path (so `runs/` stayed clean at 51 logs, 0 with `terminated != "done"`, and
  `quality/check.mjs` still reports 0 errors).
- **Unaffected:** embeddings use a separate OpenAI key and still work, so every retrieval
  measurement in this phase (recall@5, both halves' counts, isolation) remains valid, as do
  the ingestion pipeline, the probe, crash recovery, the `202` budget and the MIME matrix.
- **Resolved:** credits restored, and all three outstanding checks re-run green — a fresh
  docs ask end to end (three questions, including one deliberately not in the corpus), the
  web-ask regression (no `search_documents` leak, citations resolve, sources before tokens),
  and GAP-027, which took three more attempts to measure honestly.

### GAP-028
**`202` accept was over its 300 ms budget by arithmetic, not slowness** · Resolved
(this closes GAP-024)

Once the connection was stable enough to measure (36 ms per Atlas round trip on WiFi, versus
44–80 ms and a 5 s outage on the hotspot), the upload path measured **283 ms p50 / 311 ms p95**
against `accept_202_p95_ms: 300` — a real miss, and GAP-024's prediction was right about the
cause: five *sequential* round trips (Space lookup → GridFS chunk doc → GridFS files doc →
`documents` insert → `jobs` insert).

Two changes, in the order they were tried:

1. **Overlap the Space lookup with multipart parsing.** Zero-risk — it is a read, so no bytes
   are written for a Space that may not exist. Measured effect on the gate: **none**, because
   a 13 KB upload parses in about a millisecond, so there is nothing to overlap with. Kept
   anyway: it is free and does help a 25 MB upload. Worth recording that the obvious
   optimisation was the one that did nothing.
2. **Mint the GridFS id up front and run all three writes concurrently.** This is what worked:
   **174 ms p50 / 265 ms p95**, inside the gate. All three are still awaited before the `202`,
   so durable acceptance is unchanged (D2); what changed is only that they no longer wait on
   each other.

The one guarantee given up is write *ordering*: the job row can become visible a few
milliseconds before the document row, so a worker polling at that instant can claim a job
whose document it cannot yet read. That is already absorbed by BUG-012's retry, and it was
measured rather than assumed — **0 "document not found" retries across 49 documents** ingested
back to back. GAP-024's own note argued against this change; it was reversed because the
premise ("against an unmeasurable baseline") no longer held and the race turned out to be
covered by a mechanism added since.

### GAP-029
**Probe budget can be exceeded under bulk ingestion; the retry path absorbs it** · By design

Ingesting 49 documents back to back (a stress case created by the `202` latency test, not a
real workload) pushed Atlas Search index lag past the probe's 18 s budget
(`DOC_PROBE_MAX_ATTEMPTS=12 × DOC_PROBE_BACKOFF_MS=1500`), versus the 0.1–3.7 s measured for
four documents (GAP-025).

The outcome is the behaviour the design intends, and is worth recording as positive evidence:
**44 jobs done, 1 terminally failed with an honest error, 0 documents falsely marked
`indexed`.** Under stress the probe refused to lie, and BUG-012's retry carried the rest.

Deliberately not "fixed" by raising the default: 18 s is right for normal operation, a longer
budget makes a genuinely broken index slower to report, and a document under sustained lag
already gets three attempts (~54 s total) before going terminal. The graded workload is five
documents, not fifty.

### GAP-024
**`accept_202_p95_ms` not yet measurable — the upload path is network-bound on this link**
· **Closed by [GAP-028](#gap-028)**

`benchmark/sla.json` declares `accept_202_p95_ms: 300`. Measured through the gateway on the
current connection: **p50 476 ms / p95 533 ms** in one run and **p50 911 ms / p95 1 241 ms**
in another, 20 minutes apart, with the same code. The variance is the measurement, not the
build.

Attribution, measured rather than assumed:
- the gateway hop costs ~0 ms — a single-round-trip route (`GET /spaces`) is 44 ms both
  through `:8787` and direct to `:8000`;
- one Atlas round trip on this link was **44 ms at best and ~80 ms typical**, and the same
  session saw a 24.5 s outlier and a complete 5 s-timeout outage (ENV-005);
- the upload makes **5 sequential Atlas round trips** by construction: `getSpace` (1) →
  GridFS `openUploadStream` (2: the chunk doc then the files doc) → `documents` insert (1) →
  `jobs` insert (1). At 44 ms that is ~220 ms; at 80 ms it is ~400 ms; on a same-region
  deployed cluster (single-digit ms) it is well under 100 ms.

So the number is dominated by RTT to Atlas from a phone hotspot and **must be re-measured on
a stable connection and against the deploy** before it means anything. Deliberately **not**
optimised now, because the two available savings both cost something real and neither is
worth buying against an unmeasurable baseline:
- running `getSpace` concurrently with the GridFS write would save one RTT but writes file
  bytes for a Space the caller may not own — storage amplification an unauthenticated-ish
  caller could drive;
- inserting the `documents` and `jobs` rows concurrently would save one RTT but lets the
  worker claim a job whose document row is not yet visible, trading a measurable 80 ms for a
  race in the exact subsystem whose grade depends on not having silent failure modes.

If the number still misses on a good connection, the honest fix is the first one plus an
ownership pre-check that does not write, not either shortcut above.

### GAP-025
**Atlas vector-index lag measured at 0.1–3.7 s — the read-your-write probe is load-bearing**
· By design · Phase 5 D12

Recorded because it is the one number that justifies the probe's existence, and it was
measured, not assumed. Across four documents ingested back to back, `waitUntilSearchable`
needed:

| document | probe attempts | waited |
|---|---|---|
| retrieval-basics.pdf (10 chunks) | 2 | 1 858 ms |
| vector-search-on-mongodb.pdf (8) | 3 | 3 686 ms |
| agent-loops-and-failure.md (12) | 2 | 1 754 ms |
| streaming-and-latency.md (11) | 1 | 111 ms |

So three of four documents were **not** searchable at `insertMany` time. Had `indexed` been
set there, those documents would have reported `indexed/100` while every question about them
returned nothing, for up to 3.7 s — `TECHNICAL.md:372`'s exact symptom, and the reason
`AGENTS.md` makes the probe a Must. The defaults (`DOC_PROBE_MAX_ATTEMPTS=12`,
`DOC_PROBE_BACKOFF_MS=1500`) give ~18 s of headroom against an observed worst case of 3.7 s.

Also verified here: the probe's tenancy filters sit INSIDE `$vectorSearch`, and a query with a
foreign `userId` or a foreign `spaceId` returns **zero** rows.

### GAP-026
**`line` indexes the parser's wrapped line view, not raw source lines** · By design · D8

D8 keeps locators unique by never splitting a source line across chunks. A pathological line
(a 20 000-character paragraph on one line) would therefore become one enormous chunk, blowing
the chunk-size ceiling D16 depends on — so `parsed.ts#wrapLines` wraps lines longer than
`DOC_LINE_WRAP_CHARS` (default 400) at word boundaries first, and `locator.line` numbers that
wrapped view.

Called out explicitly because "never fabricate a locator" is a hard rule and this is the one
place the number is derived rather than counted. For any document whose lines are shorter than
the wrap width the two views are **identical line for line** — the longest line in the entire
gold corpus is 94 characters, so every graded locator is exactly its source line. Past that
width `line` is still a real, deterministic, reproducible position in a documented view of the
file, which is what distinguishes a derived locator from a guessed one.

### GAP-027
**`search_p95_during_ingest` ratio: measured at 0.93× against a 1.3× gate** · Resolved locally;
the deploy number is still Phase 8's

Took **four attempts**, and the three failed ones are the useful part of this entry — each
produced a plausible passing number while measuring something other than what it claimed:

| # | Reported | What it actually measured |
|---|---|---|
| 1 | ratio 2.1 (MISS) | a `/spaces` probe on a hotspot that swung 44 ms → 5 s in one session |
| 2 | ratio 0.76 (PASS) | six identical `502`s — the Anthropic balance had run out (ENV-006) |
| 3 | ratio 0.76 (PASS) | real asks, but the 400-page ingest **finished before the probes started** — idle vs idle |
| 4 | **ratio 0.93 (PASS)** | 4/4 asks succeeded **and** 4/4 had ingestion in flight start to finish |

Attempt 4's preconditions were asserted in the harness rather than assumed, and the harness
refuses to print a ratio unless both hold:

```text
in-flight documents:  13 → 12,  12 → 10,  10 → 7,  7 → 4
idle    p95 25 604 ms   [13104, 9151, 25604, 18221]
ingest  p95 23 860 ms   [11169, 11862, 23860, 16031]
ratio 0.93x   gate <= 1.3   PASS
```

14 × 400-page PDFs (5 600 chunks) were queued to keep the worker continuously busy, because a
single 400-page document indexes in ~8 s and drains long before four web asks finish. Worth
noting for Phase 8: the bench's own decoupling check uploads one 60-page PDF
(`ingest_during_search_pdf_pages: 60`) and then runs four probes, so **its** ingest also drains
before its probes complete — the gate is lenient by construction, and passing it is not by
itself evidence of decoupling.

The structural claim is the one that actually matters and it holds independently: the worker is
a separate OS process (`npm run worker`), so it cannot block the API event loop by
construction.

**Standing lesson, promoted out of ENV-006:** three of four attempts here reported a passing
ratio from a measurement that was not measuring the thing. A timing number is only admissible
alongside an assertion that the work succeeded *and* that the condition being tested was
actually present. The harness now encodes both.

### GAP-030
**Cost per quick answer is over the declared gate, documents included** · Deferred to Phase 8

`sla.json` declares `max_cost_per_answer_usd: 0.05` as a mean over quick answers. Measured on
real runs after Phase 5:

| ask | cost |
|---|---|
| docs, PDF question (9 sources) | $0.0424 |
| docs, Markdown question (12 sources, 3 searches) | $0.0695 |
| docs, question not in the corpus (8 sources) | $0.0209 |
| web, "what port does mongod listen on" | $0.0585 |
| web, "who is the CEO of MongoDB" | $0.0809 |

So both gears now straddle the gate. For document asks the driver is specific and new in this
phase: D16 requires the FULL chunk text as each source's snippet (a truncated one loses the
anchor-matched gold items), and `docMaxSources: 12` means a final prompt can carry ~10 KB of
chunk text plus the same text again in the tool results. That is a deliberate
recall-for-cost trade, not an accident — but it belongs in the record next to the number it
moves.

Phase 8 owns this alongside GAP-001 (TTFT ~5× over target, and these runs show 5.9-9.2 s TTFT
on docs asks and 9-26 s end-to-end on web asks). The levers are known: stop sending chunk text
twice (tool result and final prompt), lower `docMaxSources`, cap per-page extract length, and
fetch concurrently. None of them should be pulled before the bench measures the blend.

`sla.json` declares `search_p95_during_ingest_ratio_max: 1.3`. Measured while a 400-page PDF
ingested at 49 %: API p50 **0.146 s → 0.143 s** (unchanged) but p95 **0.273 s → 0.586 s**, a
ratio of 2.1. That ratio is not trustworthy on this connection — the same route has swung
between 44 ms and a 5 s timeout within one session (ENV-005, GAP-024), and p95 over 20 samples
is exactly where that noise lands.

What Phase 5 *did* have to prove is structural and is proven: the worker is a separate OS
process (`npm run worker`), so it cannot block the API's event loop by construction, `/health`
answered in 120 ms mid-ingest, and p50 did not move. The number itself belongs to Phase 8,
measured against the deploy, with the bench's own web-ask workload rather than a `/spaces`
probe.

---

## Files changed vs. the provided skeleton

| File | Status | Why |
|---|---|---|
| `backend/agent/src/threads.ts` | new, extended in Phase 3 | Thread/message store (Component 1). Phase 3 C1–C3: typed collection accessors, `listThreads`, D4 title promotion, `getRecentHistory` |
| `backend/agent/src/collections.ts` | new (Phase 3 C1), extended in Phase 4 C2 | Typed collection accessors keyed off `COLLECTIONS`, replacing scattered string literals. Phase 4 C2: `memoriesCollection` |
| `backend/agent/src/tools/webSearch.ts` | new, extended in Phase 3 | `web_search`, Tavily + SerpApi (Component 2). Phase 3 C4: cache wraps the provider dispatch, `onCacheResult` reports hit/miss |
| `backend/agent/src/tools/fetchPage.ts` | new | `fetch_page`, Readability extraction (Component 3) |
| `backend/agent/src/llm.ts` | new, extended in Phase 4 C7 | Synthesis + streaming synthesis (Components 4–5). Phase 4 C7: D2's save-only carve-out and memory-is-context rule in both system prompts; `buildMemoryWriteNote`/D9a's final memory-write status block, threaded through `streamFinalTurn` |
| `backend/agent/src/ask.ts` | new, rewritten in Phase 2, extended in Phase 3 and Phase 4 | Phase 1: fixed pipeline. Phase 2 C4: agent loop + pinned final turn + SSE. Phase 3 C3: takes/forwards prior-turn history. Phase 3 C4/C5: honest `searchCached`, takes the resolved `requestId`, calls `persistRun`. Phase 4 C3: wires `runMemoryPreflight` → `runGatherLoop` (now passed the preflight's context block and step count) → `runSaveBackstop`. Phase 4 C7: passes `state.memoryWrites` into `streamFinalTurn` |
| `backend/agent/src/tools/registry.ts` | new (Phase 2), extended in Phase 3 and Phase 4 | Tool registry, `toolsForDepth` (Component 1). Phase 3 C4: `ToolExecContext`/`onCacheResult` side-channel. Phase 4 C3: `ToolExecContext` extended with `userId`/`threadId`/`signal`/`onEmbeddingUsage`/`onMemoryWrite`; `recall_memory`/`save_memory` registered |
| `backend/agent/src/tools/memory.ts` | new (Phase 4 C3) | `recallMemoryTool`/`saveMemoryTool` — the model-elected `ToolDefinition`s; the deterministic pre-flight/backstop call `memories.ts` directly instead |
| `backend/agent/src/run.ts` | new (Phase 2), extended in Phase 3 and Phase 4 | Explicit run state + budget helpers (Component 2). Phase 3 C4: `searchesTotal`/`searchesCacheHits`, `recordSearch`, `allSearchesCached`. Phase 4 C2/C8: `embeddingTokens`, `memoryWrites`, `recordEmbeddingUsage` (folds embedding cost into `costUsd`, D5) |
| `backend/agent/src/loop.ts` | new (Phase 2), extended in Phase 3 and Phase 4 | The gather loop (Phase 2 C3). Phase 3 C3: accepts seed history. Phase 3 C4: passes the cache-result context into `tool.execute`. Phase 4 C3: `runMemoryPreflight` (D1), `runSaveBackstop` (D8a); `runGatherLoop` takes `memoryContext`/`startStep` (D7, trace-step continuity); tool-exec context extended with `userId`/`threadId`/`signal`/`onEmbeddingUsage`/`onMemoryWrite` |
| `backend/agent/src/runlog.ts` | new (Phase 2), extended in Phase 3 and Phase 4 | In-memory `RunLog` builder (Component 5). Phase 3 C5: `persistRun` — writes the `runs` Mongo row, the `runs/<id>.json` file, and enriches the `requests` row, each in its own `try/catch` (GAP-004 closed). Phase 4 C8: additive `embeddingTokens`/`memoryWrites` on all three sinks (GAP-010) |
| `backend/agent/src/stats.ts` | new (Phase 3 C5) | `buildStats` — `/stats`'s global/today-UTC aggregation per the plan's scoping table |
| `backend/agent/src/cache/searchCache.ts` | new (Phase 3 C4) | Two-tier search cache (in-process LRU + Mongo `searchCache` TTL collection), D5's key/normalization/eviction rules |
| `backend/agent/src/embed.ts` | new (Phase 4 C1) | `embed()` — OpenAI `text-embedding-3-small`, fail-loud, `EMBEDDING_TIMEOUT_MS` composed with the caller's abort via `AbortSignal.any`; `EMBEDDING_USD_PER_MTOK` |
| `backend/agent/src/memories.ts` | new (Phase 4 C2) | `saveMemory`/`listMemories`/`deleteMemory`/`countMemories`/`recallMemories`/`buildMemoryContextBlock` — the memory store; Atlas `$vectorSearch` + `mongo-cosine-scan` + recency fallback (D6), userId-scoped throughout (D11) |
| `backend/agent/src/saveIntent.ts` | new (Phase 4 C3) | `isExplicitSaveRequest`/`extractMemoryText` — pure, deterministic detector/extractor behind the explicit-save backstop (D8a, GAP-017) |
| `backend/agent/src/index.ts` | modified | Routes wired; `requireUserId`; `400` vs `502` error split; **plus TEMP-002**. Phase 3 C2/C3: `GET /threads` route, history read before `appendMessage`, title promotion call. Phase 3 C5: D3 request-id adoption middleware, `requests`-row-on-finish middleware, `GET /stats` route. Phase 3 C9: **TEMP-002's CORS shim deleted**. Phase 4 C4/C5: `GET /memory`, `DELETE /memory/:memoryId` (unconditional `204`, GAP-013) |
| `backend/agent/src/spaces.ts` | new (Phase 5 C1) | `createSpace`/`listSpaces`/`getSpace` — the Space store, `userId`-scoped throughout (D1); `getSpace` returning `null` is the one answer for both "unknown" and "not yours" |
| `backend/agent/src/uploads.ts` | new (Phase 5 C2) | GridFS helpers — `putUpload`/`readUpload`/`deleteUploadQuietly`; converts the bucket's `ObjectId` to the hex string `DocumentDoc.fileId` requires |
| `backend/agent/src/documents.ts` | new (Phase 5 C2/C3) | `acceptUpload` (GridFS → document row → job row, each failure unwinding the earlier writes), `listDocuments` (inclusion projection to `DocumentRow` only), `resolveUploadType` (BUG-011) |
| `backend/agent/src/jobs.ts` | new (Phase 5 C2), extended in C5 | `enqueueIndexJob` + local `newJobId()` (BUG-008's precedent — `newId()` has no `'job'` prefix). C5: atomic `claimNextJob`, `markJobDone`/`markJobFailed`/`markJobForRetry` (BUG-012), `sweepStaleJobs` splitting requeue from attempt-exhausted |
| `backend/agent/src/worker.ts` | built out (Phase 5 C5) | The ingestion worker loop — sweep → claim → ingest → done/retry/fail, one job at a time, D18 log fields, graceful SIGINT/SIGTERM. Crash safety is the sweeper's job, not a cleanup handler's |
| `backend/agent/src/ingest/parsed.ts` | new (Phase 5 C6) | `ParsedUnit`/`ParsedDoc` — the one shape every parser produces, plus `wrapLines` (GAP-026). A unit is a region the chunker may never chunk across, which is what makes a locator honest |
| `backend/agent/src/ingest/parsePdf.ts` | new (Phase 5 C6) | Page-aware extraction via the **legacy** pdfjs build, 1-based physical pages, visual lines reconstructed by Y-grouping then X-sort, `verbosity: 0` to keep font warnings out of the worker log |
| `backend/agent/src/ingest/parseText.ts` | new (Phase 5 C6) | Markdown → one unit per heading section (fence-aware, so a `#` inside a code block is not a heading); plain text → one unit; document-global line numbering so repeated heading text still yields distinct locators |
| `backend/agent/src/ingest/chunk.ts` | new (Phase 5 C6) | `chunkUnits` + `assertUniqueLocators` — D8's uniqueness made structural (never span a unit, never split a line, overlap may not reach back to the previous chunk's first line) and then asserted before any insert |
| `backend/agent/src/ingest/indexDocument.ts` | new (Phase 5 C7) | The whole ingestion: parse → chunk → `deleteMany` → embed in batches → `ChunkDoc.parse` → `insertMany` → probe → `indexed`. D10's two-part idempotency lives here |
| `backend/agent/src/ingest/indexProbe.ts` | new (Phase 5 C8) | `probeOnce`/`waitUntilSearchable` — filters inside `$vectorSearch`, queries by `docId` so it does not inherit retrieval's `indexed`-only filter, and distinguishes "not yet" from "will never work" (GAP-025) |
| `backend/agent/src/embed.ts` | extended (Phase 5 C7) | `embedBatch` via a shared `embedRequest` — one client, one model, one timeout (D11), with explicit re-ordering by the API's `index` so a batch can never attach a vector to the wrong chunk |
| `backend/agent/src/documents.ts` | extended (Phase 5 C5–C8) | `getDocument`, `setDocumentStage` (truthful pct, omits a zero `pages`), `failDocument` (always a non-empty error, keeps `pct` where it stopped) |
| `backend/agent/src/env.ts` | extended (Phase 5 D9) | The ingestion/retrieval knobs: chunk target/overlap/wrap, embed batch size, the four retrieval k's plus `docMaxSources`, job stale/poll/max-attempts, probe attempts/backoff |
| `backend/agent/src/retrieval/rrf.ts` | new (Phase 5 C9) | `reciprocalRankFusion` — fuses by RANK, because a cosine score and a BM25 score are not on the same scale; deterministic tie-breaking so recall@5 is reproducible |
| `backend/agent/src/retrieval/docSearch.ts` | new (Phase 5 C9) | Hybrid retrieval: `$vectorSearch` with both tenancy filters INSIDE the stage, Atlas `$search` BM25 scoped with `equals` on the token-mapped paths, RRF fusion, `indexed`-only documents, per-half counts returned so a dead lexical half cannot hide. Plus D14's cosine-scan and labelled dev-lexical fallbacks |
| `backend/agent/src/tools/documents.ts` | new (Phase 5 C10) | `search_documents` — query-only input, tenancy from `ToolExecContext`, never embeddings or chunk ids in the model's view |
| `backend/agent/src/tools/registry.ts` | extended (Phase 5 C10) | `toolsFor({depth, mode, hasSpace})` replacing `toolsForDepth` — `search_documents` only on `mode:"docs"` with a Space, web tools excluded on docs, `plan_research` still deep-only. `ToolExecContext` gains `spaceId`/`onDocHits` |
| `backend/agent/src/loop.ts` | extended (Phase 5 C11/C12) | `runDocsPreflight` (D17a, the deterministic first retrieval) and `addDocEvidence` (dedupe by chunk id, first position wins); the gather loop is scope-aware and selects the docs gather prompt |
| `backend/agent/src/llm.ts` | extended (Phase 5 C11/D17b) | `GATHER_DOCS_SYSTEM_PROMPT` (a retrieved chunk IS the evidence — the web prompt's fetch rule is unachievable here); `FinalSource.url` optional with `docId`/`locator`; `describeSource` renders `file.pdf, p. 14` |
| `backend/agent/src/ask.ts` | extended (Phase 5 C11/C12) | Takes a `QuickAskArgs` object with `mode`/`spaceId`; runs the docs pre-flight; emits the full fused top-k as `sources` with FULL chunk text as the snippet (D16), bounded by `docMaxSources` |
| `backend/agent/src/run.ts` | extended (Phase 5 C11) | `Evidence` is now a discriminated union (`WebEvidence` \| `DocEvidence`); `RunState` carries `mode`/`spaceId` |
| `backend/agent/src/collections.ts` | extended (Phase 5 C1) | `spacesCollection`, `documentsCollection`, `chunksCollection`, `jobsCollection` |
| `backend/gateway/src/proxy.ts` | extended (Phase 5 C4) | `proxyUpload` — multipart forwarder; `proxyToAgent` cannot carry it (forces JSON, sends `{}`, 15 s cap). Streams `req` with `duplex:'half'`, copies `content-type` verbatim for the boundary, and refuses over-size at the edge from `content-length` so the agent's mid-upload `413` is not seen as a socket error |
| `backend/gateway/src/env.ts` | modified (Phase 5 D19) | `rateLimitPerMinute` default 30 → 120 (see ENV-004 — `.env` had to change too) |
| `backend/agent/src/db.ts` | modified | BUG-001 (`ignoreUndefined`) |
| `backend/agent/src/env.ts` | modified (Phase 3 C4, Phase 4 C1) | `SEARCH_CACHE_LRU_MAX` (default 500, D5). Phase 4: `EMBEDDING_TIMEOUT_MS` (default 8000, D5) |
| `.env.example` | modified (Phase 3 C4) | documents `SEARCH_CACHE_LRU_MAX` |
| `backend/gateway/src/index.ts` | modified (Phase 3 C6, C8; Phase 4 C6) | D3 request-id validation (replacing the skeleton's naive reuse), auth-before-body-parse ordering, `validateBody`+`proxyToAgent` wired for the agent's built routes, BUG-007 fix in the final error handler. Phase 3 C7: `/ask` wired to `proxyAskStream`. Phase 3 C8: `rateLimit()` wired before body parsing. Phase 4 C6: `GET /memory`, `DELETE /memory/:memoryId` wired to the existing generic `proxyToAgent()` — no new gateway logic needed |
| `backend/gateway/src/proxy.ts` | new (Phase 3 C6), extended in Phase 3 C7 | D1's one generic forwarder — method/path/`X-User-Id`/`X-Request-Id`/body to the agent, status/content-type/body back, `502` on an unreachable agent. Phase 3 C7: `proxyAskStream` — byte-for-byte SSE pass-through with an `AbortController` on client disconnect |
| `backend/gateway/src/validate.ts` | new (Phase 3 C6) | zod-validates a body against a contract schema, `400` with the zod message, forwards the parsed (defaulted) object |
| `backend/gateway/src/rateLimit.ts` | new (Phase 3 C8) | Per-`X-User-Id` fixed-window rate limit, `429` with `ErrorBody.resetsAt`, `/health` exempt |
| `.env` | modified (Phase 3 C9) | **TEMP-001 closed** — `VITE_API_URL` back to `http://localhost:8787` |
| `.claude/BUG-AUDIT.md` | modified (this session) | BUG-007, BUG-008, BUG-009, SEC-003, ENV-003, GAP-004/005 closed, GAP-006/007/008/009 added; TEMP-001/TEMP-002/GAP-009 closed (Phase 3 C7–C9). Phase 4 C8: GAP-001 updated with measured pre-flight TTFT delta; GAP-010–GAP-017 added |
| `.gitignore` | modified | SEC-002 |
| `DESIGN.md` | new | The five design questions (graded deliverable) |
| `.claude/CLAUDE.md`, `.claude/plans/`, `.claude/BUG-AUDIT.md` | new | Build context and phase plans |

Provided folders (`web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`)
are **untouched**, as required.
