# Phase 1 plan — MVP: Quick Web Search

Read `.claude/CLAUDE.md` first for full project context (the four grading rules, the
non-negotiables, the reference map). This file is the component-by-component build
sequence for Phase 1 only. Work through the components in order, each independently
testable before moving to the next.

```text
User question → web search → fetch source pages → LLM synthesis → cited answer → SSE stream to UI
```

**Goal:** ask a question from the UI and receive a streamed, cited web answer.

All work happens in `backend/agent/src/`. The gateway doesn't exist yet (that's Phase 3) —
test the agent service directly on `:8000` with `curl -N`, per `TECHNICAL.md` Part 1. The
current skeleton (`index.ts`, `env.ts`, `db.ts`) already has `/health` and a `501` for every
other route — build on it, don't rewrite it.

This phase is a **fixed pipeline, not an agent loop** (the loop, budgets, and termination
reasons are Phase 2). Hard-code the sequence: `web_search` → `fetch_page` on top results →
synthesize → stream. No run log yet (Phase 3), no search cache yet (Phase 3), no agent
decision-making yet (Phase 2).

---

## Component 1 — Thread store

- New: `backend/agent/src/threads.ts` — `createThread()`, `getThread(id)`,
  `appendMessage(id, msg)` against Mongo `threads`/`messages` collections. Shapes:
  `ThreadMessage`, `GetThreadResponse` in `packages/contract/src/http.ts`.
- Wire `POST /threads` → `201 { threadId }` and `GET /threads/:threadId` → `200 { messages }`
  in `index.ts`, replacing their `501` stubs.
- **Done when:**
  ```bash
  curl -s -X POST localhost:8000/threads -H 'x-user-id: dev'   # returns a thr_… id
  curl -s localhost:8000/threads/<id> -H 'x-user-id: dev'      # returns { messages: [] }
  ```

## Component 2 — `web_search` tool

- New: `backend/agent/src/tools/webSearch.ts` — calls Tavily or SerpApi per
  `env.searchProvider`, returns `{title, url, snippet}[]`.
- No cache yet — the two-tier search cache is Phase 3.
- **Done when:** a standalone call returns real results for a test query. No SSE involved yet.

## Component 3 — `fetch_page` tool

- New: `backend/agent/src/tools/fetchPage.ts` — fetches a URL and extracts readable text
  (`@mozilla/readability` + `jsdom`, or Tavily's `extract` if using Tavily). Returns
  `{url, text}`.
- **Done when:** it returns clean body text for 2–3 real URLs, not raw HTML.

## Component 4 — LLM synthesis

- New: `backend/agent/src/llm.ts` — one function: given a query + fetched pages, prompts the
  LLM (Anthropic) to write an answer with `[n]` citations grounded only in the fetched text,
  returning `{text}`. Keep the prompt simple: cite only what's below; say so if nothing is
  relevant.
- **Done when:** calling it with a fake query + 2 fake pages produces text containing
  `[1]`/`[2]` that actually matches the snippets.

## Component 5 — wire the pipeline into `POST /threads/:id/ask`

- In `index.ts`: set up SSE headers (disable compression, `res.flushHeaders()`, flush after
  every `res.write`), emit `trace` for the search step and each fetch step, then `sources`
  (built from fetched pages, numbered from 1), **then** start streaming `token` events as the
  LLM generates, then `done` (`terminated: "done"`, measured `latencyMs`/`ttftMs`/`tokens`/
  `costUsd`, `depth: "quick"`, `searchCached: false`).
- Validate `AskBody` with zod (`packages/contract/src/http.ts`) inline for now — full
  gateway-side validation is Phase 3.
- **Done when:**
  ```bash
  T=$(curl -s -X POST localhost:8000/threads -H 'x-user-id: dev' | jq -r .threadId)
  curl -N -X POST localhost:8000/threads/$T/ask -H 'x-user-id: dev' -H 'content-type: application/json' \
    -d '{"query":"What is Tavily?","mode":"web"}'
  ```
  prints `event: trace` lines, then `event: sources` **before** any `event: token`, then
  tokens, then `event: done`. Every `[n]` in the streamed text has a matching `n` in `sources`.

## Component 6 — basic error handling

- Wrap the search/fetch/LLM calls so a thrown exception emits `event: error {status:502, error}`
  and ends the stream — never a caught "no results found" standing in for a real failure
  (the fail-loud rule from `CLAUDE.md`).
- **Done when:** temporarily breaking the search API key produces a `502` stream event, not a
  fake answer.

---

## Then, per the standard development loop

Test independently (each component above) → test through the API (the curl in Component 5)
→ test through the UI (`npm run dev`, ask a question in the browser, see it stream with
clickable citations) → commit → move to Phase 2.

No grader run yet. `benchmark/bench.mjs` and `eval/eval.mjs` expect memory, RAG, and run logs
that don't exist until later phases; running them now just fails on missing pieces. Phase 1's
acceptance test is the curl output above and the UI lighting up for the quick web-search path.
