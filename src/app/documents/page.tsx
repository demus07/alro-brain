import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { listDocuments, shareUrl } from "@/business/documents";
import { money } from "@/business/receivables";
import { deskSettings } from "@/business/settings";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { ActionForm, RowButton } from "../desk-form";
import { markDoc, newDocument, saveDocumentDetails, sendDoc, toInvoice } from "../desk-actions";

export const metadata: Metadata = { title: "Quotes and invoices · ALRO" };

export default function DocumentsPage() {
  return (
    <>
      <h1>Quotes and invoices</h1>
      <p className="muted">Numbered PDFs. You can also ask the agent: &quot;quote Sharma Traders 100 pipes at 612.50 with 18% GST&quot;. Sending goes through Approvals: the customer gets a link to the PDF.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Documents />
      </Suspense>
    </>
  );
}

async function Documents() {
  await connection();
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return <p className="muted">Only owners and admins can make quotes and invoices.</p>;
  const db = getDb();
  const [docs, desk] = await Promise.all([listDocuments(db, viewer.orgId), deskSettings(db, viewer.orgId)]);
  const d = desk.documents ?? {};
  return (
    <div className="split">
      <section className="column">
        <p className="label">Documents</p>
        {docs.length === 0 && <p className="muted">None yet.</p>}
        {docs.map((x) => (
          <article key={x.id} className="card">
            <header className="card-head">
              <strong>{x.number}</strong> · {x.customerName} · {money(Number(x.total), x.currency)} · {x.status}
            </header>
            <p className="muted">
              Issued {x.issuedOn}
              {x.dueOn ? ` · ${x.kind === "quote" ? "valid until" : "due"} ${x.dueOn}` : ""} · <a href={shareUrl(x)} target="_blank" rel="noreferrer">Open PDF</a>
            </p>
            <div className="row">
              <RowButton action={sendDoc} id={x.id} label="Send to customer" ghost={false} />
              {x.kind === "quote" && <RowButton action={toInvoice} id={x.id} label="Make invoice" />}
              {x.kind === "invoice" && x.status !== "paid" && <RowButton action={markDoc} id={x.id} label="Mark paid" extra={{ status: "paid" }} />}
              {x.status !== "void" && <RowButton action={markDoc} id={x.id} label="Void" extra={{ status: "void" }} />}
            </div>
          </article>
        ))}
      </section>
      <section className="column">
        <p className="label">New</p>
        <ActionForm action={newDocument} button="Make PDF" className="stack">
          <select name="kind" defaultValue="quote">
            <option value="quote">Quotation</option>
            <option value="invoice">Tax invoice</option>
          </select>
          <input name="name" placeholder="Customer name" required />
          <input name="email" type="email" placeholder="Email (to send it)" />
          <input name="phone" placeholder="Phone / WhatsApp" />
          <input name="taxId" placeholder="Customer GSTIN (optional)" />
          <textarea name="address" rows={2} placeholder="Customer address (optional)" />
          <textarea name="lines" rows={4} placeholder={"Description | quantity | unit price | tax %\nMS pipe 2 inch | 100 | 612.50 | 18"} required />
          <textarea name="notes" rows={2} placeholder="Notes (optional)" />
        </ActionForm>
        <p className="label">On every document</p>
        <ActionForm action={saveDocumentDetails} button="Save" className="stack">
          <input name="invoicePrefix" placeholder="Invoice prefix (INV)" defaultValue={d.invoicePrefix ?? ""} />
          <input name="quotePrefix" placeholder="Quote prefix (QUO)" defaultValue={d.quotePrefix ?? ""} />
          <input name="taxId" placeholder="Your GSTIN" defaultValue={d.taxId ?? ""} />
          <textarea name="address" rows={2} placeholder="Your address" defaultValue={d.address ?? ""} />
          <textarea name="terms" rows={3} placeholder="Payment terms" defaultValue={d.terms ?? ""} />
        </ActionForm>
      </section>
    </div>
  );
}
