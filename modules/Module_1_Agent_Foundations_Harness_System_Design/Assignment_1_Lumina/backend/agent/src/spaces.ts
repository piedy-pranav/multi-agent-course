import { SpaceDoc, newId } from '@lumina/contract';
import { spacesCollection } from './collections.js';

/**
 * Phase 5 C1: the Space store. Every read is scoped by `userId` as well as `_id` (D1), so a
 * Space belonging to another user is indistinguishable from one that does not exist — the
 * caller turns both into the same `404` with the same body, rather than letting the endpoint
 * become an existence-and-ownership oracle (the reasoning behind GAP-013, applied here).
 */

export async function createSpace(userId: string, name: string): Promise<{ spaceId: string; name: string }> {
  const doc = SpaceDoc.parse({
    _id: newId('spc'),
    userId,
    name,
    createdAt: new Date().toISOString()
  });
  await (await spacesCollection<SpaceDoc>()).insertOne(doc);
  return { spaceId: doc._id, name: doc.name };
}

/** Newest first. `createdAt` is stored as an ISO string, which is what the contract's
 * `ListSpacesResponse` requires (`z.string().datetime()`) — not a Date. */
export async function listSpaces(
  userId: string
): Promise<{ spaceId: string; name: string; createdAt: string }[]> {
  const rows = await (await spacesCollection<SpaceDoc>())
    .find({ userId }, { projection: { _id: 1, name: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => ({
    spaceId: r._id,
    name: r.name,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString()
  }));
}

/**
 * The ownership check every document route and every retrieval path runs first (D1).
 * `null` means "unknown or not yours" — deliberately one answer for both.
 */
export async function getSpace(userId: string, spaceId: string): Promise<SpaceDoc | null> {
  return (await spacesCollection<SpaceDoc>()).findOne({ _id: spaceId, userId });
}
