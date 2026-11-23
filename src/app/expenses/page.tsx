import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CATEGORIES, expenseSummary, gstinValid, listExpenses } from "@/business/expenses";
import { money } from "@/business/receivables";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { ActionForm, RowButton } from "../desk-form";
import { dropExpense, newExpense } from "../desk-actions";

export const metadata: Metadata = { title: "Expenses · ALRO" };

export default function ExpensesPage() {
  return (
    <>
      <h1>Expenses</h1>
      <p className="muted">Anyone on the team can send a photo of a bill to the ALRO bot on WhatsApp or Telegram and it is read and recorded here, with the GST on it. Export the lot for your accountant.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Expenses />
      </Suspense>
    </>
  );
}

async function Expenses() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can see the expenses. You can still send a photo of a bill to the ALRO bot to record one.</p>;
  const db = getDb();
  const [summary, rows] = await Promise.all([expenseSummary(db, viewer.orgId), listExpenses(db, viewer.orgId, {}, 200)]);
  return (
    <>
      <p>
        <a href="/expenses/export">Download as a spreadsheet (CSV)</a>
      </p>
      {summary.map((s) => (
        <article key={s.currency} className="card">
          <p>
            <strong>{money(s.total, s.currency)}</strong> across {s.count} bills · GST on them {money(s.tax, s.currency)}
            {s.toReimburse ? ` · ${money(s.toReimburse, s.currency)} to pay back to people who paid themselves` : ""}
          </p>
          <p className="muted">{s.byCategory.map((c) => `${c.category} ${money(c.total, s.currency)}`).join(" · ")}</p>
        </article>
      ))}
      <div className="split">
        <section className="column">
          {rows.length === 0 && <p className="muted">No expenses yet.</p>}
          {rows.map(({ e, who }) => (
            <article key={e.id} className="card">
              <header className="card-head">
                <strong>{e.vendor}</strong> · {money(e.amount, e.currency)} · {e.spentOn}
              </header>
              <p className="muted">
                {[e.category, e.taxAmount ? `GST ${money(e.taxAmount, e.currency)}` : "", e.taxId ? (gstinValid(e.taxId) ? `GSTIN ${e.taxId}` : `GSTIN ${e.taxId} (check this)`) : "", e.invoiceNumber && `bill ${e.invoiceNumber}`, e.paidBy === "personal" ? "paid by them: reimburse" : "", `by ${who}`].filter(Boolean).join(" · ")}
              </p>
              <RowButton action={dropExpense} id={e.id} label="Delete" />
            </article>
          ))}
        </section>
        <section className="column">
          <p className="label">Add one</p>
          <ActionForm action={newExpense} button="Save" className="stack">
            <input name="vendor" placeholder="Vendor" required />
            <input name="amount" inputMode="decimal" placeholder="Total paid" required />
            <input name="tax" inputMode="decimal" placeholder="GST included (optional)" />
            <input name="date" type="date" />
            <select name="category" defaultValue="">
              <option value="">Category</option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input name="gstin" placeholder="Vendor GSTIN (optional)" />
            <input name="invoice" placeholder="Bill number (optional)" />
            <select name="paidBy" defaultValue="company">
              <option value="company">Paid by the company</option>
              <option value="personal">Paid from their own pocket</option>
            </select>
          </ActionForm>
        </section>
      </div>
    </>
  );
}
