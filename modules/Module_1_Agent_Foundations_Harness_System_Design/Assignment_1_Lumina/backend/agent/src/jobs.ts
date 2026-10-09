import { JobDoc } from '@lumina/contract';
import { jobsCollection } from './collections.js';
import { env } from './env.js';

/**
 * Phase 5 C5: the Mongo-backed job queue — no Redis, no broker (SPEC §6).
 *
 * `newId()`'s prefix union (contract/src/ids.ts:28) has no 'job' member and `JobDoc._id` is a
 * required `z.string()`, so ids are minted locally rather than editing the contract (a red
 * line) or letting the driver assign an `ObjectId` — exactly BUG-008's precedent.
 */
function newJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface IndexDocumentPayload {
  docId: string;
  spaceId: string;
  fileId: string;
  mimeType: string;
  title: string;
}

/**
 * The only job kind LUMINA has. Inserted in the upload request, claimed later by the worker
 * — never executed inline (D2). Throws on a failed insert so C2 can roll back the document
 * row and the GridFS file rather than leaving a pending document nothing will ever process.
 */
export async function enqueueIndexJob(userId: string, payload: IndexDocumentPayload): Promise<string> {
  const doc = JobDoc.parse({
    _id: newJobId(),
    kind: 'index_document',
    status: 'pending',
    payload,
    userId,
    attempts: 0,
    createdAt: new Date().toISOString()
  });
  await (await jobsCollection<JobDoc>()).insertOne(doc);
  return doc._id;
}

/** Rollback for a partially-accepted upload (C2). Scoped by owner, and keyed on the docId in
 * the payload — the only handle the caller has before the job id is known. */
export async function deleteIndexJobsForDoc(userId: string, docId: string): Promise<void> {
  await (await jobsCollection<JobDoc>()).deleteMany({ userId, 'payload.docId': docId });
}

/**
 * The claim, and the reason this is a queue rather than a table scan: `findOneAndUpdate` is
 * atomic, so two workers racing for the same row produce exactly one winner and one `null`.
 * Polling `find` then `updateOne` would hand the same job to both.
 *
 * Oldest first, and `attempts` increments on the claim itself — not on success — so a worker
 * that dies mid-job has still visibly consumed an attempt and cannot be retried forever.
 */
export async function claimNextJob(workerId: string): Promise<JobDoc | null> {
  const col = await jobsCollection<JobDoc>();
  return col.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date().toISOString(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

export async function markJobDone(jobId: string): Promise<void> {
  await (await jobsCollection<JobDoc>()).updateOne(
    { _id: jobId },
    { $set: { status: 'done' }, $unset: { error: '' } }
  );
}

/** A failed job ALWAYS carries a non-empty error (D18/rule A1): a failure you cannot tell
 * apart from an empty result is the Live Translate bug waiting to happen. */
export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await (await jobsCollection<JobDoc>()).updateOne(
    { _id: jobId },
    { $set: { status: 'failed', error: error.slice(0, 2000) || 'unknown ingestion failure' } }
  );
}

/**
 * Hand a job back to the queue after a failed attempt that still has attempts left.
 *
 * The error is KEPT on the row rather than cleared: a job that is pending again but carries
 * "openai embeddings 503" is the only way to tell a first attempt from a retry after a
 * provider blip, and losing that makes a flaky dependency look like a slow one.
 */
export async function markJobForRetry(jobId: string, error: string): Promise<void> {
  await (await jobsCollection<JobDoc>()).updateOne(
    { _id: jobId },
    {
      $set: { status: 'pending', error: error.slice(0, 2000) || 'unknown ingestion failure' },
      $unset: { claimedAt: '', workerId: '' }
    }
  );
}

export interface StaleSweep {
  /** Returned to `pending` for another worker to pick up. */
  requeued: JobDoc[];
  /** Out of attempts — marked `failed` here; the caller must also fail their documents. */
  exhausted: JobDoc[];
}

/**
 * The crash-recovery half (SPEC §6): a worker killed mid-job leaves its row `running` with a
 * stale `claimedAt`, because nothing gets to run a cleanup handler when the process dies.
 * This is what notices.
 *
 * A stale row is only requeued while it has attempts left. Past `JOB_MAX_ATTEMPTS` it is
 * terminal — a deterministically-failing job (a corrupt PDF) would otherwise cycle
 * `running → pending → running` forever, which looks like liveness and is really a loop.
 */
export async function sweepStaleJobs(): Promise<StaleSweep> {
  const col = await jobsCollection<JobDoc>();
  const cutoff = new Date(Date.now() - env.jobStaleAfterSeconds * 1000).toISOString();

  const stale = await col.find({ status: 'running', claimedAt: { $lt: cutoff } }).toArray();
  const sweep: StaleSweep = { requeued: [], exhausted: [] };

  for (const job of stale) {
    if ((job.attempts ?? 0) >= env.jobMaxAttempts) {
      const error = `abandoned after ${job.attempts} attempt(s): last claim by ${job.workerId ?? 'unknown worker'} at ${String(job.claimedAt)} never completed`;
      // Conditional on still being `running`, so a worker that is merely slow — and finishes
      // between the find above and this write — is not retroactively failed.
      const r = await col.updateOne(
        { _id: job._id, status: 'running' },
        { $set: { status: 'failed', error } }
      );
      if (r.modifiedCount === 1) sweep.exhausted.push({ ...job, error });
      continue;
    }
    const r = await col.updateOne(
      { _id: job._id, status: 'running' },
      { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
    );
    if (r.modifiedCount === 1) sweep.requeued.push(job);
  }

  return sweep;
}
