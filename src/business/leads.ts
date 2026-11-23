import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { approvals, leads, orgs } from "@/db/schema";
import { derivedToken, matchesDerivedToken } from "@/lib/secrets";
import { proposeOutreach, type Message } from "./outreach";
import { normalizePhone } from "./phone";
import { deskSettings, followUpDays, primaryApprover } from "./settings";

export type Lead = typeof leads.$inferSelect;

const DAY_MS = 86_400_000;
const OPEN = ["new", "replied", "following"];
/** Proposals per run, so a burst of enquiries doesn't flood the owner. */
const PER_RUN = 20;

export interface LeadInput {
  source: string;
  externalId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  message: string;
}

const clean = (v: string | null | undefined, max: number) => v?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null;

/** The address a company's web form or lead source posts to; the token is theirs alone. */
export const leadToken = (orgId: string) => derivedToken("leads", orgId);
export const leadTokenMatches = (orgId: string, token: string) => matchesDerivedToken("leads", orgId, token);

/** Records an enquiry. The same one arriving twice (same source and id) is one lead. Returns undefined for a repeat. */
export async function createLead(db: Db, orgId: string, input: LeadInput, now = new Date()): Promise<Lead | undefined> {
  const message = clean(input.message, 4000);
  if (!message) throw new Error("An enquiry needs a message.");
  const email = clean(input.email, 200)?.toLowerCase();
  const [lead] = await db
    .insert(leads)
    .values({
      orgId,
      source: clean(input.source, 40) ?? "web",
      externalId: clean(input.externalId, 200),
      name: clean(input.name, 120),
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      phone: normalizePhone(clean(input.phone, 40)) ?? null,
      message,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!lead) return undefined;
  await proposeFirstReply(db, orgId, lead, now);
  return (await db.select().from(leads).where(eq(leads.id, lead.id)))[0];
}

/** The first answer: thanks, what happens next, who to expect it from. The approver can change every word. */
export function firstReply(lead: Lead, company: string, sender: string): Message {
  const hello = lead.name ? `Hello ${lead.name.split(/\s+/)[0]},` : "Hello,";
  const body = `${hello}\n\nThank you for contacting ${company}. We've received your message and will get back to you with the details shortly.\n\nIf it's urgent, just reply to this message.\n\n${sender}\n${company}`;
  return { subject: `Thanks for contacting ${company}`, body };
}

export function followUpReply(lead: Lead, company: string, sender: string, n: number): Message {
  const hello = lead.name ? `Hello ${lead.name.split(/\s+/)[0]},` : "Hello,";
  const lead_ = n === 0 ? "Just checking that you received our reply, and whether you'd like us to send a quote or answer anything else." : n === 1 ? "Following up on your enquiry. Is this still something you're looking at? We're glad to help with details or a quote." : "A last note on your enquiry: if the timing isn't right, no problem. Reply any time and we'll pick it up from there.";
  return { subject: `Following up: ${company}`, body: `${hello}\n\n${lead_}\n\n${sender}\n${company}` };
}

async function companyName(db: Db, orgId: string) {
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  return org?.name ?? "our team";
}

async function proposeFirstReply(db: Db, orgId: string, lead: Lead, now: Date) {
  const approver = await primaryApprover(db, orgId);
  if (!approver) return;
  const sent = await proposeOutreach(db, orgId, approver.id, lead, firstReply(lead, await companyName(db, orgId), approver.name), `New enquiry from ${lead.name ?? lead.email ?? lead.phone ?? "someone"} (${lead.source}): "${lead.message.slice(0, 120)}"`, now);
  await db.update(leads).set({ ownerPersonId: approver.id, lastApprovalId: sent.ok ? sent.approvalId : null, note: sent.ok ? null : sent.why, updatedAt: now }).where(eq(leads.id, lead.id));
}

export interface LeadStats {
  replied: number;
  followUps: number;
  cold: number;
}

/**
 * Moves leads along: a reply that was approved and sent starts the follow-up clock; when a follow-up falls due and the
 * customer hasn't written back it's proposed (2, 5 and 10 days by default); when the last one has gone unanswered the
 * lead goes quiet. Nothing is sent: each follow-up waits for the approver.
 */
export async function runLeads(db: Db, orgId: string, now = new Date()): Promise<LeadStats> {
  const stats: LeadStats = { replied: 0, followUps: 0, cold: 0 };
  const days = followUpDays(await deskSettings(db, orgId));
  const approver = await primaryApprover(db, orgId);
  const company = await companyName(db, orgId);
  const open = await db.select().from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.status, OPEN))).orderBy(leads.createdAt);
  for (const lead of open) {
    let last: string | undefined;
    if (lead.lastApprovalId) [{ status: last } = { status: undefined }] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, lead.lastApprovalId));
    if (lead.status === "new" && last === "done") {
      await db.update(leads).set({ status: "replied", firstRepliedAt: now, nextFollowUpAt: new Date(now.getTime() + days[0] * DAY_MS), updatedAt: now }).where(eq(leads.id, lead.id));
      stats.replied++;
      continue;
    }
    if (lead.status === "new" || lead.customerRepliedAt || !lead.nextFollowUpAt || lead.nextFollowUpAt > now || last === "pending") continue;
    if (lead.followUpsSent >= days.length) {
      await db.update(leads).set({ status: "lost", closedAt: now, note: "No reply after the follow-ups", nextFollowUpAt: null, updatedAt: now }).where(eq(leads.id, lead.id));
      stats.cold++;
      continue;
    }
    if (!approver || stats.followUps >= PER_RUN) continue;
    const sent = await proposeOutreach(db, orgId, approver.id, lead, followUpReply(lead, company, approver.name, lead.followUpsSent), `Follow-up ${lead.followUpsSent + 1} of ${days.length} to ${lead.name ?? lead.email ?? lead.phone ?? "an enquiry"}: no reply yet`, now);
    if (!sent.ok) continue;
    // 2, 5 and 10 days count from the first reply, not from each other.
    const next = days[lead.followUpsSent + 1];
    const from = (lead.firstRepliedAt ?? now).getTime();
    await db
      .update(leads)
      .set({ status: "following", followUpsSent: lead.followUpsSent + 1, lastApprovalId: sent.approvalId, nextFollowUpAt: new Date(Math.max(now.getTime() + DAY_MS, from + (next ?? days[days.length - 1] + 1) * DAY_MS)), updatedAt: now })
      .where(eq(leads.id, lead.id));
    stats.followUps++;
  }
  return stats;
}

/** The customer wrote back (by email or WhatsApp): the follow-ups stop. Matches on the address or phone number we hold. */
export async function noteCustomerReply(db: Db, orgId: string, from: { email?: string | null; phone?: string | null }, now = new Date()): Promise<number> {
  const email = from.email?.toLowerCase();
  const phone = normalizePhone(from.phone);
  const who = [email ? eq(leads.email, email) : undefined, phone ? eq(leads.phone, phone) : undefined].filter((c) => c !== undefined);
  if (!who.length) return 0;
  const rows = await db
    .update(leads)
    .set({ customerRepliedAt: now, nextFollowUpAt: null, updatedAt: now })
    .where(and(eq(leads.orgId, orgId), inArray(leads.status, ["replied", "following"]), isNull(leads.customerRepliedAt), or(...who)))
    .returning({ id: leads.id });
  return rows.length;
}

export async function setLeadStatus(db: Db, orgId: string, id: string, status: "won" | "lost" | "replied", now = new Date()) {
  const closed = status !== "replied";
  const [r] = await db.update(leads).set({ status, closedAt: closed ? now : null, nextFollowUpAt: closed ? null : undefined, updatedAt: now }).where(and(eq(leads.id, id), eq(leads.orgId, orgId))).returning({ id: leads.id });
  if (!r) throw new Error("Not found");
}

export const listLeads = (db: Db, orgId: string, limit = 100) => db.select().from(leads).where(eq(leads.orgId, orgId)).orderBy(desc(leads.createdAt)).limit(limit);

export interface LeadSummary {
  open: number;
  won: number;
  lost: number;
  /** Median minutes from enquiry to the first reply that went out. */
  medianReplyMinutes?: number;
}

export async function leadSummary(db: Db, orgId: string): Promise<LeadSummary> {
  const rows = await db.select({ status: leads.status, createdAt: leads.createdAt, firstRepliedAt: leads.firstRepliedAt }).from(leads).where(eq(leads.orgId, orgId));
  const gaps = rows.flatMap((r) => (r.firstRepliedAt ? [(r.firstRepliedAt.getTime() - r.createdAt.getTime()) / 60_000] : [])).sort((a, b) => a - b);
  return {
    open: rows.filter((r) => OPEN.includes(r.status)).length,
    won: rows.filter((r) => r.status === "won").length,
    lost: rows.filter((r) => r.status === "lost").length,
    medianReplyMinutes: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : undefined,
  };
}

