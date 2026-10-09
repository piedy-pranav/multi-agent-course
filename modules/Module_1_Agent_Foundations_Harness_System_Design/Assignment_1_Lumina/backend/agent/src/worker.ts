/**
 * The jobs worker (Phase 5 C5).
 *
 * Runs as its own process (`npm run worker`) and not inside the API, because parsing a
 * 60-page PDF and embedding its chunks is CPU and I/O that must not sit on the event loop
 * serving somebody's answer stream. The bench measures search p95 during an ingest, so a
 * blocking implementation shows up as a failed SLA rather than a mystery (SPEC §16).
 *
 *   index_document → GridFS read → parse (page-aware) → chunk → embed → insert →
 *                    READ-YOUR-WRITE PROBE → status: indexed
 *
 * That is the only job kind LUMINA has. Deep search deliberately does NOT run here: it
 * streams its plan and progress over the same SSE channel as a quick answer, because someone
 * waiting on a minute of research wants to watch it work, not poll a job id.
 *
 * Crash safety is the sweeper's job, not a cleanup handler's: a killed process gets to run
 * nothing, so the row simply stays `running` with a stale `claimedAt` and
 * `sweepStaleJobs()` returns it to `pending` (or fails it, out of attempts).
 */
import { hostname } from 'node:os';
import pino from 'pino';
import { env } from './env.js';
import { failDocument } from './documents.js';
import { claimNextJob, markJobDone, markJobFailed, markJobForRetry, sweepStaleJobs } from './jobs.js';
import { indexDocument } from './ingest/indexDocument.js';

const log = pino({ level: env.logLevel });

const workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
/** Set while a job is being processed, so a shutdown signal can wait for it instead of
 * orphaning a half-written document that the sweeper then has to rescue. */
let active: Promise<void> | null = null;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130); // a second signal means "now"
    stopping = true;
    log.info({ workerId, signal }, 'shutting down after the current job');
  });
}

/** D18: one structured line per job, with every field needed to trace it. */
function jobLogFields(job: { _id: string; userId: string; attempts?: number; payload: Record<string, unknown> }) {
  return {
    jobId: job._id,
    docId: job.payload.docId,
    spaceId: job.payload.spaceId,
    userId: job.userId,
    workerId,
    attempt: job.attempts ?? 0
  };
}

async function runOneJob(): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;

  const fields = jobLogFields(job);
  const startedAt = Date.now();
  const docId = typeof job.payload.docId === 'string' ? job.payload.docId : undefined;

  // The claim already incremented `attempts`. A job that has now used its last attempt is
  // terminal: better to fail it here, loudly, than to start work whose failure would look
  // like the sweeper's problem.
  if ((job.attempts ?? 0) > env.jobMaxAttempts) {
    const error = `exceeded JOB_MAX_ATTEMPTS (${env.jobMaxAttempts}) after ${job.attempts} attempt(s)`;
    await markJobFailed(job._id, error);
    if (docId) await failDocument(job.userId, docId, error);
    log.error({ ...fields, stage: 'claim', ms: Date.now() - startedAt, error }, 'ingestion job abandoned');
    return true;
  }

  if (job.kind !== 'index_document') {
    const error = `unknown job kind "${job.kind}"`;
    await markJobFailed(job._id, error);
    log.error({ ...fields, stage: 'claim', ms: Date.now() - startedAt, error }, 'ingestion job rejected');
    return true;
  }

  if (!docId) {
    const error = 'job payload has no docId';
    await markJobFailed(job._id, error);
    log.error({ ...fields, stage: 'claim', ms: Date.now() - startedAt, error }, 'ingestion job rejected');
    return true;
  }

  log.info({ ...fields, stage: 'start' }, 'ingestion job claimed');

  try {
    const result = await indexDocument({ userId: job.userId, docId, log });
    await markJobDone(job._id);
    log.info(
      {
        ...fields,
        stage: 'indexed',
        ms: Date.now() - startedAt,
        chunks: result.chunks,
        pages: result.pages,
        // D11: ingestion embedding spend is NOT an answer's RunState.costUsd — it has no
        // home on the wire, so it is logged here instead of inventing an HTTP shape.
        embeddingTokens: result.embeddingTokens,
        probeAttempts: result.probeAttempts,
        probeWaitedMs: result.probeWaitedMs
      },
      'ingestion job done'
    );
  } catch (err) {
    const error = (err as Error).message;
    const attemptsUsed = job.attempts ?? 1;
    const attemptsLeft = env.jobMaxAttempts - attemptsUsed;

    if (attemptsLeft > 0) {
      // Retry while attempts remain. Not every failure is permanent: a provider 503, an
      // embedding timeout, or an Atlas blip (ENV-005 — this build was developed on a
      // connection that dropped mid-session) all fail exactly like a corrupt file, and the
      // difference only shows on the next try. Retrying is safe precisely because D10 made
      // the write idempotent — `deleteMany` + deterministic ids mean attempt 2 replaces
      // attempt 1's chunks rather than adding to them.
      //
      // A genuinely permanent failure costs almost nothing to retry: a corrupt PDF throws
      // "Invalid PDF structure" before any provider call, so the extra attempts are
      // milliseconds, and it still ends terminally `failed` with the same error.
      //
      // The document is deliberately LEFT at its current stage rather than flipped to
      // `failed` and back: it has not finished and it has not given up, which is what
      // `parsing`/`embedding` already mean. Flickering through `failed` would tell the UI and
      // the bench that ingestion was over when it was not.
      await markJobForRetry(job._id, error);
      log.warn(
        { ...fields, stage: 'retry', ms: Date.now() - startedAt, error, attemptsLeft },
        'ingestion attempt failed — requeued'
      );
      return true;
    }

    // Out of attempts: terminal. Both rows carry the error (D18). The document's status is
    // what the UI and the bench read, and a document stuck at `embedding` with a `failed`
    // job would be a lie by omission — so neither is updated without the other.
    await markJobFailed(job._id, error);
    await failDocument(job.userId, docId, error);
    log.error(
      { ...fields, stage: 'failed', ms: Date.now() - startedAt, error, attemptsUsed },
      'ingestion job failed terminally'
    );
  }

  return true;
}

async function main(): Promise<void> {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');

  log.info(
    {
      workerId,
      vectorStore: env.vectorBackend,
      embeddingModel: env.embeddingModel,
      chunk: { targetChars: env.docChunkTargetChars, overlapChars: env.docChunkOverlapChars },
      jobs: {
        pollIntervalMs: env.jobPollIntervalMs,
        staleAfterSeconds: env.jobStaleAfterSeconds,
        maxAttempts: env.jobMaxAttempts
      }
    },
    'jobs worker up'
  );

  while (!stopping) {
    try {
      const sweep = await sweepStaleJobs();
      for (const job of sweep.requeued) {
        log.warn({ ...jobLogFields(job), stage: 'sweep' }, 'requeued a stale running job');
      }
      for (const job of sweep.exhausted) {
        const docId = typeof job.payload.docId === 'string' ? job.payload.docId : undefined;
        if (docId) await failDocument(job.userId, docId, job.error ?? 'abandoned by the sweeper');
        log.error({ ...jobLogFields(job), stage: 'sweep', error: job.error }, 'failed a stale job out of attempts');
      }

      // One job at a time, on purpose: each holds a whole upload (up to 25 MB) plus its
      // chunk vectors in memory, and the point of this process is to be predictable, not
      // fast. Scale out by running more workers — the claim is atomic, so that is safe.
      active = runOneJob().then(
        (worked) => {
          if (!worked) return sleep(env.jobPollIntervalMs).then(() => undefined);
          return undefined;
        },
        (err) => {
          // A failure OUTSIDE a claimed job (Mongo unreachable, say). Nothing is half-done:
          // either no job was claimed, or runOneJob already recorded its own failure.
          log.error({ workerId, err }, 'worker iteration failed');
          return sleep(env.jobPollIntervalMs).then(() => undefined);
        }
      );
      await active;
      active = null;
    } catch (err) {
      log.error({ workerId, err }, 'worker loop error');
      await sleep(env.jobPollIntervalMs);
    }
  }

  if (active) await active;
  log.info({ workerId }, 'jobs worker stopped');
  process.exit(0);
}

void main();
