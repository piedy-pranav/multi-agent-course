import type { NextFunction, Request, Response } from 'express';
import { USER_HEADER } from '@lumina/contract';
import { env } from './env.js';

/**
 * Component 8: a per-`X-User-Id` fixed window at `env.rateLimitPerMinute` (default 30).
 * In-process state is fine — this is an edge concern, matches the non-authoritative-state
 * call in DESIGN.md Q4. Over the limit → `429` with an `ErrorBody` carrying `resetsAt` so
 * a client knows when to resume (`ErrorBody.resetsAt` is described as the deep-cap's
 * field in the contract, but nothing stops reusing it here — a `429` with no reset time
 * tells a client to stop and gives it no way to know when to resume).
 *
 * `/health` is a liveness probe and must never be rate limited. A missing `X-User-Id`
 * is not this middleware's problem — the auth middleware (which must run BEFORE this one)
 * already answered `401` and short-circuited the chain.
 */
const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();

    const userId = req.header(USER_HEADER);
    if (!userId) return next();

    const now = Date.now();
    let bucket = buckets.get(userId);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      buckets.set(userId, bucket);
    }

    bucket.count += 1;
    if (bucket.count > env.rateLimitPerMinute) {
      const resetsAt = new Date(bucket.windowStart + WINDOW_MS).toISOString();
      res.status(429).json({
        error: `rate limit exceeded: more than ${env.rateLimitPerMinute} requests/minute for this user`,
        status: 429,
        resetsAt,
        requestId: String(res.locals.requestId)
      });
      return;
    }

    next();
  };
}
