/**
 * LUMINA agent service — the AI backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 * This is where the real work is. Provider keys live only in this process.
 *
 * What is already here: the server, /health (Mongo ping + which model, provider and
 * vector backend are live), and a 501 for every other route.
 *
 * What you build (README Part 1, in this order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index),
 *      key = sha256(normalized query + provider). searchCached only when every hit.
 *   3. threads + messages, so a follow-up sees the thread.
 *   4. memory: save_memory / recall_memory over the memories vector index; GET /memory,
 *      DELETE /memory/:id.
 *   5. the run log: one runs/<requestId>.json per answer, in the RunLog shape from the
 *      contract. Ten lines. The gates read it, so it is not optional.
 *   6. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   7. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   8. DEEP search (depth: "deep"): plan_research decomposes the question into 3–6
 *      sub-questions, you stream a `plan` event BEFORE retrieving anything, research each
 *      sub-question, then merge the results into ONE citation numbering and synthesise.
 *      Every trace step and every source carries the subQuestion it served. Deep runs
 *      under the wider caps (maxToolCallsDeep, maxWallClockSecDeep) and behind
 *      DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *     Never a try/catch that returns a plausible answer. (Live Translate served English
 *     for weeks because of exactly that catch.)
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research,
 *     however much the model would like to. Deep costs several times more, and a product
 *     that escalates itself is a product with an unbounded bill.
 */
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { ZodError } from 'zod';
import {
  ACCEPTED_UPLOAD_TYPES,
  AskBody,
  CreateSpaceBody,
  CreateSpaceResponse,
  CreateThreadBody,
  CreateThreadResponse,
  HealthResponse,
  ListDocumentsResponse,
  ListMemoryResponse,
  ListSpacesResponse,
  ListThreadsResponse,
  MAX_UPLOAD_BYTES,
  REQUEST_HEADER,
  ROUTES,
  StatsResponse,
  USER_HEADER,
  UploadDocumentResponse,
  newId
} from '@lumina/contract';
import { env } from './env.js';
import { pingDb } from './db.js';
import { requestsCollection } from './collections.js';
import { createThread, getThread, listThreads, appendMessage, getRecentHistory, promoteThreadTitle } from './threads.js';
import { handleQuickAsk } from './ask.js';
import { buildStats } from './stats.js';
import { listMemories, deleteMemory } from './memories.js';
import { createSpace, getSpace, listSpaces } from './spaces.js';
import { acceptUpload, listDocuments, resolveUploadType } from './documents.js';

const log = pino({ level: env.logLevel });
const app = express();

/** Every route but /health requires X-User-Id (PRD 7). 401 without it. */
function requireUserId(req: express.Request, res: express.Response): string | undefined {
  const userId = req.header(USER_HEADER);
  if (!userId) {
    res.status(401).json({ error: `missing ${USER_HEADER} header`, status: 401 });
    return undefined;
  }
  return userId;
}

app.disable('x-powered-by');

// TEMP-002's CORS shim (Phase 1 manual UI testing) is deleted as of Phase 3 Component 9:
// the gateway is now the only thing that talks CORS (AGENTS.md — "the browser talks ONLY
// to the gateway"), and this service is no longer meant to be browser-reachable at all.

/**
 * D3 (Phase 3 Component 5): adopt the inbound `X-Request-Id` only if it is acceptable —
 * this id becomes a filename (`runs/<id>.json`), and the contract's `RequestId` is only
 * `z.string().min(1)`, so the contract offers no protection against a traversal payload
 * like `../../etc/foo`. Same defence-in-depth posture as `requireUserId` below: the
 * gateway (Component 6) already generates-on-reject, but this service must not be
 * exploitable if it is ever reached directly.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

app.use((req, res, next) => {
  const started = Date.now();
  const inbound = req.header(REQUEST_HEADER);
  const requestId = inbound && REQUEST_ID_RE.test(inbound) ? inbound : newId('req');
  if (inbound && requestId !== inbound) {
    log.warn({ rejected: inbound }, 'rejected unacceptable inbound X-Request-Id; generated a fresh one');
  }
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_HEADER, requestId);

  // Component 5: one `requests` row per request this service handles, on every route —
  // not only asks (RequestDoc's ask-only fields are all `.optional()`; `route`/`status`/
  // `ms` are required — see phase-3.md's evidence). A request with no X-User-Id (just
  // /health, in practice) never gets one: RequestDoc.userId is required, and a health
  // probe isn't a meaningful observability target anyway.
  res.on('finish', () => {
    const userId = req.header(USER_HEADER);
    if (!userId) return;
    requestsCollection()
      .then((col) =>
        col.updateOne(
          { requestId },
          {
            $setOnInsert: { requestId, createdAt: new Date().toISOString() },
            $set: { userId, route: req.path, status: res.statusCode, ms: Date.now() - started }
          },
          { upsert: true }
        )
      )
      .catch((err) => log.error({ err, requestId }, 'failed to record requests row'));
  });

  next();
});

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- threads (implemented)

app.post('/threads', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const body = CreateThreadBody.parse(req.body ?? {});
    const threadId = await createThread(userId, body.title);
    const response: CreateThreadResponse = { threadId };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/threads', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const threads = await listThreads(userId);
    const response: ListThreadsResponse = { threads };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/threads/:threadId', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const thread = await getThread(req.params.threadId, userId);
    if (!thread) {
      res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
      return;
    }
    res.status(200).json(thread);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- ask (implemented, quick only)

app.post('/threads/:threadId/ask', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const body = AskBody.parse(req.body ?? {});

    // depth "deep" needs the planner (Phase 7). Reject before the stream starts, while a
    // normal status code is still possible.
    if (body.depth === 'deep') {
      res.status(501).json({ error: 'depth "deep" not implemented yet (Phase 7: Deep Research)', status: 501 });
      return;
    }

    // Phase 5 D17: a docs ask is scoped to one Space, and both failure modes must be settled
    // BEFORE the SSE stream opens — once headers are sent, a 400 or 404 is no longer
    // expressible and the only honest option left is an `error` event.
    if (body.mode === 'docs' && !body.spaceId) {
      res.status(400).json({ error: 'mode "docs" requires a spaceId', status: 400 });
      return;
    }

    let spaceId: string | undefined;
    if (body.mode === 'docs' && body.spaceId) {
      // Ownership, not existence (D1/D20): a foreign Space is indistinguishable from an
      // absent one, so neither the status nor the body reveals which.
      const space = await getSpace(userId, body.spaceId);
      if (!space) {
        res.status(404).json({ error: `no space ${body.spaceId}`, status: 404 });
        return;
      }
      spaceId = space._id;
    }

    const thread = await getThread(req.params.threadId, userId);
    if (!thread) {
      res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
      return;
    }

    // Read prior turns BEFORE writing this one (Phase 3 D6): a snapshot taken before the
    // write provably cannot contain the current message, with no reliance on sort-tie
    // breaking between two writes in the same millisecond.
    const history = await getRecentHistory(req.params.threadId, userId);
    await appendMessage(req.params.threadId, userId, { role: 'user', content: body.query });
    await promoteThreadTitle(req.params.threadId, userId, body.query);
    await handleQuickAsk({
      threadId: req.params.threadId,
      userId,
      query: body.query,
      priorTurns: history,
      requestId: String(res.locals.requestId),
      mode: body.mode,
      spaceId,
      res,
      log
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- memory (implemented)

app.get('/memory', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const memories = await listMemories(userId);
    const response: ListMemoryResponse = ListMemoryResponse.parse({ memories });
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * D4: unconditional, idempotent 204 after auth — regardless of whether a row matching
 * `{_id, userId}` existed. Never a 404. Deliberate and counterintuitive; see phase-4.md
 * D4 for the full evidence (SPEC.md's status line omits memory from 404's resources,
 * web/'s api.ts throws on any non-2xx, and bench.mjs's cap() overwrite means one 404 here
 * would retroactively fail all three memory checks). A malformed or foreign id just means
 * `deleteOne` matches nothing — still 204, nothing deleted.
 */
app.delete('/memory/:memoryId', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    await deleteMemory(userId, req.params.memoryId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- spaces & documents (Phase 5)

app.post('/spaces', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const body = CreateSpaceBody.parse(req.body ?? {});
    const space = await createSpace(userId, body.name);
    const response: CreateSpaceResponse = CreateSpaceResponse.parse(space);
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/spaces', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const response: ListSpacesResponse = ListSpacesResponse.parse({ spaces: await listSpaces(userId) });
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * D4: multer with a hard `fileSize` limit is the actual protection — not a post-hoc size
 * check, which would mean buffering an arbitrarily large body in memory first. `memoryStorage`
 * is right here because the file goes straight into GridFS and is never touched on disk.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

/**
 * D4: multer's errors must be mapped HERE. Left to propagate they reach the final error
 * handler below, which maps anything unrecognised to `502` — so an over-size upload would
 * answer `502` instead of the contract's `413`.
 */
function runUpload(req: express.Request, res: express.Response): Promise<boolean> {
  return new Promise((resolve) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return resolve(true);
      if (err instanceof multer.MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `file too large: the limit is ${MAX_UPLOAD_BYTES} bytes`
            : `invalid upload: ${err.message}`;
        res.status(status).json({ error: message, status });
        return resolve(false);
      }
      res.status(400).json({ error: `invalid upload: ${(err as Error).message}`, status: 400 });
      resolve(false);
    });
  });
}

/**
 * The whole request is: validate → verify Space → store → two rows → 202. Nothing is parsed,
 * chunked, embedded or retrieved here (D2/AGENTS.md — a synchronous parse-then-respond
 * endpoint fails the assignment even when it works).
 *
 * The body is consumed FIRST, before the Space check, so a rejected upload is never a status
 * code written while the client is still sending: an agent that answers mid-stream makes the
 * gateway see a socket error instead of the status, which is how a clean `404` turns into a
 * `502`. The one unavoidable exception is the over-size case, where aborting early is the
 * entire point of the limit.
 */
app.post('/spaces/:spaceId/documents', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    // The Space lookup needs only the URL param, so it runs CONCURRENTLY with multipart
    // parsing instead of after it — one fewer sequential Atlas round trip on a path with a
    // declared 300 ms p95 budget, and measurably the difference between 305 ms and 270 ms
    // (GAP-024). Safe because it is a read: no bytes are written for a Space that turns out
    // not to exist, so this is not the storage-amplification trade that overlapping the
    // GridFS write would have been.
    //
    // Both are awaited before anything is decided, and the parse is still checked FIRST, so
    // the body is always fully consumed before any status is written (see the note above).
    const spacePromise = getSpace(userId, req.params.spaceId);
    // A rejected lookup must not become an unhandled rejection if the parse fails first.
    spacePromise.catch(() => undefined);

    if (!(await runUpload(req, res))) return;

    const space = await spacePromise;
    if (!space) {
      res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'missing multipart "file" part', status: 400 });
      return;
    }

    // Declared type first, extension only as a documented fallback — see `resolveUploadType`
    // for why a declared-type-only check breaks the provided UI.
    const resolved = resolveUploadType(file.mimetype, file.originalname ?? '', ACCEPTED_UPLOAD_TYPES);
    if (!resolved) {
      res.status(400).json({
        error:
          `unsupported content type "${file.mimetype || 'none'}" for "${file.originalname ?? ''}": ` +
          `accepted types are ${ACCEPTED_UPLOAD_TYPES.join(', ')}`,
        status: 400
      });
      return;
    }
    const mimeType = resolved.mimeType;

    if (file.size > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: `file too large: the limit is ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
      return;
    }
    if (file.size === 0) {
      res.status(400).json({ error: 'uploaded file is empty', status: 400 });
      return;
    }

    const { docId } = await acceptUpload({
      userId,
      spaceId: req.params.spaceId,
      filename: file.originalname || 'upload',
      mimeType,
      bytes: file.buffer
    });

    const response: UploadDocumentResponse = UploadDocumentResponse.parse({ docId, status: 'pending' });
    res.status(202).json(response);
  } catch (err) {
    // A failed durable accept is a loud failure, never a fake 202 (D2). `acceptUpload` has
    // already rolled back whatever it managed to write.
    next(err);
  }
});

app.get('/spaces/:spaceId/documents', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const space = await getSpace(userId, req.params.spaceId);
    if (!space) {
      res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });
      return;
    }

    const response: ListDocumentsResponse = ListDocumentsResponse.parse({
      documents: await listDocuments(userId, req.params.spaceId)
    });
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- stats (implemented)

app.get('/stats', async (req, res, next) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const stats: StatsResponse = await buildStats(userId);
    res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- everything else: 501

const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({ error: `not implemented yet: ${route}. Build it in backend/agent/src/.`, status: 501 });
};

const BUILT_ROUTES = new Set([
  'GET /health',
  'GET /evals/report.json',
  'POST /threads',
  'GET /threads',
  'GET /threads/:threadId',
  'POST /threads/:threadId/ask',
  'GET /memory',
  'DELETE /memory/:memoryId',
  'GET /stats',
  'POST /spaces',
  'GET /spaces',
  'POST /spaces/:spaceId/documents',
  'GET /spaces/:spaceId/documents'
]);

for (const route of ROUTES) {
  if (BUILT_ROUTES.has(`${route.method} ${route.path}`)) continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => i.message).join('; '), status: 400 });
    return;
  }
  // Fail loud: any other thrown error (DB, provider, unexpected) is a 502, never a
  // swallowed exception dressed up as a plausible response.
  log.error({ err }, 'agent error');
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up — every route but /health returns 501 until you build it'
  );
});
