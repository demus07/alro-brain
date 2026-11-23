import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { approvals, documents, orgs, type DocumentLine } from "@/db/schema";
import type { Db } from "@/db/client";
import { proposeOutreach } from "./outreach";
import { money } from "./receivables";
import { deskSettings, primaryApprover } from "./settings";

export type Doc = typeof documents.$inferSelect;
export type DocKind = "quote" | "invoice";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface DocInput {
  kind: DocKind;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerTaxId?: string | null;
  customerAddress?: string | null;
  items: DocumentLine[];
  currency?: string;
  issuedOn?: string;
  dueOn?: string | null;
  notes?: string | null;
  fromDocumentId?: string | null;
}

export function totals(items: DocumentLine[]) {
  const subtotal = r2(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const tax = r2(items.reduce((s, i) => s + (i.quantity * i.unitPrice * (i.taxRate || 0)) / 100, 0));
  return { subtotal, tax, total: r2(subtotal + tax) };
}

/** Indian financial year ("2026-27") for a date: April to March. */
export const financialYear = (day: string) => {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
};

const clean = (v: string | null | undefined, max: number) => v?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null;

function validItems(items: DocumentLine[]): DocumentLine[] {
  if (!items.length || items.length > 100) throw new Error("A document needs between 1 and 100 lines.");
  return items.map((i) => {
    const description = clean(i.description, 300);
    if (!description || !(i.quantity > 0) || !(i.unitPrice >= 0) || !(i.taxRate >= 0 && i.taxRate <= 100) || [i.quantity, i.unitPrice, i.taxRate].some((n) => !Number.isFinite(n))) throw new Error(`Check this line: "${i.description}". It needs a description, a quantity above 0, a price and a tax rate from 0 to 100.`);
    return { description, quantity: i.quantity, unitPrice: i.unitPrice, taxRate: i.taxRate };
  });
}

/** Next number for the company, e.g. INV-2026-27-0007: one sequence per kind and financial year. */
async function nextNumber(db: Db, orgId: string, kind: DocKind, issuedOn: string) {
  const desk = await deskSettings(db, orgId);
  const prefix = (kind === "quote" ? desk.documents?.quotePrefix : desk.documents?.invoicePrefix) || (kind === "quote" ? "QUO" : "INV");
  const head = `${prefix}-${financialYear(issuedOn)}-`;
  const [{ n }] = await db.select({ n: sql<number>`coalesce(max(substring(${documents.number} from '[0-9]+$')::int), 0)::int` }).from(documents).where(and(eq(documents.orgId, orgId), eq(documents.kind, kind), like(documents.number, `${head}%`)));
  return `${head}${String(n + 1).padStart(4, "0")}`;
}

export async function createDocument(db: Db, orgId: string, personId: string, input: DocInput, now = new Date()): Promise<Doc> {
  const name = clean(input.customerName, 160);
  if (!name) throw new Error("Who is it for?");
  const items = validItems(input.items);
  const issuedOn = input.issuedOn ?? now.toISOString().slice(0, 10);
  const t = totals(items);
  for (let attempt = 0; ; attempt++) {
    try {
      const [doc] = await db
        .insert(documents)
        .values({
          orgId,
          kind: input.kind,
          number: await nextNumber(db, orgId, input.kind, issuedOn),
          customerName: name,
          customerEmail: clean(input.customerEmail, 200)?.toLowerCase() ?? null,
          customerPhone: clean(input.customerPhone, 40),
          customerTaxId: clean(input.customerTaxId, 40),
          customerAddress: clean(input.customerAddress, 400),
          items,
          currency: (input.currency ?? "INR").toUpperCase().slice(0, 3),
          ...t,
          issuedOn,
          dueOn: input.dueOn ?? (input.kind === "invoice" ? new Date(Date.parse(`${issuedOn}T00:00:00Z`) + 15 * 86_400_000).toISOString().slice(0, 10) : null),
          notes: clean(input.notes, 1000),
          shareToken: randomBytes(24).toString("base64url"),
          fromDocumentId: input.fromDocumentId ?? null,
          createdBy: personId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return doc;
    } catch (e) {
      // Two documents made at once took the same number: try the next.
      if (attempt < 3 && /documents_number_uq|duplicate key/.test(String(e) + String((e as { cause?: unknown }).cause))) continue;
      throw e;
    }
  }
}

/** An accepted quote becomes an invoice with the same lines. */
export async function invoiceFromQuote(db: Db, orgId: string, personId: string, quoteId: string, now = new Date()): Promise<Doc> {
  const [q] = await db.select().from(documents).where(and(eq(documents.id, quoteId), eq(documents.orgId, orgId), eq(documents.kind, "quote")));
  if (!q) throw new Error("Quote not found");
  const [existing] = await db.select().from(documents).where(and(eq(documents.fromDocumentId, q.id), eq(documents.kind, "invoice")));
  if (existing && existing.status !== "void") return existing;
  const invoice = await createDocument(db, orgId, personId, { kind: "invoice", customerName: q.customerName, customerEmail: q.customerEmail, customerPhone: q.customerPhone, customerTaxId: q.customerTaxId, customerAddress: q.customerAddress, items: q.items, currency: q.currency, notes: q.notes, fromDocumentId: q.id }, now);
  await db.update(documents).set({ status: "accepted", updatedAt: now }).where(eq(documents.id, q.id));
  return invoice;
}

export async function setDocumentStatus(db: Db, orgId: string, id: string, status: "accepted" | "paid" | "void", now = new Date()) {
  const [r] = await db.update(documents).set({ status, updatedAt: now }).where(and(eq(documents.id, id), eq(documents.orgId, orgId))).returning({ id: documents.id });
  if (!r) throw new Error("Not found");
}

export const listDocuments = (db: Db, orgId: string, limit = 100) => db.select().from(documents).where(eq(documents.orgId, orgId)).orderBy(desc(documents.createdAt)).limit(limit);
export const documentByToken = async (db: Db, token: string) => (await db.select().from(documents).where(eq(documents.shareToken, token)))[0];

export const shareUrl = (d: Pick<Doc, "shareToken">) => `${(process.env.ALRO_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/docs/${d.shareToken}`;

/** The standard PDF fonts only hold Western European letters: anything else becomes "?" rather than failing the whole file. */
const safe = (s: string, font: PDFFont) => {
  let out = "";
  for (const ch of s.replace(/₹/g, "Rs. ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
};

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(safe(next, font), size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** A plain, printable A4 document. The company's name, tax ID, address and terms come from its settings. */
export async function renderPdf(db: Db, doc: Doc): Promise<Uint8Array> {
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, doc.orgId));
  const desk = (await deskSettings(db, doc.orgId)).documents ?? {};
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const H = 842;
  const M = 48;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.4, 0.4, 0.45);
  const text = (s: string, x: number, size = 10, font = regular, color = ink) => page.drawText(safe(s, font), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font = regular) => {
    const t = safe(s, font);
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color: ink });
  };
  const ensure = (need: number) => {
    if (y - need < M + 30) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };

  text(org?.name ?? "", M, 18, bold);
  y -= 16;
  for (const l of [desk.taxId ? `GSTIN / Tax ID: ${desk.taxId}` : "", ...(desk.address ? wrap(desk.address, regular, 9, 260) : [])].filter(Boolean)) {
    text(l, M, 9, regular, grey);
    y -= 12;
  }
  const top = H - M;
  y = top;
  right(doc.kind === "quote" ? "QUOTATION" : "TAX INVOICE", W - M, 18, bold);
  y -= 16;
  right(`No. ${doc.number}`, W - M);
  y -= 13;
  right(`Date: ${doc.issuedOn}`, W - M);
  if (doc.dueOn) {
    y -= 13;
    right(`${doc.kind === "quote" ? "Valid until" : "Due"}: ${doc.dueOn}`, W - M);
  }
  y = Math.min(y, top - 70) - 10;

  text("Bill to", M, 9, regular, grey);
  y -= 13;
  text(doc.customerName, M, 11, bold);
  y -= 13;
  for (const l of [...(doc.customerAddress ? wrap(doc.customerAddress, regular, 9, 300) : []), doc.customerTaxId ? `GSTIN / Tax ID: ${doc.customerTaxId}` : "", doc.customerEmail ?? "", doc.customerPhone ?? ""].filter(Boolean)) {
    text(l, M, 9, regular, grey);
    y -= 12;
  }
  y -= 14;

  const cols = { desc: M, qty: 330, price: 400, tax: 440, amount: W - M };
  const header = () => {
    page.drawRectangle({ x: M - 4, y: y - 5, width: W - 2 * M + 8, height: 18, color: rgb(0.94, 0.94, 0.95) });
    text("Description", cols.desc, 9, bold);
    right("Qty", cols.qty + 20, 9, bold);
    right("Price", cols.price + 20, 9, bold);
    right("Tax %", cols.tax + 30, 9, bold);
    right("Amount", cols.amount, 9, bold);
    y -= 20;
  };
  header();
  for (const i of doc.items) {
    const lines = wrap(i.description, regular, 10, 270);
    ensure(lines.length * 13 + 8);
    if (y > H - M - 5) header();
    const first = y;
    lines.forEach((l, n) => {
      y = first - n * 13;
      text(l, cols.desc);
    });
    y = first;
    right(String(i.quantity), cols.qty + 20);
    right(i.unitPrice.toFixed(2), cols.price + 20);
    right(String(i.taxRate), cols.tax + 30);
    right((i.quantity * i.unitPrice).toFixed(2), cols.amount);
    y = first - lines.length * 13 - 4;
  }
  y -= 6;
  page.drawLine({ start: { x: 330, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.5, color: grey });
  ensure(80);
  for (const [label, value, font] of [["Subtotal", doc.subtotal, regular], ["Tax", doc.tax, regular], ["Total", doc.total, bold]] as const) {
    text(label, 340, 10, font);
    right(money(Number(value), doc.currency).replace(/₹\s?/, "Rs. "), cols.amount, font === bold ? 12 : 10, font);
    y -= font === bold ? 18 : 14;
  }
  if (doc.notes) {
    y -= 8;
    ensure(40);
    text("Notes", M, 9, regular, grey);
    y -= 12;
    for (const l of wrap(doc.notes, regular, 9, W - 2 * M)) {
      ensure(12);
      text(l, M, 9);
      y -= 12;
    }
  }
  if (desk.terms) {
    y -= 8;
    ensure(40);
    text("Terms", M, 9, regular, grey);
    y -= 12;
    for (const l of wrap(desk.terms, regular, 9, W - 2 * M)) {
      ensure(12);
      text(l, M, 9, regular, grey);
      y -= 12;
    }
  }
  return pdf.save();
}

/** Proposes sending the customer a link to the document, for the approver to OK. Marks it sent once that goes out (see syncDocumentStatuses). */
export async function proposeSend(db: Db, orgId: string, id: string, now = new Date()) {
  const [doc] = await db.select().from(documents).where(and(eq(documents.id, id), eq(documents.orgId, orgId)));
  if (!doc) throw new Error("Not found");
  const approver = await primaryApprover(db, orgId);
  if (!approver) throw new Error("The company has no owner or admin to approve it.");
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  const what = doc.kind === "quote" ? "quotation" : "invoice";
  const total = money(Number(doc.total), doc.currency);
  const body = `Hello ${doc.customerName.split(/\s+/)[0]},\n\nPlease find our ${what} ${doc.number} for ${total}:\n${shareUrl(doc)}\n\nLet us know if you have any questions.\n\n${approver.name}\n${org?.name ?? ""}`;
  const sent = await proposeOutreach(db, orgId, approver.id, { email: doc.customerEmail, phone: doc.customerPhone }, { subject: `${what[0].toUpperCase()}${what.slice(1)} ${doc.number} from ${org?.name ?? "us"}`, body }, `${what[0].toUpperCase()}${what.slice(1)} ${doc.number} (${total}) for ${doc.customerName}`, now);
  if (sent.ok) await db.update(documents).set({ lastApprovalId: sent.approvalId, updatedAt: now }).where(eq(documents.id, doc.id));
  return sent;
}

/** Documents whose send was approved and went out are marked sent. */
export async function syncDocumentStatuses(db: Db, orgId: string, now = new Date()) {
  const rows = await db
    .update(documents)
    .set({ status: "sent", updatedAt: now })
    .where(and(eq(documents.orgId, orgId), eq(documents.status, "draft"), sql`${documents.lastApprovalId} in (select id from ${approvals} where status = 'done')`))
    .returning({ id: documents.id });
  return rows.length;
}
