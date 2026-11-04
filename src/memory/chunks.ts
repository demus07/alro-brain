import { embedMany } from "ai";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { chunks, messages, orgs, people, threads } from "@/db/schema";

const MAX_MESSAGES = 15;
const MAX_CHARS = 4000;
/** A quiet gap this long starts a new window in chats, so one chunk is one conversation. */
const GAP_MS = 6 * 60 * 60 * 1000;

export interface ChunkMessage {
  id: string;
  sentAt: Date;
  author: string | null;
  subject: string | null;
  text: string;
}

/**
 * Splits a thread's messages (oldest first) into windows of consecutive
 * messages. A message longer than a window (a pasted document) is cut into
 * window-sized parts, each its own window, so no chunk exceeds what an
 * embedding model accepts.
 */
export function windowMessages(msgs: ChunkMessage[]): ChunkMessage[][] {
  const windows: ChunkMessage[][] = [];
  let current: ChunkMessage[] = [];
  let chars = 0;
  for (const m of msgs.flatMap(splitLong)) {
    const last = current[current.length - 1];
    const full = current.length >= MAX_MESSAGES || (current.length > 0 && chars + m.text.length > MAX_CHARS);
    const gap = last && m.sentAt.getTime() - last.sentAt.getTime() > GAP_MS;
    if (current.length && (full || gap)) {
      windows.push(current);
      current = [];
      chars = 0;
    }
    current.push(m);
    chars += m.text.length;
  }
  if (current.length) windows.push(current);
  return windows;
}

/** Cuts a too-long message into parts at paragraph or line breaks where possible. */
function splitLong(m: ChunkMessage): ChunkMessage[] {
  if (m.text.length <= MAX_CHARS) return [m];
  const parts: ChunkMessage[] = [];
  let rest = m.text;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". ") + 1);
    const at = cut > MAX_CHARS / 2 ? cut : MAX_CHARS;
    parts.push({ ...m, text: `${parts.length ? "(continued) " : ""}${rest.slice(0, at).trim()}` });
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push({ ...m, text: `(continued) ${rest.trim()}` });
  return parts;
}

/** "[Fri 4 Sep 2026, 12:10] Ananya Desai: Schema PR is up" lines under a thread heading. */
export function renderChunk(thread: { title: string | null; kind: string }, window: ChunkMessage[], timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const lines = window.map((m) => {
    const subject = m.subject && thread.kind === "email" ? ` (${m.subject})` : "";
    return `[${time.format(m.sentAt)}] ${m.author ?? "Unknown"}${subject}: ${m.text}`;
  });
  return [`${thread.title ?? "Untitled"} (${thread.kind})`, ...lines].join("\n");
}

/**
 * Chunks and embeds every message not yet in a chunk, for one org. Chunks are
 * only appended or rebuilt from the first new message onwards, so a long
 * channel isn't re-embedded each run. Returns how many chunks were written.
 */
export async function chunkPending(db: Db, orgId: string, models: Models, opts: { maxThreads?: number } = {}): Promise<number> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const pending = await db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        isNull(messages.deletedAt),
        sql`not exists (select 1 from ${chunks} c where c.thread_id = ${messages.threadId} and ${messages.id} = any(c.message_ids))`,
      ),
    )
    .limit(opts.maxThreads ?? 200);

  let written = 0;
  for (const { threadId } of pending) {
    try {
      written += await rechunkThread(db, orgId, threadId, models, org?.timezone ?? "UTC");
    } catch (e) {
      // One thread failing (a provider error, an odd message) mustn't leave every other thread unsearchable.
      console.error(`chunking failed for thread ${threadId}`, e instanceof Error ? e.message : e);
    }
  }
  return written;
}

async function rechunkThread(db: Db, orgId: string, threadId: string, models: Models, timeZone: string): Promise<number> {
  const [thread] = await db.select({ title: threads.title, kind: threads.kind }).from(threads).where(eq(threads.id, threadId));
  const all: ChunkMessage[] = await db
    .select({ id: messages.id, sentAt: messages.sentAt, author: people.displayName, subject: messages.subject, text: messages.text })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.sentAt), asc(messages.externalId));

  const existing = await db
    .select({ id: chunks.id, messageIds: chunks.messageIds })
    .from(chunks)
    .where(eq(chunks.threadId, threadId))
    .orderBy(asc(chunks.startAt));
  const position = new Map(all.map((m, i) => [m.id, i]));
  const covered = new Set(existing.flatMap((c) => c.messageIds));
  const firstNew = all.findIndex((m) => !covered.has(m.id));
  if (firstNew === -1) return 0;

  // Keep chunks that end before the first new message; rebuild everything after.
  const stale = existing.filter((c) => c.messageIds.some((id) => (position.get(id) ?? Infinity) >= firstNew));
  const keptIds = new Set(existing.filter((c) => !stale.includes(c)).flatMap((c) => c.messageIds));
  const windows = windowMessages(all.filter((m) => !keptIds.has(m.id)));
  const texts = windows.map((w) => renderChunk(thread, w, timeZone));

  const { embeddings, usage } = await embedMany({
    model: models.embed,
    values: texts,
    dimensions: models.embedDimensions,
    maxParallelCalls: 2,
  });
  await recordRun(db, { orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });

  await db.transaction(async (tx) => {
    if (stale.length) await tx.delete(chunks).where(inArray(chunks.id, stale.map((c) => c.id)));
    await tx.insert(chunks).values(
      windows.map((w, i) => ({
        orgId,
        threadId,
        messageIds: [...new Set(w.map((m) => m.id))],
        startAt: w[0].sentAt,
        endAt: w[w.length - 1].sentAt,
        text: texts[i],
        embedding: embeddings[i],
      })),
    );
  });
  return windows.length;
}
