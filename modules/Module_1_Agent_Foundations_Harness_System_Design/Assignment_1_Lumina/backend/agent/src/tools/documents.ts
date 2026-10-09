import type { ToolDefinition } from './registry.js';
import { searchDocuments } from '../retrieval/docSearch.js';

/**
 * Phase 5 C10 / D15: `search_documents`.
 *
 * The model's input is a query and NOTHING ELSE. `userId` and `spaceId` arrive through
 * `ToolExecContext`, never as tool arguments — a model that could name a Space id could name
 * someone else's, and no amount of prompting makes that safe. Tenancy is the harness's to
 * decide, which is the same reasoning that keeps `plan_research` out of a quick run's toolset
 * rather than merely asking the model not to call it.
 */
export const searchDocumentsTool: ToolDefinition = {
  name: 'search_documents',
  description:
    "Search the user's uploaded documents in the current Space for passages relevant to a query. " +
    'Returns the passage text with the document title and its page or heading, which can be cited directly. ' +
    'Use it with the specific wording you want to find; it searches both meaning and exact terms.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for in the documents.' }
    },
    required: ['query'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const query = input.query;
    if (typeof query !== 'string' || !query.trim()) {
      throw new Error('search_documents requires a non-empty "query" string');
    }
    // Absent scope is a harness bug, not a model mistake — and it must never silently become
    // an unscoped search across every Space.
    if (!ctx?.userId) throw new Error('search_documents has no userId in context');
    if (!ctx?.spaceId) throw new Error('search_documents has no spaceId in context');

    const result = await searchDocuments({
      userId: ctx.userId,
      spaceId: ctx.spaceId,
      query,
      signal: ctx.signal
    });

    ctx.onEmbeddingUsage?.(result.embeddingTokens);
    ctx.onDocHits?.(result);

    // What the MODEL sees. No embeddings, no chunk ids, no userId/spaceId — just the passage
    // and enough provenance to cite it. An empty list here is a legitimate `ok:true` result
    // (the Space may hold nothing relevant), which the caller must be able to tell apart from
    // a failure — hence the throws above rather than an empty return.
    return {
      indexedDocuments: result.indexedDocs,
      results: result.hits.map((h) => ({
        docId: h.docId,
        title: h.title,
        locator: h.locator,
        text: h.text
      }))
    };
  }
};
