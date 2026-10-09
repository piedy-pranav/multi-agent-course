import { createHash } from 'node:crypto';
import pino from 'pino';
import type { SearchCacheDoc } from '@lumina/contract';
import { env } from '../env.js';
import { searchCacheCollection } from '../collections.js';
import type { WebSearchResult } from '../tools/webSearch.js';

const log = pino({ level: env.logLevel });

/**
 * Two-tier search cache (Phase 3 plan D5/Component 4): an in-process LRU in front of the
 * Mongo `searchCache` TTL collection. Key = sha256(normalized query + '\0' + provider) —
 * the `web_search` TOOL INPUT (the model's own search string), never the user's raw
 * question, per D5. Only `web_search` results are cached — never answers, never fetched
 * pages (SPEC.md: "answers are always regenerated so freshness is never served stale").
 */

interface LruEntry {
  results: WebSearchResult[];
  expiresAt: number;
}

/** A plain Map preserves insertion order, which is the entire LRU implementation: a hit
 * deletes-then-resets its key (moves it to MRU); eviction drops `map.keys().next()` (LRU). */
const lru = new Map<string, LruEntry>();

function normalize(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cacheKey(query: string, provider: string): string {
  return createHash('sha256').update(`${normalize(query)}\0${provider}`).digest('hex');
}

function lruTouch(key: string, entry: LruEntry): void {
  lru.delete(key);
  lru.set(key, entry);
}

function lruSet(key: string, results: WebSearchResult[], ttlMs: number): void {
  if (!lru.has(key) && lru.size >= env.searchCacheLruMax) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
  lru.set(key, { results, expiresAt: Date.now() + ttlMs });
}

/**
 * `null` means "not cached, go ask the provider" — for a cold LRU, an expired LRU entry,
 * an actual Mongo miss, an expired-but-unswept Mongo row (D5: Mongo's TTL sweeper runs
 * ~once a minute, so check `expiresAt` in code too), or a Mongo read failure. The last one
 * is deliberate: the cache is non-authoritative (DESIGN.md Q4), so a read failure must
 * degrade to a provider call plus a log line, never to a thrown error and never silently
 * presented as an empty result (that distinction matters — rule A1).
 */
export async function getCached(query: string, provider: string): Promise<WebSearchResult[] | null> {
  const key = cacheKey(query, provider);
  const now = Date.now();

  const hit = lru.get(key);
  if (hit) {
    if (hit.expiresAt > now) {
      lruTouch(key, hit);
      return hit.results;
    }
    lru.delete(key);
  }

  try {
    const row = await (await searchCacheCollection<SearchCacheDoc>()).findOne({ _id: key });
    if (!row) return null;
    const expiresAtMs = new Date(row.expiresAt as unknown as string).getTime();
    if (expiresAtMs <= now) return null;
    const results = row.results as unknown as WebSearchResult[];
    lruSet(key, results, expiresAtMs - now);
    return results;
  } catch (err) {
    log.error({ err, provider }, 'search cache read failed — falling through to a live provider call');
    return null;
  }
}

/** Write-through on a miss. A failed Mongo write just means tier 2 stays cold for this
 * query — tier 1 still gets it, and the request's own answer is unaffected either way. */
export async function setCached(
  query: string,
  provider: 'tavily' | 'serpapi',
  results: WebSearchResult[]
): Promise<void> {
  const key = cacheKey(query, provider);
  const ttlMs = env.searchCacheTtlSeconds * 1000;
  lruSet(key, results, ttlMs);

  const now = new Date();
  const doc: SearchCacheDoc = {
    _id: key,
    provider,
    query,
    results: results as unknown as Record<string, unknown>[],
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    createdAt: now.toISOString()
  };
  try {
    await (await searchCacheCollection<SearchCacheDoc>()).replaceOne({ _id: key }, doc, { upsert: true });
  } catch (err) {
    log.error({ err, provider }, 'search cache write-through failed — this query will miss again next time');
  }
}
