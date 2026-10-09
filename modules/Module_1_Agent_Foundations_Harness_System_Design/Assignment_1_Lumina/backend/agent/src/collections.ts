import { COLLECTIONS } from '@lumina/contract';
import type { Collection, Document } from 'mongodb';
import { db } from './db.js';

/** Typed accessors by name from the contract's COLLECTIONS, so a collection name is never
 * a scattered string literal that can drift from the schema it is supposed to hold. */
async function collection<T extends Document>(name: string): Promise<Collection<T>> {
  return (await db()).collection<T>(name);
}

export const threadsCollection = <T extends Document>() => collection<T>(COLLECTIONS.threads);
export const messagesCollection = <T extends Document>() => collection<T>(COLLECTIONS.messages);
export const memoriesCollection = <T extends Document>() => collection<T>(COLLECTIONS.memories);
export const searchCacheCollection = <T extends Document>() => collection<T>(COLLECTIONS.searchCache);
export const requestsCollection = <T extends Document>() => collection<T>(COLLECTIONS.requests);
export const runsCollection = <T extends Document>() => collection<T>(COLLECTIONS.runs);
// Phase 5 C1/C2: Spaces + document RAG.
export const spacesCollection = <T extends Document>() => collection<T>(COLLECTIONS.spaces);
export const documentsCollection = <T extends Document>() => collection<T>(COLLECTIONS.documents);
export const chunksCollection = <T extends Document>() => collection<T>(COLLECTIONS.chunks);
export const jobsCollection = <T extends Document>() => collection<T>(COLLECTIONS.jobs);
