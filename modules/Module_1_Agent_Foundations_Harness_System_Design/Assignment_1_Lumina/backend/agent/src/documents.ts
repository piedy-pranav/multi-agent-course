import { DocumentDoc, DocumentRow, newId } from '@lumina/contract';
import { documentsCollection } from './collections.js';
import { deleteIndexJobsForDoc, enqueueIndexJob } from './jobs.js';
import { deleteUploadQuietly, newUploadId, putUpload } from './uploads.js';

/**
 * Phase 5 C2/C3: the `documents` store. The upload request does exactly four durable things
 * — GridFS write, pending document row, pending job row, `202` — and never parses, chunks,
 * embeds or retrieves (D2). Everything after `pending` belongs to the worker.
 */

/**
 * D4 says not to rely on the filename extension — it does not say to trust the browser's
 * declared type blindly, and a strict declared-type-only check breaks the provided UI, which
 * is the acceptance test (AGENTS.md #1). `form.append('file', file)` sends whatever the OS
 * told the browser, and `.md` has no registered MIME type on Windows and some Linux desktops,
 * so a legitimate Markdown upload arrives as `''` or `application/octet-stream`.
 *
 * So: the declared type wins whenever it is one we accept. The extension is consulted ONLY
 * when the declared type is absent or generic — i.e. only in the case this exists for. A
 * definite but unaccepted type (`image/png`) is a rejection, because overriding an explicit
 * declaration on the strength of a filename is guessing against evidence.
 *
 * The bench always sends an explicit accepted type (bench.mjs:319-324), so it would never
 * have caught the browser gap this closes.
 */
const EXTENSION_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain'
};

/**
 * Types that mean "the sender did not know", which is the only case the extension fallback is
 * for. A client that states `image/png` has told us something definite, and overriding that
 * because the filename ends in `.txt` is guessing against evidence — so those are rejected,
 * not re-interpreted.
 */
const UNINFORMATIVE_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export function resolveUploadType(
  declared: string | undefined,
  filename: string,
  accepted: readonly string[]
): { mimeType: string; via: 'declared' | 'extension' } | null {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (accepted.includes(bare)) return { mimeType: bare, via: 'declared' };

  // A definite, unaccepted type is a rejection. Only an absent or generic one falls through.
  if (!UNINFORMATIVE_TYPES.has(bare)) return null;

  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  const byExt = EXTENSION_TYPES[ext];
  if (byExt && accepted.includes(byExt)) return { mimeType: byExt, via: 'extension' };

  return null;
}

export interface AcceptUploadArgs {
  userId: string;
  spaceId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Persists an accepted upload and enqueues its indexing job: the GridFS bytes, the `pending`
 * document row, and the `pending` job row.
 *
 * All three are written concurrently and all three are awaited, so either the upload is
 * durably accepted or it is rolled back entirely (C2) — never a `pending` document with no
 * job, which would sit unexplained forever, and never an orphan GridFS file. Rollback is
 * best-effort and never masks the original error.
 */
export async function acceptUpload(args: AcceptUploadArgs): Promise<{ docId: string }> {
  const { userId, spaceId, filename, mimeType, bytes } = args;

  // Minting the GridFS id up front is what lets the three writes run concurrently: the
  // document row can name the file before the bytes have landed. Sequentially this path was
  // five round trips to Atlas (~36 ms each from a laptop), which measured 283 ms p50 / 311 ms
  // p95 against a declared 300 ms budget — over the line for arithmetic reasons, not because
  // anything was slow.
  const fileId = newUploadId();

  // `title` is the ORIGINAL UPLOAD FILENAME, not a PDF's internal title: bench.mjs:404-407
  // stem-matches this against the gold set's `doc` field, and a mismatch silently discards
  // an otherwise-correct recall hit.
  const doc = DocumentDoc.parse({
    _id: newId('doc'),
    spaceId,
    userId,
    title: filename,
    mimeType,
    bytes: bytes.byteLength,
    status: 'pending',
    pct: 0,
    fileId,
    createdAt: new Date().toISOString()
  });

  const documents = await documentsCollection<DocumentDoc>();

  /**
   * All three writes, concurrently — but every one is still AWAITED before the caller returns
   * `202`, so durable acceptance is unchanged (D2: never a fake 202). What changes is only
   * that they no longer wait for each other.
   *
   * One ordering guarantee is given up: the job row can become visible a few milliseconds
   * before the document row, so a worker polling at exactly that moment can claim a job whose
   * document it cannot yet read. That is already absorbed — `indexDocument` throws "document
   * not found", and since BUG-012 a processing failure with attempts remaining requeues
   * rather than failing terminally, so the next poll finds it. The alternative, keeping the
   * writes sequential, costs ~70 ms on every upload to avoid a sub-second window that
   * self-heals.
   */
  const results = await Promise.allSettled([
    putUpload(fileId, filename, mimeType, bytes, { userId, spaceId }),
    documents.insertOne(doc),
    enqueueIndexJob(userId, { docId: doc._id, spaceId, fileId, mimeType, title: filename })
  ]);

  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    // Unwind everything that did land, so a partial accept leaves no orphan GridFS file and
    // no document that nothing will ever process. Best-effort, and it never masks the
    // original error — that is what the caller surfaces.
    await Promise.allSettled([
      deleteUploadQuietly(fileId),
      documents.deleteOne({ _id: doc._id, userId }),
      deleteIndexJobsForDoc(userId, doc._id)
    ]);
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }

  return { docId: doc._id };
}

/** The worker's read side: the row it was handed a `docId` for, scoped by owner (D1). */
export async function getDocument(userId: string, docId: string): Promise<DocumentDoc | null> {
  return (await documentsCollection<DocumentDoc>()).findOne({ _id: docId, userId });
}

/**
 * D7: one truthful transition. `indexed` is NOT reachable through this function by accident —
 * `indexDocument` only calls it with `indexed` after the read-your-write probe has returned
 * one of the document's own chunks (D12). `pct` moves with the stage rather than being
 * decorative, because the UI and the bench both poll this row to decide whether ingestion
 * finished.
 */
export async function setDocumentStage(
  userId: string,
  docId: string,
  status: DocumentDoc['status'],
  pct: number,
  extra?: { pages?: number; chunks?: number }
): Promise<void> {
  const set: Record<string, unknown> = { status, pct };
  // `pages` is `.positive()` in the contract, so a zero-page parse must leave it absent
  // rather than store a 0 that fails DocumentRow.parse on the next list.
  if (extra?.pages !== undefined && extra.pages > 0) set.pages = extra.pages;
  if (extra?.chunks !== undefined) set.chunks = extra.chunks;
  await (await documentsCollection<DocumentDoc>()).updateOne(
    { _id: docId, userId },
    { $set: set, $unset: { error: '' } }
  );
}

/** A failed document ALWAYS carries a non-empty error (D18). `pct` is left where it stopped:
 * overwriting it with 0 would erase how far the ingestion actually got. */
export async function failDocument(userId: string, docId: string, error: string): Promise<void> {
  await (await documentsCollection<DocumentDoc>()).updateOne(
    { _id: docId, userId },
    { $set: { status: 'failed', error: error.slice(0, 2000) || 'unknown ingestion failure' } }
  );
}

/**
 * C3: the contract's `DocumentRow` and nothing else. An inclusion projection means `fileId`,
 * `userId`, `mimeType` and `bytes` are never fetched rather than fetched-and-dropped —
 * BUG-002's lesson, where internal scoping fields leaked into a response body.
 *
 * `pages`/`chunks`/`error` are optional in the contract and absent until the worker sets
 * them; `ignoreUndefined` on the client (BUG-001) keeps an unset one omitted rather than
 * `null`, which every `.optional()` (never `.nullable()`) schema would reject.
 */
export async function listDocuments(userId: string, spaceId: string): Promise<DocumentRow[]> {
  const rows = await (await documentsCollection<DocumentDoc>())
    .find(
      { spaceId, userId },
      { projection: { _id: 1, title: 1, status: 1, pct: 1, pages: 1, chunks: 1, error: 1, createdAt: 1 } }
    )
    .sort({ createdAt: 1 })
    .toArray();

  return rows.map((r) =>
    DocumentRow.parse({
      docId: r._id,
      title: r.title,
      status: r.status,
      pct: r.pct,
      pages: r.pages,
      chunks: r.chunks,
      error: r.error
    })
  );
}
