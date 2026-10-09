import type { Locator } from '@lumina/contract';
import { env, secrets } from './env.js';

export interface SynthesisSource {
  n: number;
  title: string;
  url: string;
  text: string;
}

// Matches benchmark/sla.json's cost_model for claude-sonnet-5. Keep in sync if the model
// or its published pricing changes — the bench's cost gate reads the same numbers.
const INPUT_USD_PER_MTOK = 3.0;
const OUTPUT_USD_PER_MTOK = 15.0;

// ---- Agent loop turns (Phase 2): the model chooses tools instead of following a fixed
// pipeline. These share the same /v1/messages endpoint and cost model, but carry a real
// multi-turn history and a tool manifest. ----

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolManifestEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentTurnResult {
  stopReason: string;
  content: ContentBlock[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const GATHER_SYSTEM_PROMPT = `You are LUMINA's research step. Your only job right now is to decide what
information is needed to answer the user's question and go get it using the tools provided.

IMPORTANT: a web_search result is a SNIPPET, not evidence. The final answer can only cite a
page you actually fetched with fetch_page — search results alone are never citable. If you stop
calling tools after only searching and never fetching a page, the final answer will have ZERO
sources available and will have to say so, even if the search results looked relevant. So: after
a search, fetch_page at least one of the most relevant results before you consider yourself
done, unless the question plainly needs no sourcing at all (e.g. a greeting).

EXCEPTION — a pure save request: if the user's entire message is an explicit instruction to
remember or save a fact/preference about them for later (e.g. "remember that I prefer X",
"from now on, always Y"), and it is not also asking a question that needs researching, you may
finish after calling save_memory alone (recall_memory may still run first, as usual) — do NOT
call web_search or fetch_page for a message like this, and zero sources is the correct, expected
outcome. This exception is about what the message IS (an instruction to remember), never about
whether a word like "remember" appears in it: a question that merely mentions remembering —
"do people still remember the 2008 crash?", "what should I remember about RRF?" — is an ordinary
research question and must still be fetched and sourced like any other.

A recall_memory result is CONTEXT about this user's standing preferences and known facts, never
evidence — it must never be cited as a source, however it influences how you answer.

Call tools until you have enough FETCHED evidence to answer (or, for a pure save request, until
save_memory has run), then stop calling tools — do not write the answer yourself here, it is
produced in a separate step from what you gathered. Do not pad with unnecessary tool calls once
you have enough: the loop is bounded by cost and time.`;

/**
 * Phase 5 D17b: the docs-only variant.
 *
 * The web prompt above is deliberately NOT reused. It states that only a `fetch_page` result
 * is citable evidence and instructs the model to fetch after searching — the BUG-010 fix,
 * correct and necessary for web mode. In docs mode there is no `fetch_page` and no
 * `web_search`: a `search_documents` result IS the evidence, because the passage it returns
 * is the indexed chunk itself. A model following the web prompt here would either refuse for
 * want of a fetch it cannot perform, or keep searching looking for one.
 */
const GATHER_DOCS_SYSTEM_PROMPT = `You are LUMINA's research step, working ONLY from the user's
own uploaded documents in the current Space. You have no web access in this mode.

A search_documents result IS citable evidence: each result is the actual indexed passage from
the user's document, with its title and its page or heading. There is nothing to fetch and no
page to open — the passage in front of you is the source. This is the opposite of web research,
where a search result is only a snippet.

A relevant document search has already been run for you with the user's question, and its
results are in this conversation. Read them first. Call search_documents again only if they do
not cover the question and different wording would plausibly find more — a synonym the document
might use, a narrower phrase, a specific term from the question. Do not re-run the same query.

If the documents simply do not contain the answer, stop searching and say so in the final step.
An honest "the documents do not cover this" is correct and expected; inventing a passage, a
page number, or a document is a hard failure. Never answer from your own background knowledge
in this mode — if it is not in the retrieved passages, it is not available to cite.

A recall_memory result is CONTEXT about this user's standing preferences and known facts, never
evidence — it must never be cited as a source.

Stop calling tools once the retrieved passages are enough to answer, then stop — do not write
the answer yourself here, it is produced in a separate step from what you gathered.`;

/**
 * One turn of the agent loop: send the history plus the depth-filtered tool manifest, let
 * the model decide whether to call a tool or stop. Non-streaming — a gather turn's own text
 * (if any) is discarded by the caller, so there is nothing worth streaming here; only the
 * pinned final answer turn streams.
 */
export async function callAgentTurn(
  history: AgentMessage[],
  tools: ToolManifestEntry[],
  opts: {
    toolChoice: 'auto' | 'none';
    maxTokens?: number;
    signal?: AbortSignal;
    /** Phase 5 D17b: which gather prompt applies. The web prompt tells the model that only a
     * `fetch_page` result is citable — true for web, actively wrong for documents, where
     * there is no `fetch_page` at all. */
    gatherMode?: 'web' | 'docs';
  }
): Promise<AgentTurnResult> {
  if (!secrets.anthropic) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': secrets.anthropic,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: env.llmModel,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.gatherMode === 'docs' ? GATHER_DOCS_SYSTEM_PROMPT : GATHER_SYSTEM_PROMPT,
      messages: history,
      tools,
      tool_choice: { type: opts.toolChoice }
    })
  });

  if (!res.ok) {
    throw new Error(`anthropic messages (agent turn) ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    content?: ContentBlock[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const tokensIn = body.usage?.input_tokens ?? 0;
  const tokensOut = body.usage?.output_tokens ?? 0;
  const costUsd = (tokensIn / 1_000_000) * INPUT_USD_PER_MTOK + (tokensOut / 1_000_000) * OUTPUT_USD_PER_MTOK;

  return {
    stopReason: body.stop_reason ?? 'end_turn',
    content: body.content ?? [],
    tokensIn,
    tokensOut,
    costUsd
  };
}

export interface StreamUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const FINAL_SYSTEM_PROMPT = `You are LUMINA, a cited-answer search assistant. You just finished
researching the user's question using the tools available to you earlier in this conversation.
You cannot call any more tools now — this is the final answer.

Answer using ONLY the numbered sources listed in the final message below. For every claim, cite
the source it came from with [n], matching the source's number EXACTLY as given. Use multiple
citations [1][2] if a claim draws on more than one source. Do not cite a source you did not use,
and never invent, guess, or reuse a source number that is not in the exact list given to you —
the final message tells you precisely how many sources exist and their numbers; citing anything
outside that range is a hard failure, worse than citing nothing.

If no sources are listed, or they do not contain enough information to answer, say so plainly
and cite nothing — do not fabricate a citation, a URL, or a fact.

Any recalled memory you saw earlier (the user's stored preferences/facts) is CONTEXT for how to
answer — tone, language, standing facts about the user — never a citable source. Do not cite it
with [n]. If a "Memory write status" note appears in the final message below, report what it
says plainly as part of your answer (e.g. confirm what was saved, or say plainly that a save
failed) — do not infer this from anything else, and do not claim something was saved if the note
says it failed.`;

/**
 * Phase 5 D17b: a web source is cited by URL, a document source by filename and page. `url`
 * is optional because a doc source has none, and `docId`/`locator` are optional because a web
 * source has none — the caller builds one shape or the other from its `Evidence`.
 */
export interface FinalSource {
  n: number;
  title: string;
  text: string;
  url?: string;
  docId?: string;
  locator?: Locator;
}

/** `board-deck.pdf, p. 14` — the rendering SPEC §5.4 asks for, and what tells the model what
 * kind of thing it is citing. */
function describeSource(s: FinalSource): string {
  if (s.url) return `${s.title} (${s.url})`;
  const l = s.locator;
  const where =
    l?.page !== undefined ? `p. ${l.page}`
    : l?.heading !== undefined ? `"${l.heading}"`
    : l?.line !== undefined ? `line ${l.line}`
    : '';
  return where ? `${s.title}, ${where}` : s.title;
}

/** D9a's shape, defined here rather than imported from `run.ts` to avoid a dependency from
 * this module back onto run state — `run.ts`'s `MemoryWriteRecord` is structurally the same. */
export interface MemoryWriteNote {
  text: string;
  ok: boolean;
  error?: string;
}

/**
 * D9a: built from `RunState.memoryWrites`, never from model inference — a failed backstop
 * save (`loop.ts#runSaveBackstop`) produces no `tool_result` at all, so without this note
 * the final turn would have no way to know a save it can't see even attempted to happen.
 * Omitted entirely when nothing was written this request (the common case).
 */
function buildMemoryWriteNote(writes: MemoryWriteNote[]): string {
  if (writes.length === 0) return '';
  const lines = writes.map((w) =>
    w.ok
      ? `- SAVED: "${w.text}"`
      : `- FAILED to save "${w.text}": ${w.error ?? 'unknown error'}\n  State plainly that this was NOT saved.`
  );
  return `\n\nMemory write status:\n${lines.join('\n')}`;
}

function buildFinalSourcesMessage(
  sources: FinalSource[],
  partial: boolean,
  memoryWrites: MemoryWriteNote[] = []
): AgentMessage {
  const sourceBlock = sources.length
    ? sources.map((s) => `[${s.n}] ${describeSource(s)}\n${s.text}`).join('\n\n---\n\n')
    : '(no sources were successfully retrieved in this request)';
  const partialNote = partial
    ? '\n\nNote: research was stopped early because it hit a time or tool-call budget limit. ' +
      'Some sources that might have helped were not retrieved. Say this plainly in your answer ' +
      "rather than presenting it as a complete search — an honest partial answer, not a confident one.\n"
    : '';
  // Said once in the system prompt and again HERE, right next to the list itself, since
  // that's where the model is actually looking when it writes a citation — a model that
  // over-cites is reaching for a number that simply isn't on this list.
  const countNote =
    sources.length === 0
      ? 'There are 0 sources below. You may not write [1] or any other citation — cite nothing.'
      : `There are EXACTLY ${sources.length} source(s) below, numbered 1 through ${sources.length}. ` +
        `Do not cite any number outside [1]-[${sources.length}].`;
  // D9a: right next to the source-count note, the position BUG-010 proved effective — not
  // only in the system prompt, where it sits thousands of tokens above the actual write.
  const memoryNote = buildMemoryWriteNote(memoryWrites);
  return {
    role: 'user',
    content: [
      { type: 'text', text: `Write the final answer now.${partialNote}\n\n${countNote}${memoryNote}\n\nSources:\n\n${sourceBlock}` }
    ]
  };
}

/**
 * The pinned final turn (plan Component 4): continues the SAME conversation the gather loop
 * built — the model sees its own tool calls and results — but is structurally unable to call
 * a tool (`tool_choice: {type:'none'}`), so nothing can retrieve after the first streamed
 * token. `tools` stays present per the API's requirement when history already contains
 * tool_use/tool_result blocks. `onToken` fires per delta so the caller can forward real
 * `token` SSE events as they arrive.
 */
export async function streamFinalTurn(
  history: AgentMessage[],
  tools: ToolManifestEntry[],
  sources: FinalSource[],
  partial: boolean,
  onToken: (delta: string) => void,
  signal?: AbortSignal,
  memoryWrites: MemoryWriteNote[] = []
): Promise<StreamUsage> {
  if (!secrets.anthropic) throw new Error('ANTHROPIC_API_KEY is not set');

  const messages = [...history, buildFinalSourcesMessage(sources, partial, memoryWrites)];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': secrets.anthropic,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: env.llmModel,
      max_tokens: 1536,
      system: FINAL_SYSTEM_PROMPT,
      messages,
      tools,
      tool_choice: { type: 'none' },
      stream: true
    })
  });

  if (!res.ok) {
    throw new Error(`anthropic messages (final stream) ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (!res.body) throw new Error('anthropic messages (final stream): response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let sawText = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd: number;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      let eventType = '';
      let dataStr = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataStr += line.slice('data:'.length).trim();
      }
      if (!dataStr) continue;

      const data = JSON.parse(dataStr) as {
        type?: string;
        message?: { usage?: { input_tokens?: number } };
        delta?: { type?: string; text?: string };
        usage?: { output_tokens?: number };
        error?: unknown;
      };

      if (eventType === 'error' || data.type === 'error') {
        throw new Error(`anthropic stream error: ${JSON.stringify(data.error ?? data)}`);
      }
      if (eventType === 'message_start') {
        tokensIn = data.message?.usage?.input_tokens ?? tokensIn;
      } else if (eventType === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
        sawText = true;
        onToken(data.delta.text);
      } else if (eventType === 'message_delta') {
        tokensOut = data.usage?.output_tokens ?? tokensOut;
      }
    }
  }

  if (!sawText) throw new Error('anthropic stream returned no text content');

  const costUsd = (tokensIn / 1_000_000) * INPUT_USD_PER_MTOK + (tokensOut / 1_000_000) * OUTPUT_USD_PER_MTOK;
  return { tokensIn, tokensOut, costUsd };
}
