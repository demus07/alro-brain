import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { connections, messages, orgs, people, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { sourceOf } from "@/lib/sources";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Conversation · ALRO" };

/** Messages shown either side of the cited one. */
const AROUND = 20;

/** A cited message in its conversation: where a [1] in an answer leads. */
export default function MessagePage({ params }: PageProps<"/m/[id]">) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      {params.then(({ id }) => (
        <Conversation id={id} />
      ))}
    </Suspense>
  );
}

async function Conversation({ id }: { id: string }) {
  await connection();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));

  const data = await withScope(db, viewer, async (tx) => {
    const [target] = await tx
      .select({ id: messages.id, threadId: messages.threadId, sentAt: messages.sentAt, title: threads.title, kind: threads.kind, url: threads.url, provider: connections.provider })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(connections, eq(connections.id, messages.connectionId))
      .where(eq(messages.id, id));
    if (!target) return undefined;
    const row = { id: messages.id, sentAt: messages.sentAt, text: messages.text, subject: messages.subject, author: people.displayName };
    const live = and(eq(messages.threadId, target.threadId), isNull(messages.deletedAt));
    const before = await tx.select(row).from(messages).leftJoin(people, eq(people.id, messages.authorPersonId)).where(and(live, lte(messages.sentAt, target.sentAt))).orderBy(desc(messages.sentAt)).limit(AROUND + 1);
    const after = await tx.select(row).from(messages).leftJoin(people, eq(people.id, messages.authorPersonId)).where(and(live, gte(messages.sentAt, target.sentAt))).orderBy(asc(messages.sentAt)).limit(AROUND + 1);
    const seen = new Set<string>();
    const around = [...before.reverse(), ...after].filter((m) => !seen.has(m.id) && seen.add(m.id));
    return { target, around };
  });
  // Not there, or not visible to this person: the same answer either way.
  if (!data) notFound();
  const source = sourceOf(data.target.provider);

  return (
    <div className="thread-view">
      <div>
        <Link className="link small" href="/">
          ← Back to the agent
        </Link>
        <h1>{data.target.title ?? "Conversation"}</h1>
        <p className="muted small">
          {source.label} · {data.target.kind}
          {data.target.url && (
            <>
              {" · "}
              <a className="link" href={data.target.url} target="_blank" rel="noreferrer">
                Open in {source.label}
              </a>
            </>
          )}
        </p>
      </div>
      <ol className="thread-messages">
        {data.around.map((m) => (
          <li key={m.id} id={m.id === id ? "cited" : undefined} className={m.id === id ? "cited" : undefined}>
            <div className="small">
              <strong>{m.author ?? "Unknown"}</strong> <span className="muted mono">{formatShort(m.sentAt, org.timezone)}</span>
              {m.id === id && <span className="tag">cited</span>}
            </div>
            <p className="clamp-none">{m.subject ? `${m.subject}: ${m.text}` : m.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
