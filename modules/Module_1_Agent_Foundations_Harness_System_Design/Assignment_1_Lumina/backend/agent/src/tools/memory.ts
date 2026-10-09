import { recallMemories, saveMemory } from '../memories.js';
import type { ToolDefinition } from './registry.js';

/**
 * The model-elected memory tools (plan D6/D8). The deterministic recall pre-flight
 * (`loop.ts#runMemoryPreflight`) and the explicit-save backstop (`loop.ts#runSaveBackstop`)
 * call `recallMemories`/`saveMemory` directly rather than through these — they run before
 * (or outside) any model turn, so there is no `tool_use` block to attach a result to. These
 * definitions are what lets the model itself call `recall_memory`/`save_memory` again mid
 * gather-loop, exactly like `web_search`/`fetch_page`.
 */

export const recallMemoryTool: ToolDefinition = {
  name: 'recall_memory',
  description:
    'Recall previously saved facts or preferences about this user that might be relevant to answering right now. ' +
    'Memory is context for how to answer (style, standing preferences, known facts about the user) — it is never ' +
    'a citation source and must never be cited with [n].',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search the user\'s stored memories for.' }
    },
    required: ['query'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const userId = ctx?.userId;
    if (!userId) throw new Error('recall_memory requires a userId in the tool execution context');
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw new Error('recall_memory requires a non-empty "query" string');

    const result = await recallMemories(userId, query, ctx?.signal);
    ctx?.onEmbeddingUsage?.(result.tokens);
    return result.memories.map((m) => ({ text: m.text, createdAt: m.createdAt }));
  }
};

export const saveMemoryTool: ToolDefinition = {
  name: 'save_memory',
  description:
    'Save a stable fact or preference about this user that should be remembered and affect future answers in ' +
    'later threads. Use this only when the user explicitly asked to be remembered, or stated a durable standing ' +
    'preference — never to auto-harvest trivia from the answer you are about to give.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The fact or preference to remember, written as a standalone statement.' }
    },
    required: ['text'],
    additionalProperties: false
  },
  async execute(input, ctx) {
    const userId = ctx?.userId;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    try {
      if (!userId) throw new Error('save_memory requires a userId in the tool execution context');
      if (!text) throw new Error('save_memory requires a non-empty "text" string');

      const result = await saveMemory(userId, text, ctx?.threadId, ctx?.signal);
      ctx?.onEmbeddingUsage?.(result.tokens);
      ctx?.onMemoryWrite?.({ text, ok: true });
      return { id: result.id, saved: true };
    } catch (err) {
      const error = (err as Error).message;
      ctx?.onMemoryWrite?.({ text: text || '(no text given)', ok: false, error });
      throw err;
    }
  }
};
