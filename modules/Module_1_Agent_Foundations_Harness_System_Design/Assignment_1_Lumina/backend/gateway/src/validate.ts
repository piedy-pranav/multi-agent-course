import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * D1: validation is middleware IN FRONT of the generic proxy, not a hand-rolled check per
 * route. `schema.parse` also applies the schema's own `.default()`s (e.g. `AskBody`'s
 * `mode: 'auto'`, `depth: 'quick'`) — `req.body` is reassigned to the PARSED object so the
 * proxy forwards the same defaults the gateway just validated, never an `undefined` that
 * drifts downstream.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: err.issues.map((i) => i.message).join('; '),
          status: 400,
          requestId: String(res.locals.requestId)
        });
        return;
      }
      next(err);
    }
  };
}
