import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { appOf, pendingFor, recentFor, type Approval } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { markAsDone, sendAgainAnyway, tryAgain } from "./actions";
import { WaitingForm } from "./waiting-card";

export const metadata: Metadata = { title: "Approvals · ALRO" };

const STATUS: Record<string, string> = { done: "Done", failed: "Failed", running: "Sending", unknown: "Not confirmed", rejected: "Dropped", expired: "Expired" };
const ORIGIN: Record<string, string> = { chat: "you asked", messaging: "you asked by message", routine: "scheduled task", meeting: "after a call", team: "agent team" };

/** Sending reaches people; a live-tool call changes data in that app. */
const sends = (a: Approval) => !a.mcpServerId && a.audience === "external";

export default function ApprovalsPage() {
  return (
    <>
      <h1>Approvals</h1>
      <p className="muted">
        Everything ALRO wants to send or change waits here until you say so. You can edit the text first. You can also reply &quot;yes CODE&quot; or &quot;no CODE&quot; in WhatsApp, Telegram, Slack or Teams. Anything
        left undecided expires by itself.
      </p>
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
                {a.expiresAt && ` · expires ${when(a.expiresAt)}`}
              </span>
            </div>
            {a.reason && <p className="muted small">Why: {a.reason}</p>}
            {a.caution && (
              <p className="notice error small" role="alert">
                Check before approving. {a.caution}
              </p>
            )}
            <WaitingForm a={{ id: a.id, revision: a.revision, body: a.body, json: !!a.mcpServerId, approveLabel: sends(a) ? "Approve and send" : "Approve" }} />
          </article>
        ))}
      </section>
      <section className="column">
        <p className="label">Recently</p>
        {recent.length === 0 && <p className="muted small">Nothing yet.</p>}
        <ul className="timeline">
          {recent.map((a) => {
            // A send the server never finished recording is as uncertain as one the app never answered.
            const status = a.crashed ? "unknown" : a.status;
            return (
              <li key={a.id}>
                <span className={`small${status === "failed" || status === "unknown" ? " error" : ""}`}>{STATUS[status] ?? status}{status === "done" && a.approvedBy === "trusted task" ? " (trusted)" : ""}</span>
                <span className="truncate">
                  {a.result?.url ? (
                    <a className="link" href={a.result.url} target="_blank" rel="noreferrer">
                      {a.summary}
                    </a>
                  ) : (
                    a.summary
                  )}
                  {status === "unknown" ? (
                    <span className="error small">
                      {" "}
                      · {appOf(a)} didn&apos;t answer, so this may or may not have gone through. Check {appOf(a)} before sending again.
                    </span>
                  ) : (
                    a.error && <span className="error small"> · {a.error}</span>
                  )}
                </span>
                <span className="muted small mono nowrap">{when(a.decidedAt ?? a.updatedAt)}</span>
                {status === "failed" && (
                  <form action={tryAgain} className="actions">
                    <input type="hidden" name="id" value={a.id} />
                    <button className="chip-button" title="Puts it back under Waiting so you can read it and approve it again">
                      Retry
                    </button>
                  </form>
                )}
                {status === "unknown" && (
                  <form className="actions">
                    <input type="hidden" name="id" value={a.id} />
                    <button formAction={markAsDone} className="chip-button" title={`You checked ${appOf(a)} and it's there`}>
                      Mark as done
                    </button>
                    <button formAction={sendAgainAnyway} className="chip-button danger" title={`Sends it now. If the first one did go through, ${appOf(a)} will have it twice`}>
                      Send again anyway
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
