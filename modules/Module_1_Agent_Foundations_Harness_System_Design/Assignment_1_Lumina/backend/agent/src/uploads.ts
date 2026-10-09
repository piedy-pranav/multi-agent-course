import { GRIDFS_BUCKETS } from '@lumina/contract';
import { GridFSBucket, ObjectId } from 'mongodb';
import { db } from './db.js';

/**
 * Phase 5 C2: the raw upload lives in GridFS, keyed by a hex string. `DocumentDoc.fileId` is
 * `z.string()` (contract/src/db.ts:70), so the bucket's `ObjectId` is converted on the way
 * out and back — the same class of mistake BUG-008 fixed for `MessageDoc._id`.
 *
 * Nothing here parses anything. The worker (C5–C7) is the only reader.
 */

async function bucket(): Promise<GridFSBucket> {
  return new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
}

/** A GridFS file id, minted before the write so the metadata rows that reference it do not
 * have to wait for the bytes to land (see `acceptUpload`). */
export function newUploadId(): string {
  return new ObjectId().toHexString();
}

/** Resolves once the file is durably written, so the caller's `202` is never a promise about
 * bytes that have not landed (D2: no fake 202). */
export async function putUpload(
  fileId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  metadata: { userId: string; spaceId: string }
): Promise<void> {
  const b = await bucket();
  return new Promise<void>((resolve, reject) => {
    const stream = b.openUploadStreamWithId(new ObjectId(fileId), filename, { contentType, metadata });
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    stream.end(bytes);
  });
}

/** Rollback for a partially-persisted upload (C2). Never throws: it runs inside a failure
 * path, and masking the original error with a cleanup error would hide the real cause. */
export async function deleteUploadQuietly(fileId: string): Promise<void> {
  try {
    await (await bucket()).delete(new ObjectId(fileId));
  } catch {
    // best effort — the caller is already failing and logs the real error
  }
}

/** The worker's read side (used from C7). Buffers the whole file: 25 MB is the declared
 * ceiling, and a streaming parse buys nothing when `pdfjs` wants the full buffer anyway. */
export async function readUpload(fileId: string): Promise<Buffer> {
  const b = await bucket();
  const chunks: Buffer[] = [];
  for await (const chunk of b.openDownloadStream(new ObjectId(fileId))) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
