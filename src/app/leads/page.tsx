import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { leadSummary, leadToken, listLeads } from "@/business/leads";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { RowButton } from "../desk-form";
import { leadStatus } from "../desk-actions";

export const metadata: Metadata = { title: "Leads · ALRO" };

export default function LeadsPage() {
  return (
    <>
      <h1>Leads</h1>
      <p className="muted">Every enquiry gets a reply drafted at once for your approval, then follow-ups at 2, 5 and 10 days if they don&apos;t answer.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Leads />
      </Suspense>
    </>
  );
}

async function Leads() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can see leads.</p>;
  const db = getDb();
  const [summary, leads] = await Promise.all([leadSummary(db, viewer.orgId), listLeads(db, viewer.orgId)]);
  const base = (process.env.ALRO_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const address = `${base}/api/leads/${viewer.orgId}/${leadToken(viewer.orgId)}`;
  return (
    <>
      <article className="card">
        <p className="label">Where enquiries come in</p>
        <p className="muted">Point your website form, IndiaMART, a Meta lead ad or an automation at this address (POST, JSON or a form with name, email, phone and message). Keep it private.</p>
        <code className="copyable">{address}</code>
      </article>
      <p>
        {summary.open} open · {summary.won} won · {summary.lost} lost{summary.medianReplyMinutes !== undefined ? ` · replies go out in ${summary.medianReplyMinutes} min (median)` : ""}
      </p>
      {leads.length === 0 && <p className="muted">No enquiries yet.</p>}
      {leads.map((l) => (
        <article key={l.id} className="card">
          <header className="card-head">
            <strong>{l.name ?? l.email ?? l.phone ?? "Someone"}</strong> · {l.source} · {l.status}
          </header>
          <p>{l.message}</p>
          <p className="muted">
            {[l.email, l.phone && `+${l.phone}`].filter(Boolean).join(" · ")}
            {l.note ? ` · ${l.note}` : ""}
            {l.customerRepliedAt ? " · they replied" : ""}
          </p>
          {["new", "replied", "following"].includes(l.status) && (
            <div className="row">
              <RowButton action={leadStatus} id={l.id} label="Won" extra={{ status: "won" }} />
              <RowButton action={leadStatus} id={l.id} label="Lost" extra={{ status: "lost" }} />
            </div>
          )}
        </article>
      ))}
    </>
  );
}
