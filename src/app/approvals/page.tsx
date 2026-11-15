import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { pendingFor, recentFor, type Approval } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { sourceOf } from "@/lib/sources";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { approve, reject, tryAgain } from "./actions";

export const metadata: Metadata = { title: "Approvals · ALRO" };

const ORIGIN: Record<string, string> = { chat: "you asked", messaging: "you asked by message", routine: "scheduled task", meeting: "after a call", team: "agent team" };

/** "gmail_send_email" → Gmail; a live-tool server's proposals start with its name ("Test CRM: create_note"). */
const appOf = (a: Approval) => (a.mcpServerId ? a.summary.split(":")[0] : sourceOf(a.tool.split("_")[0]).label);
/** Sending reaches people; a live-tool call changes data in that app. */
const sends = (a: Approval) => !a.mcpServerId && a.audience === "external";

export default function ApprovalsPage() {
  return (
    <>
      <h1>Approvals</h1>
      <p className="muted">Everything ALRO wants to send or change waits here until you say so. You can edit the text first. You can also reply &quot;yes CODE&quot; or &quot;no CODE&quot; in WhatsApp, Telegram, Slack or Teams.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Approvals />
      </Suspense>
    </>
  );
}

async function Approvals() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const [pending, recent] = await Promise.all([pendingFor(db, viewer), recentFor(db, viewer)]);
  const when = (d: Date) => formatShort(d, org.timezone);
  return (
    <div className="split">
      <section className="column">
        <p className="label">Waiting for you · {pending.length}</p>
        {pending.length === 0 && <p className="muted">Nothing waiting.</p>}
        {pending.map((a) => (
          <article key={a.id} className="card">
            <header className="card-head">
              <strong className="truncate">{a.summary}</strong>
              <span className="mono small nowrap">{a.code}</span>
            </header>
            <div className="chips">
              <span className="chip">{appOf(a)}</span>
              {a.mcpServerId ? <span className="tag warn">changes data</span> : sends(a) ? <span className="tag warn">goes outside the company</span> : <span className="tag">internal</span>}
              <span className="muted small">
                {ORIGIN[a.origin] ?? a.origin} · {when(a.createdAt)}
              </span>
            </div>
            {a.reason && <p className="muted small">Why: {a.reason}</p>}
            <form action={approve} className="stack">
              <input type="hidden" name="id" value={a.id} />
              {a.body !== null && (
                <textarea name="body" defaultValue={a.body} rows={Math.min(14, Math.max(4, a.body.split("\n").length + 1))} aria-label={a.mcpServerId ? "What it will send to the app (JSON)" : "Text to send"} className={a.mcpServerId ? "mono small" : undefined} />
              )}
              <div className="row">
                <button>{sends(a) ? "Approve and send" : "Approve"}</button>
                <button formAction={reject} className="ghost">
                  Drop it
                </button>
              </div>
            </form>
          </article>
        ))}
      </section>
      <section className="column">
        <p className="label">Recently</p>
        {recent.length === 0 && <p className="muted small">Nothing yet.</p>}
        <ul className="timeline">
          {recent.map((a) => (
            <li key={a.id}>
              <span className={`small${a.status === "failed" ? " error" : ""}`}>{a.status === "done" ? (a.approvedBy === "trusted task" ? "Ran (trusted)" : "Done") : a.status === "failed" ? "Failed" : a.status === "running" ? "Running" : "Dropped"}</span>
              <span className="truncate">
                {a.result?.url ? (
                  <a className="link" href={a.result.url} target="_blank" rel="noreferrer">
                    {a.summary}
                  </a>
                ) : (
                  a.summary
                )}
                {a.error && <span className="error small"> · {a.error}</span>}
              </span>
              <span className="muted small mono nowrap">{when(a.decidedAt ?? a.updatedAt)}</span>
              {(a.status === "failed" || a.stuck) && (
                <form action={tryAgain} className="actions">
                  <input type="hidden" name="id" value={a.id} />
                  <button className="chip-button" title={a.status === "running" ? "It stopped part-way and may have gone through: check the app before approving it again" : undefined}>
                    {a.status === "running" ? "Stuck: retry" : "Retry"}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
