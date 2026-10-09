import { newId } from '@lumina/contract';
import type { GetThreadResponse, ThreadMessage } from '@lumina/contract';
import { threadsCollection, messagesCollection } from './collections.js';

/** Mongo document shapes. Ids are app-generated prefixed strings, not ObjectIds (PRD 8). */
interface ThreadDoc {
  _id: string;
  userId: string;
  title: string;
  /** Internal only — never projected into a response. Marks a title that is still the
   * D4 placeholder, cleared atomically the moment the thread's first ask lands. */
  titleAuto?: true;
  createdAt: string;
}

interface MessageDoc extends ThreadMessage {
  _id: string;
  threadId: string;
  userId: string;
}

const TITLE_MAX = 200;
/** `newId()` has no 'msg' prefix in its union (packages/contract/src/ids.ts), and
 * `MessageDoc._id` is a required z.string() — not an ObjectId. A small local id keeps
 * message ids out of the Mongo driver's auto-assigned ObjectId entirely. */
function newMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * D4: every stored thread satisfies `ThreadDoc.title: z.string()` from the moment it
 * exists — no title supplied means a placeholder ("New thread") plus `titleAuto: true`,
 * swapped for the user's first query atomically in `promoteThreadTitle`.
 */
export async function createThread(userId: string, title?: string): Promise<string> {
  const threadId = newId('thr');
  const doc: ThreadDoc = title
    ? { _id: threadId, userId, title, createdAt: new Date().toISOString() }
    : { _id: threadId, userId, title: 'New thread', titleAuto: true, createdAt: new Date().toISOString() };
  await (await threadsCollection<ThreadDoc>()).insertOne(doc);
  return threadId;
}

/**
 * Called once per thread, on its first ask. Gated on the `titleAuto` flag rather than the
 * literal placeholder string, so a user who titles their thread exactly "New thread" is
 * never silently overwritten. Idempotent: a second call matches nothing and no-ops, so two
 * concurrent first asks cannot clobber each other.
 */
export async function promoteThreadTitle(threadId: string, userId: string, query: string): Promise<void> {
  const derived = query.slice(0, TITLE_MAX);
  await (await threadsCollection<ThreadDoc>()).updateOne(
    { _id: threadId, userId, titleAuto: true },
    { $set: { title: derived }, $unset: { titleAuto: '' } }
  );
}

/** Scoped by userId so one user can never read another's thread (strict isolation). */
export async function getThread(threadId: string, userId: string): Promise<GetThreadResponse | null> {
  const thread = await (await threadsCollection<ThreadDoc>()).findOne({ _id: threadId, userId });
  if (!thread) return null;

  const messages = await (await messagesCollection<MessageDoc>())
    // Exclude threadId/userId (internal scoping, not in the contract's ThreadMessage) and
    // Mongo's own _id (never part of the contract shape) so the response matches
    // packages/contract/src/http.ts exactly, with nothing extra for the UI to ignore.
    .find({ threadId, userId }, { projection: { _id: 0, threadId: 0, userId: 0 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  return {
    threadId: thread._id,
    title: thread.title,
    messages: messages as unknown as ThreadMessage[]
  };
}

/** Newest first; titles always a conforming string per D4 — never null, never titleAuto. */
export async function listThreads(
  userId: string
): Promise<{ threadId: string; title: string; createdAt: string }[]> {
  const rows = await (await threadsCollection<ThreadDoc>())
    .find({ userId }, { projection: { _id: 1, title: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => ({ threadId: r._id, title: r.title, createdAt: r.createdAt }));
}

export async function appendMessage(threadId: string, userId: string, msg: ThreadMessage): Promise<void> {
  const doc: MessageDoc = {
    ...msg,
    _id: newMessageId(),
    threadId,
    userId,
    createdAt: msg.createdAt ?? new Date().toISOString()
  };
  await (await messagesCollection<MessageDoc>()).insertOne(doc);
}

const HISTORY_MAX_MESSAGES = 6;
const HISTORY_MAX_CHARS_PER_MESSAGE = 1000;

/**
 * D6: prior turns' TEXT only, never their `sources`/`done`/tool evidence — the gather
 * loop's grounding guard must only ever see sources from the request it is actually
 * answering. Capped by count and by length: the bench runs 40 asks in one thread, and an
 * uncapped history is the fastest way to blow the $0.05/answer cost gate.
 *
 * Must be called BEFORE `appendMessage` writes the current user turn — a snapshot taken
 * before that write provably cannot include it, with no reliance on sort-tie-breaking to
 * exclude it after the fact.
 */
export async function getRecentHistory(
  threadId: string,
  userId: string,
  limit = HISTORY_MAX_MESSAGES
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await (await messagesCollection<MessageDoc>())
    .find({ threadId, userId }, { projection: { role: 1, content: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  return rows.slice(-limit).map((r) => ({ role: r.role, content: r.content.slice(0, HISTORY_MAX_CHARS_PER_MESSAGE) }));
}
