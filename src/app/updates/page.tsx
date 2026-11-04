import { aliasedTable, and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { commitmentEvents, commitments, connections, messages, orgs, people, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { sourceOf } from "@/lib/sources";
import { buildBrief } from "@/notify/brief";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { setVerdict } from "../commitments/actions";

export const metadata: Metadata = { title: "Updates · ALRO" };

export default function UpdatesPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Updates />
    </Suspense>
  );
}

const EVENT_TEXT: Record<string, string> = {
  created: "Promise noticed",
  done: "Kept",
  cancelled: "Called off",
  dismissed: "Dismissed",
  overdue: "Now overdue",
  due_soon: "Due soon",
  open: "Reopened",
};

async function Updates() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const when = (d: Date) => formatShort(d, org.timezone);
  const author = aliasedTable(people, "author");
  const counterparty = aliasedTable(people, "counterparty");

  const { incoming, needsYou, events } = await withScope(db, viewer, async (tx) => ({
    incoming: await tx
      .select({
        id: messages.id,
        text: messages.text,
        subject: messages.subject,
        sentAt: messages.sentAt,
        url: messages.url,
        provider: connections.provider,
        thread: threads.title,
        author: author.displayName,
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(connections, eq(connections.id, messages.connectionId))
      .leftJoin(author, eq(author.id, messages.authorPersonId))
      // Bare attachments ("[media]") say nothing on their own.
      .where(and(isNull(messages.deletedAt), ne(messages.text, "[media]")))
      .orderBy(desc(messages.sentAt))
      .limit(40),
    needsYou: await tx
      .select({
        id: commitments.id,
        title: commitments.title,
        quote: commitments.quote,
        status: commitments.status,
        dueAt: commitments.dueAt,
        dueText: commitments.dueText,
        counterparty: sql<string | null>`coalesce(${counterparty.displayName}, ${commitments.counterpartyText})`,
      })
      .from(commitments)
      .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
      .where(and(eq(commitments.ownerPersonId, viewer.personId), inArray(commitments.status, ["overdue", "due_soon"])))
      .orderBy(sql`${commitments.dueAt} asc nulls last`)
      .limit(8),
    events: await tx
      .select({
        id: commitmentEvents.id,
        type: commitmentEvents.type,
        toStatus: commitmentEvents.toStatus,
        at: commitmentEvents.createdAt,
        title: commitments.title,
      })
      .from(commitmentEvents)
      .innerJoin(commitments, eq(commitments.id, commitmentEvents.commitmentId))
      .where(inArray(commitmentEvents.type, ["created", "status_changed"]))
      .orderBy(desc(commitmentEvents.createdAt))
      .limit(12),
  }));

  const overdue = needsYou.filter((c) => c.status === "overdue").length;
  const brief = await buildBrief(db, viewer, org.timezone);
  const tiles = [
    { label: "Overdue", value: brief.overdue.length, tone: brief.overdue.length ? "bad" : "" },
    { label: "Due soon", value: brief.dueSoon.length, tone: brief.dueSoon.length ? "warn" : "" },
    { label: "Waiting on you", value: brief.waitingOnYou.length, tone: "" },
    { label: "Owed to you", value: brief.owedToYou.length, tone: "" },
    { label: "Messages, last 24h", value: brief.messages, tone: "" },
  ];

  return (
    <>
    <div className="today">
      <h1>Today</h1>
      <div className="tiles">
        {tiles.map((t) => (
          <div key={t.label} className={`tile ${t.tone}`}>
            <span className="tile-value">{t.value}</span>
            <span className="muted small">{t.label}</span>
          </div>
        ))}
      </div>
      {brief.active.length > 0 && (
        <p className="muted small">
          Busiest in the last day: {brief.active.map((a) => `${a.title} (${a.messages})`).join(", ")}. {brief.newPromises} new promises, {brief.changedFacts} facts changed.
        </p>
      )}
    </div>
    <div className="split">
      <section className="column">
        <p className="label center">Incoming · all channels</p>
        {incoming.length === 0 && <p className="muted center">No messages yet. Connect a source or upload an export.</p>}
        {incoming.map((m) => {
          const source = sourceOf(m.provider);
          const body = m.subject ? `${m.subject}: ${m.text}` : m.text;
          return (
            <article key={m.id} className="card">
              <header className="card-head">
                <span className="chip">
                  <b>{source.mark}</b> {source.label}
                </span>
                <span className="muted small truncate">
                  {[m.author ?? "Unknown", m.thread !== m.author && m.thread].filter(Boolean).join(" · ")}
                </span>
                <span className="muted small mono nowrap">{when(m.sentAt)}</span>
              </header>
              <p className="clamp">{body.length > 400 ? `${body.slice(0, 400)}…` : body}</p>
              {m.url && (
                <a className="small link" href={m.url} target="_blank" rel="noreferrer">
                  Open in {source.label}
                </a>
              )}
            </article>
          );
        })}
      </section>

      <section className="column">
        <p className="label center">ALRO noticed</p>
        <article className="card">
          <p className="lead">
            {needsYou.length === 0
              ? "Nothing of yours is due or overdue."
              : `You have ${overdue ? `${overdue} overdue` : ""}${overdue && needsYou.length > overdue ? " and " : ""}${needsYou.length > overdue ? `${needsYou.length - overdue} due soon` : ""}.`}
          </p>
          {needsYou.map((c) => (
            <div key={c.id} className="todo">
              <div>
                <strong>{c.title}</strong>
                <div className="muted small">
                  {c.counterparty ? `To ${c.counterparty} · ` : ""}
                  <span className={c.status === "overdue" ? "error" : ""}>
                    {c.status === "overdue" ? "Overdue" : "Due"} {c.dueAt ? when(c.dueAt) : (c.dueText ?? "")}
                  </span>
                </div>
                <div className="muted small quote">“{c.quote}”</div>
              </div>
              <form action={setVerdict} className="actions">
                <input type="hidden" name="id" value={c.id} />
                <button name="verdict" value="done">
                  Mark done
                </button>
                <button name="verdict" value="not_a_promise" className="ghost">
                  Not a promise
                </button>
              </form>
            </div>
          ))}
          <p className="mono small muted center">Nothing changes without your approval</p>
        </article>

        {events.length > 0 && (
          <>
            <p className="label center">Recently</p>
            <ul className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="small">{EVENT_TEXT[e.type === "created" ? "created" : (e.toStatus ?? "")] ?? e.type}</span>
                  <span className="truncate">{e.title}</span>
                  <span className="muted small mono nowrap">{when(e.at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
    </>
  );
}
