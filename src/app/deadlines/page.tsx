import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { listDeadlines, KINDS, REPEATS } from "@/business/deadlines";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { ActionForm, RowButton } from "../desk-form";
import { doneDeadline, dropDeadline, indiaDates, newDeadline } from "../desk-actions";

export const metadata: Metadata = { title: "Deadlines · ALRO" };

export default function DeadlinesPage() {
  return (
    <>
      <h1>Deadlines</h1>
      <p className="muted">Licences, contracts, filings and renewals. You&apos;re told on your linked messaging app 30, 7 and 1 days before (changeable), and every day once it&apos;s overdue. Repeating ones move on when you mark them done.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Deadlines />
      </Suspense>
    </>
  );
}

async function Deadlines() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can see deadlines.</p>;
  const rows = await listDeadlines(getDb(), viewer.orgId);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="split">
      <section className="column">
        {rows.length === 0 && <p className="muted">Nothing yet. Add the usual Indian filing dates, or your own.</p>}
        {rows.map((d) => (
          <article key={d.id} className="card">
            <header className="card-head">
              <strong>{d.title}</strong> · {d.dueOn}
              {d.dueOn < today ? " · overdue" : ""}
            </header>
            <p className="muted">
              {d.kind}
              {d.repeat !== "none" ? ` · repeats ${d.repeat}` : ""} · reminders {d.remindDays.join(", ")} days before{d.notes ? ` · ${d.notes}` : ""}
            </p>
            <div className="row">
              <RowButton action={doneDeadline} id={d.id} label="Done" ghost={false} />
              <RowButton action={dropDeadline} id={d.id} label="Remove" />
            </div>
          </article>
        ))}
      </section>
      <section className="column">
        <p className="label">Add one</p>
        <ActionForm action={newDeadline} button="Add" className="stack">
          <input name="title" placeholder="FSSAI licence renewal" required />
          <input name="due" type="date" required />
          <select name="kind" defaultValue="other">
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <select name="repeat" defaultValue="none">
            {REPEATS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </ActionForm>
        <ActionForm action={indiaDates} button="Add the usual Indian filing dates" ghost />
      </section>
    </div>
  );
}
