import { AskTool, DEEP_ONLY_TOOLS, type AskMode, type Depth, type ToolName } from '@lumina/contract';
import { fetchPage } from './fetchPage.js';
import { webSearch } from './webSearch.js';
import { recallMemoryTool, saveMemoryTool } from './memory.js';
import { searchDocumentsTool } from './documents.js';
import type { MemoryWriteRecord } from '../run.js';
import type { DocSearchResult } from '../retrieval/docSearch.js';

/** Side-channel for a tool to report something back to the caller's `RunState` without
 * widening every tool's return type — the search cache's hit/miss (Component 4), and
 * (Phase 4) which user/thread a memory tool is scoped to, embedding spend, and the result
 * of a save attempt. Phase 5 adds the Space a document search is scoped to, and the hits it
 * produced, so the caller can turn them into this request's evidence. */
export interface ToolExecContext {
  onCacheResult?: (hit: boolean) => void;
  userId?: string;
  threadId?: string;
  /** Phase 5 D15: tenancy comes from here, never from the model's own tool arguments. */
  spaceId?: string;
  signal?: AbortSignal;
  onEmbeddingUsage?: (tokens: number) => void;
  onMemoryWrite?: (write: MemoryWriteRecord) => void;
  onDocHits?: (result: DocSearchResult) => void;
}

/** JSON Schema, as the provider's tool-use API expects — not a zod schema. */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx?: ToolExecContext): Promise<unknown>;
}

/**
 * One entry per tool the loop may call. `name` is drawn from the contract's `AskTool`
 * enum, never a free string, so a typo here fails at the zod parse rather than silently
 * never being invoked.
 */
const REGISTRY: Partial<Record<ToolName, ToolDefinition>> = {
  web_search: {
    name: 'web_search',
    description: 'Search the web for pages relevant to a query. Returns title, url, and snippet for each result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute(input, ctx) {
      const query = input.query;
      if (typeof query !== 'string' || !query.trim()) {
        throw new Error('web_search requires a non-empty "query" string');
      }
      return webSearch(query, undefined, ctx?.onCacheResult);
    }
  },
  fetch_page: {
    name: 'fetch_page',
    description: 'Fetch a URL and extract its readable article text, for use as evidence in the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' }
      },
      required: ['url'],
      additionalProperties: false
    },
    async execute(input) {
      const url = input.url;
      if (typeof url !== 'string' || !url.trim()) {
        throw new Error('fetch_page requires a non-empty "url" string');
      }
      return fetchPage(url);
    }
  },
  recall_memory: recallMemoryTool,
  save_memory: saveMemoryTool,
  search_documents: searchDocumentsTool
};

/** What a request is allowed to reach for. Resolved once, before the first model call. */
export interface ToolScope {
  depth: Depth;
  mode: AskMode;
  /** True only when a Space was resolved AND belongs to this user (D1). */
  hasSpace: boolean;
}

/**
 * Filters the toolset before the first model call. Structural, not prompted — this is the
 * guarantee behind red line R2, extended in Phase 5 to cover retrieval mode.
 *
 * Three rules, each closing a specific hole:
 *
 * 1. `plan_research` is deep-only. A quick run that reaches it has escalated itself into a
 *    run costing several times more (R2).
 * 2. `search_documents` requires `mode: "docs"` AND a resolved Space. Registering the tool
 *    without this would hand it to every quick run — including the bench's entire 40-query
 *    `mode:"web"` workload and the UI's default `mode:"auto"` — where it has no Space in
 *    context, throws, and burns one of quick's eight tool-call slots for nothing. Gating on
 *    `mode === 'docs'` (not merely on having a Space) also keeps `auto` behaving exactly as
 *    it did before this phase: routing is Phase 6's, and a tool quietly appearing in `auto`
 *    is routing by accident.
 * 3. The web tools are excluded under `mode: "docs"`, so a docs-only ask cannot answer from
 *    the open web and call it a document citation.
 */
export function toolsFor(scope: ToolScope): ToolDefinition[] {
  const deepOnly = new Set<string>(DEEP_ONLY_TOOLS);

  return AskTool.options
    .filter((name) => {
      if (deepOnly.has(name) && scope.depth !== 'deep') return false;
      if (name === 'search_documents') return scope.mode === 'docs' && scope.hasSpace;
      if (name === 'web_search' || name === 'fetch_page') return scope.mode !== 'docs';
      return true;
    })
    .map((name) => REGISTRY[name])
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}

export function getTool(name: ToolName): ToolDefinition | undefined {
  return REGISTRY[name];
}
