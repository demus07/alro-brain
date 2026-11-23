import { and, asc, eq, inArray } from "drizzle-orm";
import { notifyPerson } from "@/channels/links";
import type { Db } from "@/db/client";
import { deadlines, orgs } from "@/db/schema";
import { errorText, log } from "@/ops/log";
import { primaryApprover } from "./settings";

export type Deadline = typeof deadlines.$inferSelect;
export const KINDS = ["licence", "contract", "filing", "renewal", "payment", "other"] as const;
export const REPEATS = ["none", "monthly", "quarterly", "yearly"] as const;
export type Repeat = (typeof REPEATS)[number];
const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const localDay = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The same day-of-month in a later month, or its last day when that month is shorter. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
export const nextDue = (day: string, repeat: Repeat) => (repeat === "monthly" ? addMonths(day, 1) : repeat === "quarterly" ? addMonths(day, 3) : repeat === "yearly" ? addMonths(day, 12) : undefined);

/** Standard dates for an Indian business. Dates are the usual statutory ones; due dates are sometimes extended, so each says to check. */
export const INDIA_PRESETS: { preset: string; title: string; kind: "filing" | "payment"; day: number; month?: number; repeat: Repeat; remindDays: number[] }[] = [
  { preset: "in-gstr1", title: "GSTR-1 (outward supplies), monthly filers", kind: "filing", day: 11, repeat: "monthly", remindDays: [5, 1] },
  { preset: "in-gstr3b", title: "GSTR-3B (summary return and tax payment)", kind: "filing", day: 20, repeat: "monthly", remindDays: [5, 1] },
  { preset: "in-tds-pay", title: "TDS payment for last month", kind: "payment", day: 7, repeat: "monthly", remindDays: [5, 1] },
  { preset: "in-pf-esi", title: "PF and ESI contribution", kind: "payment", day: 15, repeat: "monthly", remindDays: [5, 1] },
  { preset: "in-itr", title: "Income-tax return (non-audit)", kind: "filing", day: 31, month: 7, repeat: "yearly", remindDays: [30, 7, 1] },
  { preset: "in-adv-tax-jun", title: "Advance tax, 1st instalment", kind: "payment", day: 15, month: 6, repeat: "yearly", remindDays: [14, 3] },
  { preset: "in-adv-tax-sep", title: "Advance tax, 2nd instalment", kind: "payment", day: 15, month: 9, repeat: "yearly", remindDays: [14, 3] },
  { preset: "in-adv-tax-dec", title: "Advance tax, 3rd instalment", kind: "payment", day: 15, month: 12, repeat: "yearly", remindDays: [14, 3] },
  { preset: "in-adv-tax-mar", title: "Advance tax, final instalment", kind: "payment", day: 15, month: 3, repeat: "yearly", remindDays: [14, 3] },
];

/** The first date on or after `today` for a preset. */
function firstDue(p: (typeof INDIA_PRESETS)[number], today: string): string {
  const [y, m] = today.split("-").map(Number);
  for (let n = 0; n < 25; n++) {
    const cand = p.month ? `${y + Math.floor((m - 1 + n * 12) / 12)}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` : addMonths(`${y}-${String(m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`, n);
    if (cand >= today) return cand;
  }
  return today;
}

export async function addIndiaPresets(db: Db, orgId: string, ownerPersonId: string | null, now = new Date()): Promise<number> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const today = localDay(now, org.timezone);
  const rows = await db
    .insert(deadlines)
    .values(INDIA_PRESETS.map((p) => ({ orgId, title: p.title, kind: p.kind, dueOn: firstDue(p, today), repeat: p.repeat, remindDays: p.remindDays, ownerPersonId, preset: p.preset, notes: "A usual due date; it can be extended by notification, so confirm with your accountant." })))
    .onConflictDoNothing()
    .returning({ id: deadlines.id });
  return rows.length;
}

export interface DeadlineInput {
  title: string;
  kind?: (typeof KINDS)[number];
  dueOn: string;
  repeat?: Repeat;
  remindDays?: number[];
  ownerPersonId?: string | null;
  notes?: string | null;
}

export async function addDeadline(db: Db, orgId: string, input: DeadlineInput, now = new Date()): Promise<Deadline> {
  const title = input.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  if (!title) throw new Error("What is the date for?");
  if (!DAY.test(input.dueOn) || Number.isNaN(Date.parse(input.dueOn))) throw new Error("Use a date like 2026-12-31.");
  const remind = [...new Set((input.remindDays ?? [30, 7, 1]).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);
  const [row] = await db
    .insert(deadlines)
    .values({ orgId, title, kind: input.kind ?? "other", dueOn: input.dueOn, repeat: input.repeat ?? "none", remindDays: remind.length ? remind : [7, 1], ownerPersonId: input.ownerPersonId ?? null, notes: input.notes?.slice(0, 1000) ?? null, createdAt: now, updatedAt: now })
    .returning();
  return row;
}

/** Done. A repeating one moves to its next date; the rest are closed. */
export async function completeDeadline(db: Db, orgId: string, id: string, now = new Date()) {
  const [d] = await db.select().from(deadlines).where(and(eq(deadlines.id, id), eq(deadlines.orgId, orgId)));
  if (!d) throw new Error("Not found");
  const next = nextDue(d.dueOn, d.repeat as Repeat);
  if (next) await db.update(deadlines).set({ dueOn: next, lastRemindedDay: null, updatedAt: now }).where(eq(deadlines.id, id));
  else await db.update(deadlines).set({ status: "done", doneAt: now, updatedAt: now }).where(eq(deadlines.id, id));
  return next;
}

export async function removeDeadline(db: Db, orgId: string, id: string) {
  const [r] = await db.delete(deadlines).where(and(eq(deadlines.id, id), eq(deadlines.orgId, orgId))).returning({ id: deadlines.id });
  if (!r) throw new Error("Not found");
}

export const listDeadlines = (db: Db, orgId: string, status: ("open" | "done")[] = ["open"]) => db.select().from(deadlines).where(and(eq(deadlines.orgId, orgId), inArray(deadlines.status, status))).orderBy(asc(deadlines.dueOn));

export interface DeadlineStats {
  reminded: number;
  overdue: number;
}

/**
 * Tells the owner of each date that has come within one of its reminder windows (30, 7 and 1 days by default), once per
 * window, and again each day once it is overdue. A repeating date that has passed unconfirmed is carried forward only when marked done.
 */
export async function runDeadlines(db: Db, orgId: string, now = new Date()): Promise<DeadlineStats> {
  const stats: DeadlineStats = { reminded: 0, overdue: 0 };
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const today = localDay(now, org.timezone);
  const fallback = await primaryApprover(db, orgId);
  for (const d of await listDeadlines(db, orgId)) {
    const left = daysBetween(today, d.dueOn);
    // The tightest window not yet announced: 7 days out announces "7", not the "30" it also falls inside.
    const window = left < 0 ? left : [...d.remindDays].sort((a, b) => a - b).find((w) => left <= w);
    if (window === undefined || d.lastRemindedDay === window) continue;
    const who = d.ownerPersonId ?? fallback?.id;
    if (!who) continue;
    const when = left < 0 ? `was due ${-left} day${left === -1 ? "" : "s"} ago` : left === 0 ? "is due today" : `is due in ${left} day${left === 1 ? "" : "s"} (${d.dueOn})`;
    try {
      await notifyPerson(db, orgId, who, `${d.title} ${when}.${d.notes ? ` ${d.notes}` : ""} Mark it done in ALRO under Deadlines.`, now);
    } catch (e) {
      log.warn("deadlines.notify_failed", { orgId, id: d.id, error: errorText(e) });
      continue;
    }
    await db.update(deadlines).set({ lastRemindedDay: window }).where(eq(deadlines.id, d.id));
    stats.reminded++;
    if (left < 0) stats.overdue++;
  }
  return stats;
}
