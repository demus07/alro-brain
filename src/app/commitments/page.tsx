import { aliasedTable, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { commitments, messages, orgs, people, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { setVerdict } from "./actions";

export const metadata: Metadata = { title: "Commitments · ALRO" };

const VIEWS = {
  mine: "I owe",
  waiting: "Waiting on others",
  all: "Everything I can see",
} as const;
type View = keyof typeof VIEWS;

const GROUPS = [
  { title: "Overdue", statuses: ["overdue"] },
  { title: "Due soon", statuses: ["due_soon"] },
  { title: "Open", statuses: ["open"] },
  { title: "Recently closed", statuses: ["done", "cancelled", "dismissed"] },
] as const;

export default function CommitmentsPage({ searchParams }: PageProps<"/commitments">) {
  return (
    <>
      <h1>Commitments</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <CommitmentList searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function CommitmentList({ searchParams }: { searchParams: PageProps<"/commitments">["searchParams"] }) {
  await connection();
  const params = await searchParams;
  const view: View = typeof params.view === "string" && params.view in VIEWS ? (params.view as View) : "mine";
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const owner = aliasedTable(people, "owner");
  const counterparty = aliasedTable(people, "counterparty");

  const rows = await withScope(db, viewer, (tx) =>
    tx
      .select({
        id: commitments.id,
        title: commitments.title,
        quote: commitments.quote,
        status: commitments.status,
        dueAt: commitments.dueAt,
        dueText: commitments.dueText,
        closedAt: commitments.closedAt,
        ownerId: commitments.ownerPersonId,
        counterpartyId: commitments.counterpartyPersonId,
        owner: owner.displayName,
        counterparty: counterparty.displayName,
        counterpartyText: commitments.counterpartyText,
        thread: threads.title,
        url: messages.url,
        sentAt: messages.sentAt,
      })
      .from(commitments)
      .leftJoin(owner, eq(owner.id, commitments.ownerPersonId))
      .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
      .innerJoin(messages, eq(messages.id, commitments.sourceMessageId))
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(
        and(
          view === "mine" ? eq(commitments.ownerPersonId, viewer.personId) : undefined,
          view === "waiting" ? eq(commitments.counterpartyPersonId, viewer.personId) : undefined,
          // Closed ones only for the last two weeks.
          or(
            inArray(commitments.status, ["open", "due_soon", "overdue"]),
            sql`${commitments.closedAt} > now() - interval '14 days'`,
          ),
        ),
      )
      .orderBy(sql`${commitments.dueAt} asc nulls last`, desc(commitments.createdAt))
      .limit(300),
  );

  return (
    <>
      <nav className="tabs" aria-label="Whose promises">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} href={`/commitments?view=${v}`} aria-current={v === view ? "page" : undefined}>
            {VIEWS[v]}
          </Link>
        ))}
      </nav>
      {rows.length === 0 && <p className="muted">Nothing here yet.</p>}
      {GROUPS.map((group) => {
        const items = rows.filter((r) => (group.statuses as readonly string[]).includes(r.status));
        if (!items.length) return null;
        return (
          <section key={group.title}>
            <h2 className="section-title">
              {group.title} <span className="muted">({items.length})</span>
            </h2>
            <div className="scroll">
              <table>
                <tbody>
                  {items.map((c) => {
                    const party = c.ownerId === viewer.personId || c.counterpartyId === viewer.personId;
                    const open = ["open", "due_soon", "overdue"].includes(c.status);
                    return (
                      <tr key={c.id}>
                        <td>
                          <div>
                            <strong>{c.title}</strong>
                          </div>
                          <div className="muted small">
                            {c.owner ?? "Someone"} → {c.counterparty ?? c.counterpartyText ?? "?"} · “{c.quote}” ·{" "}
                            {c.url ? (
                              <a className="link" href={c.url} target="_blank" rel="noreferrer">
                                {c.thread}
                              </a>
                            ) : (
                              c.thread
                            )}
                            , {formatShort(c.sentAt, org.timezone)}
                          </div>
                        </td>
                        <td className="nowrap small">
                          {open
                            ? c.dueAt
                              ? `Due ${formatShort(c.dueAt, org.timezone)}`
                              : (c.dueText ?? "No deadline")
                            : `${c.status === "done" ? "Done" : c.status === "cancelled" ? "Cancelled" : "Dismissed"}${c.closedAt ? ` ${formatShort(c.closedAt, org.timezone)}` : ""}`}
                        </td>
                        <td className="nowrap">
                          {party && (
                            <form action={setVerdict} className="actions">
                              <input type="hidden" name="id" value={c.id} />
                              {open ? (
                                <>
                                  <button name="verdict" value="done">
                                    Mark done
                                  </button>
                                  <button name="verdict" value="not_a_promise" className="ghost">
                                    Not a promise
                                  </button>
                                </>
                              ) : (
                                <button name="verdict" value="reopen" className="ghost">
                                  Reopen
                                </button>
                              )}
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
