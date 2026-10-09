import { env, secrets } from '../env.js';
import { getCached, setCached } from '../cache/searchCache.js';

/** One organic result, normalized across providers. Not yet fetched — see fetchPage.ts. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_MAX_RESULTS = 5;

/**
 * `SEARCH_PROVIDER=tavily|serpapi`, swappable via env with no code change (AGENTS.md).
 * Phase 3 Component 4: the two-tier cache (`cache/searchCache.ts`) sits in front of the
 * provider dispatch below — a hit never touches the provider at all. `onCacheResult`, when
 * given, reports hit/miss back to the caller's `RunState` (`run.ts`'s `recordSearch`) so
 * `done.searchCached` can be honest instead of hardcoded. Fail loud on an actual provider
 * call: no try/catch here that turns a real failure into an empty result list.
 */
export async function webSearch(
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  onCacheResult?: (hit: boolean) => void
): Promise<WebSearchResult[]> {
  const cached = await getCached(query, env.searchProvider);
  if (cached) {
    onCacheResult?.(true);
    return cached;
  }

  const results = await dispatchSearch(query, maxResults);
  onCacheResult?.(false);
  await setCached(query, env.searchProvider, results);
  return results;
}

async function dispatchSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  switch (env.searchProvider) {
    case 'tavily':
      return tavilySearch(query, maxResults);
    case 'serpapi':
      return serpApiSearch(query, maxResults);
    default:
      throw new Error(`unknown SEARCH_PROVIDER: ${env.searchProvider}`);
  }
}

async function tavilySearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  if (!secrets.tavily) throw new Error('TAVILY_API_KEY is not set');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: secrets.tavily,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false
    })
  });

  if (!res.ok) {
    throw new Error(`tavily search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? 'untitled',
    url: r.url ?? '',
    snippet: r.content ?? ''
  }));
}

async function serpApiSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  if (!secrets.serpapi) throw new Error('SERPAPI_API_KEY is not set');

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(maxResults));
  url.searchParams.set('api_key', secrets.serpapi);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`serpapi search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    organic_results?: { title?: string; link?: string; snippet?: string }[];
  };
  return (body.organic_results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? r.link ?? 'untitled',
    url: r.link ?? '',
    snippet: r.snippet ?? ''
  }));
}
