import { env, secrets } from './env.js';

export interface EmbedResult {
  embedding: number[];
  tokens: number;
}

// benchmark/sla.json's cost_model.embedding_usd_per_mtok for text-embedding-3-small. Keep
// in sync with that file if the model or its published pricing changes.
export const EMBEDDING_USD_PER_MTOK = 0.02;

/**
 * One call to OpenAI's embeddings endpoint, for one string or a batch. Fail loud: a missing
 * key, a non-2xx response, or a timeout all throw — never a zero-vector fallback standing in
 * for a real embedding. Bounded by a fixed timeout composed with the caller's own abort
 * signal, so a hanging provider cannot hang the request it was called from.
 *
 * Phase 5 D11 wants batching for ingestion without a second embedding implementation, so the
 * batch path is this same function, not a parallel one: same model, same dimension check,
 * same timeout, same failure behaviour.
 */
async function embedRequest(input: string | string[], signal?: AbortSignal): Promise<{ embeddings: number[][]; tokens: number }> {
  if (!secrets.openai) throw new Error('OPENAI_API_KEY is not set');

  const timeoutSignal = AbortSignal.timeout(env.embeddingTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    signal: combinedSignal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secrets.openai}`
    },
    body: JSON.stringify({ model: env.embeddingModel, input })
  });

  if (!res.ok) {
    throw new Error(`openai embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    data?: { embedding?: number[]; index?: number }[];
    usage?: { total_tokens?: number };
  };

  const expected = Array.isArray(input) ? input.length : 1;
  const rows = body.data ?? [];
  if (rows.length !== expected) {
    throw new Error(`openai embeddings: asked for ${expected} vector(s), got ${rows.length}`);
  }

  // The API documents `index` but does not promise ordering, and a silently mis-ordered
  // batch would attach every chunk's vector to the wrong chunk — retrieval would still
  // "work", just wrongly, which is the worst possible failure here. So order explicitly.
  const embeddings: number[][] = new Array(expected);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const at = row?.index ?? i;
    const embedding = row?.embedding;
    if (!Array.isArray(embedding) || embedding.some((v) => !Number.isFinite(v))) {
      throw new Error('openai embeddings: response did not contain a finite vector');
    }
    if (at < 0 || at >= expected) throw new Error(`openai embeddings: index ${at} out of range`);
    embeddings[at] = embedding;
  }
  if (embeddings.some((e) => !Array.isArray(e))) {
    throw new Error('openai embeddings: response left a gap in the batch');
  }

  return { embeddings, tokens: body.usage?.total_tokens ?? 0 };
}

export async function embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
  const { embeddings, tokens } = await embedRequest(text, signal);
  const embedding = embeddings[0];
  if (!embedding) throw new Error('openai embeddings: response did not contain a vector');
  return { embedding, tokens };
}

export interface EmbedBatchResult {
  embeddings: number[][];
  tokens: number;
}

/** Phase 5 C7: one request per batch of chunks, same client as `embed()` (D11). */
export async function embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbedBatchResult> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 };
  return embedRequest(texts, signal);
}
