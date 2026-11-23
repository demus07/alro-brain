import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { withRetries } from "@/connectors/api";
import { providerOf } from "@/connectors/registry";
import { sessionFor } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, connections, orgs, receivables } from "@/db/schema";
import { errorText, log } from "@/ops/log";
import { proposeOutreach, type Message } from "./outreach";
import { normalizePhone } from "./phone";
import { deskSettings, primaryApprover, reminderRules } from "./settings";

export type Receivable = typeof receivables.$inferSelect;

const DAY_MS = 86_400_000;
/** A read this long may have stopped at the app's page limit, so what it doesn't list isn't assumed paid. */
const READ_LIMIT = 400;
/** Reminders proposed per run, so a first sync of a long backlog doesn't flood the owner. */
const PER_RUN = 15;

export const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR" }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

const localDay = (date: Date, timeZone: string) => date.toLocaleDateString("en-CA", { timeZone });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const daysOverdue = (r: Pick<Receivable, "dueOn">, today: string) => (r.dueOn ? Math.max(0, daysBetween(r.dueOn, today)) : 0);

export interface SyncStats {
  connections: number;
  seen: number;
  paid: number;
  errors: string[];
}

/**
 * Reads what customers still owe from every connected accounting or payment app and keeps a copy. An invoice the
 * app stops listing as owed has been paid (or cancelled): it is marked paid, which is how recovery is measured.
 */
export async function syncReceivables(db: Db, orgId: string, now = new Date()): Promise<SyncStats> {
  const stats: SyncStats = { connections: 0, seen: 0, paid: 0, errors: [] };
  const rows = await db.select().from(connections).where(and(eq(connections.orgId, orgId), eq(connections.status, "active")));
  for (const c of rows) {
    const provider = providerOf(c.provider);
    if (!provider?.receivables) continue;
    stats.connections++;
    try {
      const { api, credentials } = await sessionFor(db, provider, c);
      const invoices = await provider.receivables(withRetries(api), { accountId: c.externalAccountId ?? "", credentials });
      for (const i of invoices) {
        if (i.amountDue <= 0) continue;
        const values = { number: i.number ?? null, customer: i.customer ?? null, email: i.email?.toLowerCase() ?? null, phone: i.phone ?? null, currency: i.currency || "INR", amountDue: i.amountDue, dueOn: i.dueOn ?? null, url: i.url ?? null };
        await db
          .insert(receivables)
          .values({ orgId, connectionId: c.id, externalId: i.externalId, ...values, firstSeenAt: now, lastSeenAt: now })
          .onConflictDoUpdate({ target: [receivables.connectionId, receivables.externalId], set: { ...values, status: "open", paidAt: null, lastSeenAt: now } });
        stats.seen++;
      }
      if (invoices.length < READ_LIMIT) {
        const closed = await db
          .update(receivables)
          .set({ status: "paid", paidAt: now })
          .where(and(eq(receivables.connectionId, c.id), eq(receivables.status, "open"), sql`${receivables.lastSeenAt} < ${now.toISOString()}::timestamptz`))
          .returning({ id: receivables.id });
        stats.paid += closed.length;
      }
    } catch (e) {
      stats.errors.push(`${c.provider}: ${errorText(e)}`);
      log.warn("receivables.sync_failed", { connectionId: c.id, provider: c.provider, error: errorText(e) });
    }
  }
  return stats;
}

/** What goes out at each stage: friendly, then firmer, then final. */
export function reminderMessage(r: Receivable, stage: number, late: number, sender: string): Message {
  const amount = money(r.amountDue, r.currency);
  const invoice = r.number ? `invoice ${r.number}` : "your invoice";
  const hello = r.customer ? `Hello ${r.customer},` : "Hello,";
  const link = r.url ? `\n\nYou can view and pay it here: ${r.url}` : "";
  const due = r.dueOn ? new Date(`${r.dueOn}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  const lead =
    stage === 0
      ? `A quick reminder that ${invoice} for ${amount} was due on ${due}. Could you let us know when we can expect the payment?`
      : stage === 1
        ? `Following up on ${invoice} for ${amount}, now ${late} days past its due date of ${due}. Please let us know when it will be paid, or if there's anything holding it up.`
        : `This is a final reminder about ${invoice} for ${amount}, ${late} days overdue. Please arrange payment this week, or call us if there's an issue we can help with.`;
  const body = `${hello}\n\n${lead}${link}\n\nIf you've already paid, please ignore this and thank you.\n\n${sender}`;
  const template = process.env.WHATSAPP_REMINDER_TEMPLATE;
  return {
    subject: r.number ? `Payment reminder: invoice ${r.number}` : "Payment reminder",
    body,
    whatsapp: {
      text: body,
      // Replies within 24 hours of the customer's last message are free text; otherwise WhatsApp needs an approved template: {{1}} name, {{2}} invoice, {{3}} amount, {{4}} due date.
      template: template ? { name: template, language: process.env.WHATSAPP_REMINDER_TEMPLATE_LANG ?? "en", params: [r.customer ?? "there", r.number ?? "", amount, due] } : undefined,
    },
  };
}

export interface ChaseStats {
  proposed: number;
  /** Overdue but no email, phone or way to send. */
  unreachable: number;
  waiting: number;
}

/**
 * For each overdue invoice that's due a reminder, proposes one to the owner. The first goes a day after the due date,
 * then weekly, at most three (all adjustable), never while the last is still waiting for an answer, never for a snoozed
 * invoice. Nothing is sent: the owner approves each one.
 */
export async function chaseReceivables(db: Db, orgId: string, now = new Date(), only?: string): Promise<ChaseStats> {
  const stats: ChaseStats = { proposed: 0, unreachable: 0, waiting: 0 };
  const approver = await primaryApprover(db, orgId);
  if (!approver) return stats;
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const rules = reminderRules(await deskSettings(db, orgId));
  const today = localDay(now, org.timezone);
  const open = await db
    .select()
    .from(receivables)
    .where(and(eq(receivables.orgId, orgId), eq(receivables.status, "open"), isNotNull(receivables.dueOn), only ? eq(receivables.id, only) : undefined))
    .orderBy(asc(receivables.dueOn));
  for (const r of open) {
    if (stats.proposed >= PER_RUN) break;
    const late = daysOverdue(r, today);
    if (!only) {
      if (late < rules.firstDays || r.remindersSent >= rules.max) continue;
      if (r.snoozedUntil && r.snoozedUntil > now) continue;
      if (r.lastRemindedAt && now.getTime() - r.lastRemindedAt.getTime() < rules.everyDays * DAY_MS) continue;
    }
    if (r.lastApprovalId) {
      const [last] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, r.lastApprovalId));
      if (last?.status === "pending") {
        stats.waiting++;
        continue;
      }
    }
    const message = reminderMessage(r, Math.min(r.remindersSent, 2), late, approver.name);
    const sent = await proposeOutreach(db, orgId, approver.id, { email: r.email, phone: normalizePhone(r.phone) }, message, `${r.customer ?? "A customer"} owes ${money(r.amountDue, r.currency)}${late ? `, ${late} days overdue` : ""}`, now);
    if (!sent.ok) {
      stats.unreachable++;
      continue;
    }
    await db.update(receivables).set({ remindersSent: r.remindersSent + 1, lastRemindedAt: now, lastApprovalId: sent.approvalId }).where(eq(receivables.id, r.id));
    stats.proposed++;
  }
  return stats;
}

export interface Summary {
  currency: string;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  /** Paid in the last 90 days after at least one reminder: what chasing brought in. */
  recovered: number;
  recoveredCount: number;
}

/** Totals per currency, never added across currencies. */
export async function receivablesSummary(db: Db, orgId: string, now = new Date()): Promise<Summary[]> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const today = localDay(now, org.timezone);
  const since = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  const rows = await db
    .select({
      currency: receivables.currency,
      outstanding: sql<number>`coalesce(sum(${receivables.amountDue}) filter (where ${receivables.status} = 'open'), 0)::float`,
      overdue: sql<number>`coalesce(sum(${receivables.amountDue}) filter (where ${receivables.status} = 'open' and ${receivables.dueOn} < ${today}::date), 0)::float`,
      overdueCount: sql<number>`count(*) filter (where ${receivables.status} = 'open' and ${receivables.dueOn} < ${today}::date)::int`,
      recovered: sql<number>`coalesce(sum(${receivables.amountDue}) filter (where ${receivables.status} = 'paid' and ${receivables.remindersSent} > 0 and ${receivables.paidAt} >= ${since}::timestamptz), 0)::float`,
      recoveredCount: sql<number>`count(*) filter (where ${receivables.status} = 'paid' and ${receivables.remindersSent} > 0 and ${receivables.paidAt} >= ${since}::timestamptz)::int`,
    })
    .from(receivables)
    .where(eq(receivables.orgId, orgId))
    .groupBy(receivables.currency);
  return rows.filter((r) => r.outstanding || r.recovered).sort((a, b) => b.outstanding - a.outstanding);
}

/** Open invoices, most overdue first. */
export const openReceivables = (db: Db, orgId: string, limit = 100) =>
  db.select().from(receivables).where(and(eq(receivables.orgId, orgId), eq(receivables.status, "open"))).orderBy(asc(receivables.dueOn), desc(receivables.amountDue)).limit(limit);

/** Don't chase this one for a while (a promise to pay, a dispute). */
export async function snoozeReceivable(db: Db, orgId: string, id: string, days: number, now = new Date()) {
  const until = new Date(now.getTime() + Math.min(Math.max(days, 1), 180) * DAY_MS);
  const [r] = await db.update(receivables).set({ snoozedUntil: until }).where(and(eq(receivables.id, id), eq(receivables.orgId, orgId))).returning({ id: receivables.id });
  if (!r) throw new Error("Not found");
  return until;
}

/** Stop chasing: it was paid outside the accounting app, or written off. It comes back only if the app lists it as owed again. */
export async function closeReceivable(db: Db, orgId: string, id: string, now = new Date()) {
  const [r] = await db.update(receivables).set({ status: "paid", paidAt: now }).where(and(eq(receivables.id, id), eq(receivables.orgId, orgId), ne(receivables.status, "paid"))).returning({ id: receivables.id });
  if (!r) throw new Error("Not found");
}

/** Proposes a reminder now whatever the cadence says (the owner pressed "Remind now"). */
export async function remindNow(db: Db, orgId: string, id: string, now = new Date()) {
  const stats = await chaseReceivables(db, orgId, now, id);
  if (stats.proposed) return "proposed" as const;
  return stats.waiting ? ("waiting" as const) : ("unreachable" as const);
}

