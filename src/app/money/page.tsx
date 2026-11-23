import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { money, daysOverdue, openReceivables, receivablesSummary } from "@/business/receivables";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { ActionForm, RowButton } from "../desk-form";
import { closeInvoice, refreshMoney, remindInvoice, snoozeInvoice } from "../desk-actions";

export const metadata: Metadata = { title: "Money owed · ALRO" };

export default function MoneyPage() {
  return (
    <>
      <h1>Money owed</h1>
      <p className="muted">
        Overdue invoices from your accounting and payment apps. ALRO drafts a reminder a day after the due date, then weekly (three at most), and you approve each one before it goes. When an invoice is paid it counts as
        recovered if a reminder went out first.
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Money />
      </Suspense>
    </>
  );
}

async function Money() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can see what customers owe.</p>;
  const db = getDb();
  const [summary, invoices] = await Promise.all([receivablesSummary(db, viewer.orgId), openReceivables(db, viewer.orgId, 200)]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <div className="stats">
        {summary.length === 0 && <p className="muted">Nothing owed, or no accounting or payment app connected yet (Xero, QuickBooks, Stripe or Razorpay under Settings → Sources).</p>}
        {summary.map((s) => (
          <article key={s.currency} className="card">
            <p className="label">{s.currency}</p>
            <p>
              <strong>{money(s.outstanding, s.currency)}</strong> owed · <strong>{money(s.overdue, s.currency)}</strong> overdue ({s.overdueCount})
            </p>
            <p className="muted">Recovered after reminders in the last 90 days: {money(s.recovered, s.currency)} ({s.recoveredCount} invoices)</p>
          </article>
        ))}
      </div>
      <ActionForm action={refreshMoney} button="Read the apps now" ghost />
      {invoices.map((r) => {
        const late = daysOverdue(r, today);
        return (
          <article key={r.id} className="card">
            <header className="card-head">
              <strong>{r.customer ?? "Unknown customer"}</strong> · {r.number ?? "no number"} · {money(r.amountDue, r.currency)}
            </header>
            <p className="muted">
              {r.dueOn ? (late ? `${late} days overdue (due ${r.dueOn})` : `due ${r.dueOn}`) : "no due date"} · {r.remindersSent} reminder{r.remindersSent === 1 ? "" : "s"} sent
              {r.snoozedUntil && r.snoozedUntil > new Date() ? ` · paused until ${r.snoozedUntil.toISOString().slice(0, 10)}` : ""}
              {!r.email && !r.phone ? " · no email or phone known" : ""}
            </p>
            <div className="row">
              <RowButton action={remindInvoice} id={r.id} label="Remind now" ghost={false} />
              <RowButton action={snoozeInvoice} id={r.id} label="Pause 14 days" extra={{ days: "14" }} />
              <RowButton action={closeInvoice} id={r.id} label="Mark paid" />
            </div>
          </article>
        );
      })}
    </>
  );
}
