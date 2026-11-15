import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { messages, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";

export interface Line {
  id: string;
  at: Date;
  /** When ALRO stored it: a message can arrive (a backfill, a slow sync) long after it was sent. */
  stored: Date;
  thread: string;
  author: string;
  text: string;
}

const MAX_LINE = 1200;

/**
 * Messages one person can see, oldest first, for jobs that read conversations on their
 * behalf (procedures, trackers). Read through row-level security, so nothing they
 * couldn't open themselves ever reaches the model.
 */
export async function visibleMessages(db: Db, viewer: Viewer, opts: { after: Date; limit: number; newest?: boolean; /** Compare `after` with when messages arrived rather than when they were sent. */ byArrival?: boolean }): Promise<Line[]> {
  const time = opts.byArrival ? messages.ingestedAt : messages.sentAt;
  const rows = await withScope(db, viewer, (tx) =>
    tx
      .select({ id: messages.id, at: messages.sentAt, stored: messages.ingestedAt, thread: threads.title, author: people.displayName, text: messages.text, subject: messages.subject })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(people, eq(people.id, messages.authorPersonId))
      .where(and(isNull(messages.deletedAt), gt(time, opts.after), ne(messages.text, "[media]"), sql`length(${messages.text}) > 8`))
      .orderBy(opts.newest ? desc(time) : asc(time), asc(messages.id))
      .limit(opts.limit),
  );
  const lines = rows.map((r) => ({
    id: r.id,
    at: r.at,
    stored: r.stored,
    thread: r.thread ?? "Untitled",
    author: r.author ?? "Unknown",
    text: (r.subject ? `${r.subject}: ${r.text}` : r.text).replace(/\s+/g, " ").slice(0, MAX_LINE),
  }));
  return opts.newest ? lines.reverse() : lines;
}

/** Lines in batches of about `chars` characters, each line numbered from 1 within its batch. */
export function batches(lines: Line[], chars: number): Line[][] {
  const out: Line[][] = [];
  let current: Line[] = [];
  let size = 0;
  for (const l of lines) {
    const len = l.text.length + l.thread.length + l.author.length + 30;
    if (current.length && size + len > chars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(l);
    size += len;
  }
  if (current.length) out.push(current);
  return out;
}

/** "[3] 2026-11-02 · #dispatch · Ravi: truck MH12 left at 4pm" */
export const render = (batch: Line[]) => batch.map((l, i) => `[${i + 1}] ${l.at.toISOString().slice(0, 16).replace("T", " ")} · ${l.thread} · ${l.author}: ${l.text}`).join("\n");
