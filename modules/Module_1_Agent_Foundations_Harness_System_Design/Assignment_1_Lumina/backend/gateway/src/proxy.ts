import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MAX_UPLOAD_BYTES, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { sseHeaders } from './sse.js';

/**
 * D1: ONE generic forwarder for every contract route — copy method, path, `X-User-Id`,
 * `X-Request-Id` and body to the agent, then copy status/content-type/body straight back.
 * Validation and rate limiting are middleware in FRONT of this, not re-implemented here.
 *
 * This is the non-streaming shape. The ask route is the one deliberate exception (D1):
 * SSE pass-through is Phase 3 Component 7, not built here.
 */
export function proxyToAgent() {
  return async (req: Request, res: Response) => {
    const requestId = String(res.locals.requestId);
    const url = `${env.agentUrl}${req.originalUrl}`;
    const headers: Record<string, string> = { [REQUEST_HEADER]: requestId };

    const userId = req.header(USER_HEADER);
    if (userId) headers[USER_HEADER] = userId;

    const hasBody = req.method !== 'GET' && req.method !== 'DELETE';
    if (hasBody) headers['content-type'] = 'application/json';

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(15_000)
      });

      const text = await upstream.text();
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      res.status(upstream.status).send(text);
    } catch (err) {
      // Fail loud: the agent being unreachable or throwing is a 502, never a 2xx and
      // never a hang (D2: the gateway owns 502 for an upstream it could not reach).
      res.status(502).json({ error: `agent unreachable: ${(err as Error).message}`, status: 502, requestId });
    }
  };
}

/**
 * Phase 5 C4 (D3): the multipart upload forwarder. `proxyToAgent()` above CANNOT carry this
 * route — it forces `content-type: application/json` and sends `JSON.stringify(req.body ?? {})`,
 * which is `{}` for a multipart request because nothing parsed it, and it caps every call at
 * 15 s. So the upload gets its own forwarder, which:
 *
 *   - pipes `req` itself as the body (`duplex: 'half'` is required — undici rejects a stream
 *     body without it), so a 25 MB file is never buffered in the gateway;
 *   - copies the inbound `content-type` VERBATIM, because the multipart boundary lives in it
 *     and a regenerated header makes every part unparseable;
 *   - refuses an over-size upload at the edge from `content-length`, before streaming
 *     anything. The agent's `multer` limit is still the authoritative check (a client may
 *     send no `content-length`, or lie); this one exists because the agent answers `413`
 *     mid-upload, and a status written while the body is still arriving reaches us as a
 *     socket error rather than a status — which is how a correct `413` becomes a `502`.
 *
 * The edge ceiling is deliberately slack: `content-length` covers the whole multipart
 * envelope (boundaries, part headers), so a legal file of exactly MAX_UPLOAD_BYTES arrives
 * slightly larger than it. Rejecting at exactly the limit would 413 a valid upload.
 */
const MULTIPART_ENVELOPE_SLACK = 64 * 1024;

export function proxyUpload() {
  return async (req: Request, res: Response) => {
    const requestId = String(res.locals.requestId);
    const url = `${env.agentUrl}${req.originalUrl}`;

    const contentType = req.header('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      res.status(400).json({ error: 'upload must be multipart/form-data', status: 400, requestId });
      return;
    }

    const declared = Number(req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK) {
      res.status(413).json({
        error: `file too large: the limit is ${MAX_UPLOAD_BYTES} bytes`,
        status: 413,
        requestId
      });
      return;
    }

    const headers: Record<string, string> = { [REQUEST_HEADER]: requestId, 'content-type': contentType };
    const userId = req.header(USER_HEADER);
    if (userId) headers[USER_HEADER] = userId;

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: Readable.toWeb(req) as unknown as ReadableStream,
        // Required by undici for a stream body: without it the request is rejected outright.
        duplex: 'half'
      });

      const text = await upstream.text();
      const upstreamType = upstream.headers.get('content-type');
      if (upstreamType) res.setHeader('content-type', upstreamType);
      res.status(upstream.status).send(text);
    } catch (err) {
      if (!res.writableEnded) {
        res.status(502).json({ error: `agent unreachable: ${(err as Error).message}`, status: 502, requestId });
      }
    }
  };
}

/**
 * Component 7: SSE pass-through for `POST /threads/:threadId/ask`. Pipes the agent's
 * response body straight to the client, byte for byte — no buffering, no parsing and
 * re-emitting of `data:` frames (a chunk boundary can split one, so byte-piping is both
 * simpler and more correct). `trace* → sources → token* → done` survives the hop
 * unchanged because nothing here looks at the frames at all.
 *
 * A non-streaming response (404 unknown thread, 400/501/502 before the agent even starts
 * the loop) arrives as JSON and must stay JSON — detected by content-type, not by status
 * code alone, since a stream always answers 200.
 */
export function proxyAskStream() {
  return async (req: Request, res: Response) => {
    const requestId = String(res.locals.requestId);
    const url = `${env.agentUrl}${req.originalUrl}`;
    const headers: Record<string, string> = {
      [REQUEST_HEADER]: requestId,
      'content-type': 'application/json'
    };
    const userId = req.header(USER_HEADER);
    if (userId) headers[USER_HEADER] = userId;

    // A client that navigates away mid-answer shouldn't leave the agent paying for
    // tokens nobody reads (BUG-005's lesson, one layer up): abort the upstream fetch the
    // moment the client disconnects. writableEnded distinguishes that from our own
    // normal res.end() below, which also triggers 'close'.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body ?? {}),
        signal: controller.signal
      });
    } catch (err) {
      if (!res.writableEnded) {
        res.status(502).json({ error: `agent unreachable: ${(err as Error).message}`, status: 502, requestId });
      }
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !contentType.includes('text/event-stream')) {
      const text = await upstream.text();
      if (contentType) res.setHeader('content-type', contentType);
      res.status(upstream.status).send(text);
      return;
    }

    // sseHeaders() sets content-type/cache-control/connection/x-accel-buffering and
    // flushes — it does not touch X-Request-Id, which the request-id middleware already
    // set on `res` earlier, so the header survives onto the streamed response unchanged.
    sseHeaders(res);

    if (!upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
    nodeStream.on('data', (chunk: Buffer) => {
      if (res.writableEnded) return;
      res.write(chunk);
      // @ts-expect-error `flush` exists when a compression middleware is present; harmless otherwise.
      if (typeof res.flush === 'function') res.flush();
    });
    nodeStream.on('end', () => {
      if (!res.writableEnded) res.end();
    });
    nodeStream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  };
}
