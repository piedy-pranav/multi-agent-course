import { ChunkDoc, EMBEDDING_DIMS } from '@lumina/contract';
import type { Logger } from 'pino';
import { chunksCollection } from '../collections.js';
import { getDocument, setDocumentStage } from '../documents.js';
import { embedBatch } from '../embed.js';
import { env } from '../env.js';
import { readUpload } from '../uploads.js';
import { assertUniqueLocators, chunkUnits } from './chunk.js';
import { parsePdf } from './parsePdf.js';
import { decodeText, parseMarkdown, parsePlainText } from './parseText.js';
import { waitUntilSearchable } from './indexProbe.js';
import type { ParsedDoc } from './parsed.js';

/**
 * Phase 5 C7: the whole ingestion for one document, as the worker runs it.
 *
 *   parsing → parse → pages → chunk → embedding → embed batches → persist → probe → indexed
 *
 * Every status it writes is true at the moment it writes it (D7), and `indexed` is only
 * reachable through the probe at the bottom (D12). A throw from anywhere here is the caller's
 * to turn into a failed job and a failed document with a non-empty error (D18) — nothing in
 * this file catches a failure and continues with less.
 */

export interface IngestResult {
  chunks: number;
  pages?: number;
  embeddingTokens: number;
  probeAttempts: number;
  probeWaitedMs: number;
}

export interface IngestArgs {
  userId: string;
  docId: string;
  log: Logger;
  signal?: AbortSignal;
}

export async function indexDocument(args: IngestArgs): Promise<IngestResult> {
  const { userId, docId, log, signal } = args;

  const doc = await getDocument(userId, docId);
  if (!doc) throw new Error(`document ${docId} not found for this user`);

  // ---- parse -------------------------------------------------------------------------
  await setDocumentStage(userId, docId, 'parsing', 5);

  const bytes = await readUpload(doc.fileId);
  if (bytes.byteLength === 0) throw new Error('stored upload is empty');

  const parsed = await parseByType(doc.mimeType, bytes);
  const pages = parsed.pages;

  await setDocumentStage(userId, docId, 'parsing', 10, { pages });

  // ---- chunk -------------------------------------------------------------------------
  const drafts = chunkUnits(parsed.units, {
    targetChars: env.docChunkTargetChars,
    overlapChars: env.docChunkOverlapChars
  });
  if (drafts.length === 0) throw new Error('parsed document produced no chunks');
  if (drafts.some((d) => d.text.trim().length === 0)) throw new Error('chunker produced an empty chunk');

  // D8's invariant, checked before a single row is written: a collision here is a bug in the
  // chunker, and finding it at insert time is far cheaper than finding it as an unexplained
  // grounding failure in the bench.
  assertUniqueLocators(docId, drafts);

  await setDocumentStage(userId, docId, 'embedding', 15, { pages });

  // ---- D10: clear this document's previous chunks BEFORE inserting any new ones --------
  // Deterministic ids alone are not enough. A retry that re-chunks into FEWER chunks (a
  // changed DOC_CHUNK_TARGET_CHARS, a different parse) would leave the earlier attempt's
  // higher-`ord` rows behind, still in the vector index, still retrievable, still citable —
  // stale evidence attributed to a document that no longer says it. Nothing in the schema
  // prevents this: `chunks`' {docId, ord} index is NOT unique.
  const col = await chunksCollection<ChunkDoc>();
  const cleared = await col.deleteMany({ docId, userId });
  if (cleared.deletedCount > 0) {
    log.info({ docId, userId, cleared: cleared.deletedCount }, 'cleared chunks from a previous attempt');
  }

  // ---- embed + persist, in batches ----------------------------------------------------
  let embeddingTokens = 0;
  let written = 0;

  for (let start = 0; start < drafts.length; start += env.docEmbedBatchSize) {
    const batch = drafts.slice(start, start + env.docEmbedBatchSize);
    const { embeddings, tokens } = await embedBatch(batch.map((d) => d.text), signal);
    embeddingTokens += tokens;

    if (embeddings.length !== batch.length) {
      throw new Error(`embedding batch returned ${embeddings.length} vectors for ${batch.length} chunks`);
    }

    const rows = batch.map((draft, i) => {
      const embedding = embeddings[i];
      if (!embedding || embedding.length !== EMBEDDING_DIMS) {
        throw new Error(
          `chunk ord ${draft.ord}: expected a ${EMBEDDING_DIMS}-dim embedding, got ${embedding?.length ?? 'none'}`
        );
      }
      // ChunkDoc.parse before insert, so a shape error is caught here with a chunk number
      // attached rather than as a retrieval mystery later.
      return ChunkDoc.parse({
        _id: chunkId(docId, draft.ord),
        docId,
        spaceId: doc.spaceId,
        userId,
        text: draft.text,
        locator: draft.locator,
        ord: draft.ord,
        embedding,
        createdAt: new Date().toISOString()
      });
    });

    await col.insertMany(rows, { ordered: false });
    written += rows.length;

    // 15 → 85 across the batches: the UI and the bench both poll this, so it should move.
    const pct = 15 + Math.round((written / drafts.length) * 70);
    await setDocumentStage(userId, docId, 'embedding', pct, { pages, chunks: written });
  }

  if (written !== drafts.length) {
    throw new Error(`wrote ${written} chunks but chunked ${drafts.length}`);
  }

  // ---- D12: the probe is what earns `indexed` -----------------------------------------
  await setDocumentStage(userId, docId, 'embedding', 90, { pages, chunks: written });

  const last = drafts[drafts.length - 1];
  const probeRow = last ? await col.findOne({ _id: chunkId(docId, last.ord) }) : null;
  if (!probeRow) throw new Error('cannot probe: the chunk just written is not readable');

  const probe = await waitUntilSearchable({
    userId,
    spaceId: doc.spaceId,
    docId,
    chunkId: probeRow._id,
    embedding: probeRow.embedding
  });

  if (!probe.ok) {
    throw new Error(
      `chunks were written but are still not searchable after ${probe.attempts} probe attempt(s) ` +
        `over ${Math.round(probe.waitedMs / 1000)}s — the ${env.vectorBackend} index may be building or misconfigured`
    );
  }

  await setDocumentStage(userId, docId, 'indexed', 100, { pages, chunks: written });

  return {
    chunks: written,
    pages,
    embeddingTokens,
    probeAttempts: probe.attempts,
    probeWaitedMs: probe.waitedMs
  };
}

/** D10: deterministic, so a retry overwrites its own previous rows instead of adding to them. */
function chunkId(docId: string, ord: number): string {
  return `${docId}:${ord}`;
}

async function parseByType(mimeType: string, bytes: Buffer): Promise<ParsedDoc> {
  switch (mimeType) {
    case 'application/pdf':
      return parsePdf(bytes);
    case 'text/markdown':
      return parseMarkdown(decodeText(bytes));
    case 'text/plain':
      return parsePlainText(decodeText(bytes));
    default:
      // Unreachable via the upload route, which validates against ACCEPTED_UPLOAD_TYPES —
      // but a job row is persisted state that could outlive a change to that list.
      throw new Error(`no parser for content type "${mimeType}"`);
  }
}
