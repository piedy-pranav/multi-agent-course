/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * What is already here: the server, CORS, the request id, the pino request log, /health
 * (which nests the agent service's health), a 501 for every contract route, and the
 * static hosting of web/dist. That is deliberately the boring half.
 *
 * What you build (backend/gateway/, see README Part 2):
 *   1. X-User-Id enforcement           → 401 without it, on every route but /health
 *   2. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   3. a per-user rate limit           → 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   5. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';
import { proxyToAgent, proxyAskStream, proxyUpload } from './proxy.js';
import { validateBody } from './validate.js';
import { rateLimit } from './rateLimit.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

/**
 * D3 (Component 6): adopt the inbound `X-Request-Id` only if it is acceptable. This id
 * becomes a filename on the agent side (`runs/<id>.json`), and the contract's `RequestId`
 * is only `z.string().min(1)` — a header of `../../etc/foo` would be a path traversal the
 * contract does nothing to stop. An unacceptable id is never a `400`: a caller may not
 * control that header (a corporate proxy, a platform's own router), so it is logged once
 * and silently replaced — correlation stays exact because nothing downstream ever sees
 * the rejected value.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

app.use((req, res, next) => {
  const inbound = req.header(REQUEST_HEADER);
  const id = inbound && REQUEST_ID_RE.test(inbound) ? inbound : `req_${randomUUID().slice(0, 12)}`;
  if (inbound && id !== inbound) {
    log.warn({ rejected: inbound }, 'rejected unacceptable inbound X-Request-Id; generated a fresh one');
  }
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
);

/**
 * D2/Component 6: auth BEFORE body parsing, so the two 4xx cases are unambiguous —
 * missing `X-User-Id` is always `401`, regardless of whether the body is valid JSON;
 * malformed JSON with a valid `X-User-Id` is `400` (BUG-007, below), never `502`.
 * `/health` and `GET /evals/report.json` are the only routes with no `X-User-Id`
 * requirement (`ROUTES[].auth`).
 */
const AUTH_EXEMPT_PATHS = new Set<string>(ROUTES.filter((r) => !r.auth).map((r) => r.path));

app.use((req, res, next) => {
  if (AUTH_EXEMPT_PATHS.has(req.path)) return next();
  const userId = req.header(USER_HEADER);
  if (!userId) {
    res.status(401).json({ error: `missing ${USER_HEADER} header`, status: 401, requestId: String(res.locals.requestId) });
    return;
  }
  next();
});

// Component 8: a per-user rate limit, BEFORE body parsing, so an abusive client's
// malformed bodies still consume quota.
app.use(rateLimit());

// JSON everywhere except the multipart upload route, which your handler owns.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- proxy to the agent (implemented)

/**
 * D1: replace the 501 loop only for routes the agent actually implements. Everything else
 * stays 501 from both services this phase (RAG, memory, spaces, deep search — later
 * phases). `/threads/:threadId/ask` gets the Component 7 streaming forwarder — the one
 * deliberate exception to the generic (buffered) `proxyToAgent`.
 */
app.post('/threads', validateBody(CreateThreadBody), proxyToAgent());
app.get('/threads', proxyToAgent());
app.get('/threads/:threadId', proxyToAgent());
app.get('/stats', proxyToAgent());
app.post('/threads/:threadId/ask', validateBody(AskBody), proxyAskStream());
// Phase 4 C6: both bodyless (GET has none, DELETE's generic forwarder sets hasBody=false
// for DELETE — proxy.ts:25), so the generic proxyToAgent() needs no streaming/validation
// wrapper here, same as /threads/:threadId above.
app.get('/memory', proxyToAgent());
app.delete('/memory/:memoryId', proxyToAgent());
// Phase 5 C4. Only the upload needs special handling (multipart, D3); the other three are
// ordinary JSON/bodyless routes the generic forwarder already covers.
app.post('/spaces', validateBody(CreateSpaceBody), proxyToAgent());
app.get('/spaces', proxyToAgent());
app.post('/spaces/:spaceId/documents', proxyUpload());
app.get('/spaces/:spaceId/documents', proxyToAgent());

// ---------------------------------------------------------------- everything else: 501

/**
 * Every contract route answers 501 until you implement it. The UI renders that as
 * "not implemented yet", so the interface is your progress bar: each route you finish
 * lights up a piece of the product.
 */
const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({
    error: `not implemented yet: ${route}. Build it in backend/gateway/src/.`,
    status: 501,
    requestId: String(res.locals.requestId)
  });
};

const BUILT_ROUTES = new Set([
  'POST /threads',
  'GET /threads',
  'GET /threads/:threadId',
  'GET /stats',
  'POST /threads/:threadId/ask',
  'GET /memory',
  'DELETE /memory/:memoryId',
  'POST /spaces',
  'GET /spaces',
  'POST /spaces/:spaceId/documents',
  'GET /spaces/:spaceId/documents'
]);

for (const route of ROUTES) {
  if (route.path === '/health') continue;
  if (BUILT_ROUTES.has(`${route.method} ${route.path}`)) continue;
  const path = route.path.replace(/:(\w+)/g, ':$1');
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](path, notImplemented(`${route.method} ${route.path}`));
}

// ---------------------------------------------------------------- static UI

// In production the gateway serves the built UI, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

/**
 * BUG-007: `express.json` throws a `SyntaxError` carrying `status: 400` on malformed JSON
 * (and a body over the 1mb limit with `status: 413`), but mapping every `Error` straight
 * to `502` — a status the contract reserves for upstream provider failure — turned a
 * client mistake into a lie about the agent being down. Honour a thrown error's own
 * 4xx `status`/`statusCode`; fall through to `502` only for a genuinely unknown error
 * (rule A1: still never a `200` with a plausible body).
 */
app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = String(res.locals.requestId);
  const status = err.status ?? err.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const message = err.type === 'entity.too.large' ? 'request body too large' : err.message;
    res.status(status).json({ error: message, status, requestId });
    return;
  }
  log.error({ err, requestId }, 'gateway error');
  res.status(502).json({ error: err.message, status: 502, requestId });
});

app.listen(env.port, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up — every route but /health returns 501 until you build it'
  );
});
