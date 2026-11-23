"use server";

import { refresh } from "next/cache";
import { addFaq, removeFaq, resumeAssistant, staffReply } from "@/business/assistant";
import { addDeadline, addIndiaPresets, completeDeadline, removeDeadline, KINDS, REPEATS } from "@/business/deadlines";
import { createDocument, invoiceFromQuote, proposeSend, setDocumentStatus } from "@/business/documents";
import { deleteExpense, logExpense } from "@/business/expenses";
import { setLeadStatus } from "@/business/leads";
import { closeReceivable, remindNow, snoozeReceivable, syncReceivables } from "@/business/receivables";
import { updateDeskSettings } from "@/business/settings";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { requireAdmin } from "@/platform/roles";

export interface DeskState {
  error?: string;
  note?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => Number(str(f, k).replace(/,/g, ""));

/** Every desk action: an admin only, and a refusal comes back as text for the form rather than an error page. */
async function run(fn: (ctx: { db: ReturnType<typeof getDb>; orgId: string; personId: string }) => Promise<string | void>): Promise<DeskState> {
  const viewer = await getViewer();
  requireAdmin(viewer);
  try {
    const note = await fn({ db: getDb(), orgId: viewer.orgId, personId: viewer.personId });
    refresh();
    return note ? { note } : {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

export const refreshMoney = async (): Promise<DeskState> => run(async ({ db, orgId }) => {
  const s = await syncReceivables(db, orgId);
  return s.errors.length ? `Read ${s.seen} invoices. ${s.errors.join("; ")}` : `Read ${s.seen} open invoices${s.paid ? `, ${s.paid} paid since last time` : ""}.`;
});
export const remindInvoice = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  const r = await remindNow(db, orgId, str(f, "id"));
  return r === "proposed" ? "A reminder is waiting under Approvals." : r === "waiting" ? "One is already waiting for your approval." : "There's no email address or phone number to send it to, or no way to send yet.";
});
export const snoozeInvoice = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => void (await snoozeReceivable(db, orgId, str(f, "id"), num(f, "days") || 7)));
export const closeInvoice = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => closeReceivable(db, orgId, str(f, "id")));

export const leadStatus = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  const s = str(f, "status");
  if (s !== "won" && s !== "lost" && s !== "replied") throw new Error("Unknown status");
  await setLeadStatus(db, orgId, str(f, "id"), s);
});

export const saveAssistant = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  await updateDeskSettings(db, orgId, { customerAssistant: f.get("enabled") === "on", businessInfo: str(f, "info").slice(0, 2000) });
  return "Saved.";
});
export const newFaq = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => void (await addFaq(db, orgId, str(f, "question"), str(f, "answer"))));
export const dropFaq = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => void (await removeFaq(db, orgId, str(f, "id"))));
export const replyToCustomer = async (_: DeskState, f: FormData) => {
  const viewer = await getViewer();
  requireAdmin(viewer);
  try {
    await staffReply(getDb(), viewer.orgId, viewer.personId, str(f, "id"), str(f, "text"));
    refresh();
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't send." };
  }
};
export const handBack = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => resumeAssistant(db, orgId, str(f, "id")));

/** "Description | quantity | unit price | tax %" per line. */
function parseLines(raw: string) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [description, qty, price, tax] = l.split("|").map((p) => p.trim());
      return { description, quantity: Number((qty ?? "1").replace(/,/g, "")), unitPrice: Number((price ?? "0").replace(/,/g, "")), taxRate: Number((tax ?? "18").replace(/%/g, "")) };
    });
}
export const newDocument = async (_: DeskState, f: FormData) => run(async ({ db, orgId, personId }) => {
  const kind = str(f, "kind") === "quote" ? "quote" : "invoice";
  const d = await createDocument(db, orgId, personId, { kind, customerName: str(f, "name"), customerEmail: str(f, "email") || null, customerPhone: str(f, "phone") || null, customerTaxId: str(f, "taxId") || null, customerAddress: str(f, "address") || null, items: parseLines(str(f, "lines")), notes: str(f, "notes") || null });
  return `Made ${d.number}.`;
});
export const sendDoc = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  const r = await proposeSend(db, orgId, str(f, "id"));
  if (!r.ok) throw new Error(r.why);
  return `Waiting for your approval under Approvals (${r.via}).`;
});
export const toInvoice = async (_: DeskState, f: FormData) => run(async ({ db, orgId, personId }) => `Made ${(await invoiceFromQuote(db, orgId, personId, str(f, "id"))).number}.`);
export const markDoc = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  const s = str(f, "status");
  if (s !== "accepted" && s !== "paid" && s !== "void") throw new Error("Unknown status");
  await setDocumentStatus(db, orgId, str(f, "id"), s);
});
export const saveDocumentDetails = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  await updateDeskSettings(db, orgId, { documents: { quotePrefix: str(f, "quotePrefix").slice(0, 8) || undefined, invoicePrefix: str(f, "invoicePrefix").slice(0, 8) || undefined, taxId: str(f, "taxId").slice(0, 40) || undefined, address: str(f, "address").slice(0, 400) || undefined, terms: str(f, "terms").slice(0, 1000) || undefined } });
  return "Saved.";
});

export const newExpense = async (_: DeskState, f: FormData) => run(async ({ db, orgId, personId }) => {
  await logExpense(db, orgId, personId, { vendor: str(f, "vendor"), amount: num(f, "amount"), spentOn: str(f, "date") || undefined, taxAmount: str(f, "tax") ? num(f, "tax") : null, category: str(f, "category") || null, taxId: str(f, "gstin") || null, invoiceNumber: str(f, "invoice") || null, paidBy: str(f, "paidBy") === "personal" ? "personal" : "company" });
});
export const dropExpense = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => deleteExpense(db, orgId, str(f, "id")));

export const newDeadline = async (_: DeskState, f: FormData) => run(async ({ db, orgId, personId }) => {
  const kind = KINDS.find((k) => k === str(f, "kind"));
  const repeat = REPEATS.find((r) => r === str(f, "repeat"));
  await addDeadline(db, orgId, { title: str(f, "title"), dueOn: str(f, "due"), kind, repeat, ownerPersonId: personId });
});
export const doneDeadline = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => {
  const next = await completeDeadline(db, orgId, str(f, "id"));
  return next ? `Done. The next one is ${next}.` : "Done.";
});
export const dropDeadline = async (_: DeskState, f: FormData) => run(async ({ db, orgId }) => removeDeadline(db, orgId, str(f, "id")));
export const indiaDates = async (): Promise<DeskState> => run(async ({ db, orgId, personId }) => {
  const n = await addIndiaPresets(db, orgId, personId);
  return n ? `Added ${n} dates.` : "They're already there.";
});

