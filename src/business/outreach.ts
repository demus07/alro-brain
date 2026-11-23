import { proposeAction, proposeEmail } from "@/approvals/approvals";
import { whatsapp } from "@/channels/channels";
import type { Db } from "@/db/client";
import { normalizePhone } from "./phone";

export interface Contact {
  email?: string | null;
  phone?: string | null;
}

export interface Message {
  subject: string;
  body: string;
  /** What to send on WhatsApp when it differs from the email: shorter, and maybe an approved template for customers who haven't written lately. */
  whatsapp?: { text: string; template?: { name: string; language: string; params: string[] } };
}

export type Proposed = { ok: true; approvalId: string; code: string; via: "email" | "whatsapp"; summary: string } | { ok: false; why: string };

/**
 * Proposes sending something to a customer or lead, for an owner or admin to approve: by email from their own
 * mailbox when there's an address and a mailbox connected, otherwise on WhatsApp when there's a phone number and
 * the company's WhatsApp is set up. It never sends: the proposal waits under Approvals and the approver is told.
 */
export async function proposeOutreach(db: Db, orgId: string, approverId: string, to: Contact, message: Message, reason: string, now = new Date()): Promise<Proposed> {
  const viewer = { orgId, personId: approverId };
  const ctx = { origin: "desk" as const, notify: true, now };
  if (to.email) {
    const sent = await proposeEmail(db, viewer, { to: [to.email], subject: message.subject, body: message.body }, reason, ctx);
    if (sent && "approvalId" in sent) return { ok: true, approvalId: String(sent.approvalId), code: String(sent.code), via: "email", summary: String(sent.summary) };
  }
  const phone = normalizePhone(to.phone);
  if (phone && whatsapp.configured()) {
    const w = message.whatsapp ?? { text: message.body };
    const sent = await proposeAction(db, viewer, { tool: "alro_whatsapp_send" }, { to: phone, text: w.text, template: w.template }, reason, ctx);
    if ("approvalId" in sent) return { ok: true, approvalId: String(sent.approvalId), code: String(sent.code), via: "whatsapp", summary: String(sent.summary) };
  }
  if (to.email && !phone) return { ok: false, why: "Connect your Gmail or Outlook in Settings so ALRO can send from your mailbox." };
  if (phone && !whatsapp.configured() && !to.email) return { ok: false, why: "Only a phone number is known, and WhatsApp isn't set up on this server." };
  return { ok: false, why: to.email || phone ? "There's no way to send to them yet: connect your Gmail or Outlook, or set up WhatsApp." : "There's no email address or phone number for them." };
}
