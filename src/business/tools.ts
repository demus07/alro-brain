import { tool } from "ai";
import { and, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { people, receivables } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { addDeadline, KINDS, listDeadlines, REPEATS } from "./deadlines";
import { createDocument, invoiceFromQuote, proposeSend } from "./documents";
import { CATEGORIES, expenseSummary, logExpense } from "./expenses";
import { leadSummary, listLeads } from "./leads";
import { money, openReceivables, receivablesSummary, remindNow } from "./receivables";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const line = z.object({ description: z.string(), quantity: z.number().positive(), unitPrice: z.number().min(0), taxRate: z.number().min(0).max(100).describe("GST or tax percent, e.g. 18") });

/**
 * What the agent can do for the business desk. Everyone can file a receipt (a photo sent in a message is read into
 * this); money owed, leads, quotes, invoices and dates are for owners and admins. Nothing here reaches a customer
 * on its own: reminders and documents become proposals that wait for approval.
 */
export async function deskTools(db: Db, viewer: Viewer, now?: Date) {
  const [me] = await db.select({ role: people.role }).from(people).where(and(eq(people.id, viewer.personId), eq(people.orgId, viewer.orgId)));
  const senior = me?.role === "owner" || me?.role === "admin";
  const { orgId, personId } = viewer;
  const tools = {
    logExpense: tool({
      description: `Record a receipt or bill the asker paid, from a photo they sent or what they said. Read the vendor, date, total, the GST included, the vendor's GSTIN and the bill number off it; leave out what isn't shown. Category is one of: ${CATEGORIES.join(", ")}. If they paid from their own pocket, paidBy is "personal".`,
      inputSchema: z.object({ vendor: z.string(), amount: z.number().positive().describe("The total paid"), spentOn: day.nullish(), taxAmount: z.number().min(0).nullish().describe("GST included in the total"), currency: z.string().nullish(), category: z.string().nullish(), taxId: z.string().nullish().describe("Vendor GSTIN"), invoiceNumber: z.string().nullish(), paidBy: z.enum(["company", "personal"]).nullish(), note: z.string().nullish() }),
      execute: async (i) => {
        const e = await logExpense(db, orgId, personId, { ...i, spentOn: i.spentOn ?? undefined, paidBy: i.paidBy ?? undefined, currency: i.currency ?? undefined }, now);
        return { saved: true, id: e.id, vendor: e.vendor, amount: e.amount, spentOn: e.spentOn, category: e.category };
      },
    }),
  };
  if (!senior) return tools;
  return {
    ...tools,
    moneyOwed: tool({
      description: "What customers owe the company right now, from its accounting and payment apps: totals per currency (outstanding, overdue, recovered after reminders) and the most overdue invoices with who owes them.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(40).nullish() }),
      execute: async ({ limit }) => ({
        totals: await receivablesSummary(db, orgId, now),
        invoices: (await openReceivables(db, orgId, limit ?? 15)).map((r) => ({ id: r.id, number: r.number, customer: r.customer, amount: money(r.amountDue, r.currency), dueOn: r.dueOn, remindersSent: r.remindersSent })),
      }),
    }),
    remindCustomer: tool({
      description: "Draft a payment reminder for an overdue invoice and put it up for the owner's approval. Nothing is sent until approved. Find the invoice with moneyOwed first.",
      inputSchema: z.object({ invoice: z.string().describe("The invoice's id, or its number, or the customer's name") }),
      execute: async ({ invoice }) => {
        const like = `%${invoice.replace(/[%_\\]/g, "\\$&")}%`;
        const found = await db.select({ id: receivables.id, customer: receivables.customer, number: receivables.number }).from(receivables).where(and(eq(receivables.orgId, orgId), eq(receivables.status, "open"), or(eq(receivables.id, invoice.match(/^[0-9a-f-]{36}$/i) ? invoice : "00000000-0000-0000-0000-000000000000"), ilike(receivables.number, like), ilike(receivables.customer, like)))).limit(5);
        if (found.length !== 1) return { error: found.length ? `That matches ${found.length} invoices: ${found.map((f) => `${f.number ?? f.id} (${f.customer})`).join("; ")}. Say which.` : "No open invoice matches that." };
        return { result: await remindNow(db, orgId, found[0].id, now), note: "A reminder is waiting for approval under Approvals." };
      },
    }),
    leads: tool({
      description: "Recent enquiries from the website, IndiaMART and other lead sources, with who has been replied to and how fast replies go out.",
      inputSchema: z.object({}),
      execute: async () => ({ summary: await leadSummary(db, orgId), recent: (await listLeads(db, orgId, 15)).map((l) => ({ name: l.name, source: l.source, status: l.status, message: l.message.slice(0, 160), at: l.createdAt })) }),
    }),
    createQuote: tool({
      description: "Make a quotation (kind quote) or tax invoice (kind invoice) as a numbered PDF for a customer. It stays a draft: use sendDocument to put it up for approval to send.",
      inputSchema: z.object({ kind: z.enum(["quote", "invoice"]), customerName: z.string(), customerEmail: z.string().nullish(), customerPhone: z.string().nullish(), customerTaxId: z.string().nullish(), customerAddress: z.string().nullish(), items: z.array(line).min(1), notes: z.string().nullish(), dueOn: day.nullish() }),
      execute: async (i) => {
        const d = await createDocument(db, orgId, personId, { ...i, dueOn: i.dueOn ?? undefined }, now);
        return { id: d.id, number: d.number, total: money(Number(d.total), d.currency), status: d.status };
      },
    }),
    invoiceFromQuote: tool({
      description: "Turn an accepted quote into an invoice with the same lines.",
      inputSchema: z.object({ quoteId: z.string() }),
      execute: async ({ quoteId }) => {
        const d = await invoiceFromQuote(db, orgId, personId, quoteId, now);
        return { id: d.id, number: d.number, total: money(Number(d.total), d.currency) };
      },
    }),
    sendDocument: tool({
      description: "Put a quote or invoice up for approval to be sent to the customer as a link, by email or WhatsApp. Nothing is sent until approved.",
      inputSchema: z.object({ documentId: z.string() }),
      execute: async ({ documentId }) => {
        const r = await proposeSend(db, orgId, documentId, now);
        return r.ok ? { status: "waiting for approval", code: r.code, via: r.via } : { error: r.why };
      },
    }),
    addDeadline: tool({
      description: "Remember a date that can't be missed (a licence or contract expiring, a filing, a renewal) and remind the owner ahead of it.",
      inputSchema: z.object({ title: z.string(), dueOn: day, kind: z.enum(KINDS).nullish(), repeat: z.enum(REPEATS).nullish(), remindDaysBefore: z.array(z.number().int().min(0).max(365)).nullish().describe("Default 30, 7 and 1") }),
      execute: async (i) => {
        const d = await addDeadline(db, orgId, { title: i.title, dueOn: i.dueOn, kind: i.kind ?? undefined, repeat: i.repeat ?? undefined, remindDays: i.remindDaysBefore ?? undefined, ownerPersonId: personId }, now);
        return { saved: true, id: d.id, dueOn: d.dueOn };
      },
    }),
    deadlines: tool({ description: "The upcoming dates that can't be missed.", inputSchema: z.object({}), execute: async () => (await listDeadlines(db, orgId)).slice(0, 30).map((d) => ({ title: d.title, kind: d.kind, dueOn: d.dueOn, repeat: d.repeat })) }),
    expenseTotals: tool({
      description: "What the company has spent in a period, by category, with GST and what is owed back to people who paid themselves.",
      inputSchema: z.object({ from: day.nullish(), to: day.nullish() }),
      execute: async ({ from, to }) => expenseSummary(db, orgId, { from: from ?? undefined, to: to ?? undefined }),
    }),
  };
}
