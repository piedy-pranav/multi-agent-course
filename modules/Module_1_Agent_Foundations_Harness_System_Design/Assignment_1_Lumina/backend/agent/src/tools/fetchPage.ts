import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface FetchedPage {
  url: string;
  text: string;
}

/** Keeps one page from dominating the synthesis prompt's context budget. */
const MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches a URL and extracts its readable body text (@mozilla/readability + jsdom), so
 * synthesis works from what the page actually says, not a search snippet (PRD 5.2: Must).
 * Fail loud: a non-2xx, a timeout, or a page with no extractable content all throw. The
 * caller (the ask route) turns that into a visible trace step and, if unrecovered, a 502 —
 * never a silently empty page passed to the LLM as if it had been read.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // A plain Node UA gets blocked by some publishers; a browser-like one does not.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`fetch_page ${url} -> ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) {
    throw new Error(`fetch_page ${url} -> unsupported content-type "${contentType}"`);
  }

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  const text = (article?.textContent ?? dom.window.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();

  if (!text) {
    throw new Error(`fetch_page ${url} -> no extractable text`);
  }

  return { url, text: text.slice(0, MAX_CHARS) };
}
