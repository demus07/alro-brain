import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { asRole, endAllSessions, type Role } from "@/auth/sessions";
import type { Db } from "@/db/client";
import { approvals, channelLinkCodes, channelLinks, connections, credentials, invitations, people, routines, sessions } from "@/db/schema";
import { DEPARTMENT } from "@/db/scope";
import { deleteSecret } from "@/lib/secrets";
import { isAdmin } from "./roles";

type Actor = { orgId: string; personId: string; role: Role };

/** A plain-English reason an admin change was refused. */
export class MemberError extends Error {}

/** Members, and people who were removed (shown so they can be restored). */
const everMember = or(eq(people.isMember, true), isNotNull(people.deactivatedAt));

export const listMembers = (db: Db, orgId: string) =>
  db
    .select({ id: people.id, name: people.displayName, email: people.primaryEmail, role: people.role, department: people.department, deactivatedAt: people.deactivatedAt, createdAt: people.createdAt })
    .from(people)
    .where(and(eq(people.orgId, orgId), everMember))
    .orderBy(asc(people.displayName));

/**
 * The member an admin wants to change, if they may: admins manage members, and only an owner
 * changes an owner or another admin. Used for every change, including reset links and invitations,
 * so there is no side door to someone more senior's account.
 */
export async function manageable(db: Db, actor: Actor, personId: string) {
  if (!isAdmin(actor)) throw new MemberError("Only an admin can do that.");
  const [person] = await db.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, actor.orgId), everMember));
  if (!person) throw new MemberError("That person isn't a member of this company.");
  if (person.role === "owner" && actor.role !== "owner") throw new MemberError("Only an owner can change an owner.");
  if (person.role === "admin" && actor.role !== "owner" && person.id !== actor.personId) throw new MemberError("Only an owner can change another admin.");
  return person;
}

const target = manageable;

async function assertAnotherOwner(db: Db, orgId: string, exceptPersonId: string) {
  const [other] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isMember, true), eq(people.role, "owner"), isNull(people.deactivatedAt), ne(people.id, exceptPersonId)))
    .limit(1);
  if (!other) throw new MemberError("A company needs at least one owner. Make someone else an owner first.");
}

export async function setRole(db: Db, actor: Actor, personId: string, role: string) {
  const person = await target(db, actor, personId);
  const next = asRole(role);
  if (next === "owner" && actor.role !== "owner") throw new MemberError("Only an owner can make someone an owner.");
  if (person.role === "owner" && next !== "owner") await assertAnotherOwner(db, actor.orgId, personId);
  await db.update(people).set({ role: next }).where(eq(people.id, personId));
  return { from: person.role, to: next, email: person.primaryEmail };
}

/** Moves someone to a department (or none). Their access to department-limited sources changes at once. */
export async function setDepartment(db: Db, actor: Actor, personId: string, department: string | null) {
  const person = await target(db, actor, personId);
  const slug = department?.trim() || null;
  if (slug && !DEPARTMENT.test(slug)) throw new MemberError("A department is a short name like finance or sales.");
  await db.update(people).set({ department: slug }).where(eq(people.id, personId));
  return { from: person.department, to: slug, email: person.primaryEmail };
}

/**
 * Removes a member's access the moment they leave: signs them out everywhere, unlinks their
 * messaging apps, stops their scheduled tasks and their personal sources, and drops what was
 * waiting for their approval. What they connected stays in the company's memory, visible only
 * to the people who could already see it.
 */
export async function deactivateMember(db: Db, actor: Actor, personId: string, now = new Date()) {
  const person = await target(db, actor, personId);
  if (personId === actor.personId) throw new MemberError("You can't remove yourself. Ask another admin.");
  if (person.role === "owner") await assertAnotherOwner(db, actor.orgId, personId);
  // No longer a member anywhere it's checked: sign-in, briefs, reminders, messaging, scheduled work.
  await db.update(people).set({ deactivatedAt: now, isMember: false }).where(eq(people.id, personId));
  await endAllSessions(db, personId);
  await db.delete(credentials).where(eq(credentials.personId, personId));
  await db.delete(channelLinks).where(eq(channelLinks.personId, personId));
  // A messaging link code or a reset link made just before they left must not let them back in.
  await db.delete(channelLinkCodes).where(eq(channelLinkCodes.personId, personId));
  await db.delete(invitations).where(eq(invitations.personId, personId));
  await db.update(routines).set({ enabled: false, nextRunAt: null }).where(eq(routines.ownerPersonId, personId));
  await db.update(approvals).set({ status: "rejected", decidedAt: now }).where(and(eq(approvals.personId, personId), eq(approvals.status, "pending")));
  const personal = await db
    .update(connections)
    .set({ status: "revoked", lastError: "Its owner left the company" })
    .where(and(eq(connections.orgId, actor.orgId), eq(connections.scope, "personal"), eq(connections.ownerPersonId, personId), ne(connections.status, "revoked")))
    .returning({ id: connections.id });
  for (const c of personal) await deleteSecret(db, "connection", c.id);
  return { email: person.primaryEmail, sourcesStopped: personal.length };
}

/** Lets a removed member back in. They need a new invitation to set a password. */
export async function reactivateMember(db: Db, actor: Actor, personId: string) {
  const person = await target(db, actor, personId);
  if (!person.deactivatedAt) throw new MemberError("They're already a member.");
  await db.update(people).set({ deactivatedAt: null, isMember: true }).where(eq(people.id, personId));
  return { email: person.primaryEmail };
}

/** Where a member is signed in. */
export const sessionsOf = (db: Db, personId: string) =>
  db.select({ id: sessions.id, method: sessions.method, userAgent: sessions.userAgent, ip: sessions.ip, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt }).from(sessions).where(eq(sessions.personId, personId)).orderBy(asc(sessions.createdAt));

export async function endSessions(db: Db, personId: string, ids: string[]) {
  if (ids.length) await db.delete(sessions).where(and(eq(sessions.personId, personId), inArray(sessions.id, ids)));
}
