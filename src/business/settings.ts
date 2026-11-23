import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { orgs, people, type DeskSettings } from "@/db/schema";

/** How the desk behaves until an admin changes it. */
export const DESK_DEFAULTS = {
  reminders: { firstDays: 1, everyDays: 7, max: 3 },
  leadFollowUpDays: [2, 5, 10],
} as const;

export async function deskSettings(db: Db, orgId: string): Promise<DeskSettings> {
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  return org?.settings.desk ?? {};
}

export const reminderRules = (s: DeskSettings) => ({ ...DESK_DEFAULTS.reminders, ...s.reminders });
export const followUpDays = (s: DeskSettings): number[] => (s.leadFollowUpDays?.length ? s.leadFollowUpDays : [...DESK_DEFAULTS.leadFollowUpDays]);

/** Changes some of the desk settings, leaving the rest. */
export async function updateDeskSettings(db: Db, orgId: string, change: Partial<DeskSettings>): Promise<DeskSettings> {
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const desk = { ...org?.settings.desk, ...change };
  await db.update(orgs).set({ settings: { ...org?.settings, desk } }).where(eq(orgs.id, orgId));
  return desk;
}

/**
 * Who answers for the company: its owner first, then admins. Proposals the desk makes on its own (a payment
 * reminder, a reply to a lead) wait for this person, and handoffs from customers go to them.
 */
export async function approvers(db: Db, orgId: string) {
  const rows = await db
    .select({ id: people.id, name: people.displayName, email: people.primaryEmail, role: people.role })
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isMember, true), isNull(people.deactivatedAt)))
    .orderBy(asc(people.createdAt), asc(people.id));
  const rank = (r: string) => (r === "owner" ? 0 : r === "admin" ? 1 : 2);
  return rows.filter((r) => r.role === "owner" || r.role === "admin").sort((a, b) => rank(a.role) - rank(b.role));
}

/** The one person desk proposals are made for, if the company has an owner or admin. */
export async function primaryApprover(db: Db, orgId: string) {
  return (await approvers(db, orgId))[0];
}
