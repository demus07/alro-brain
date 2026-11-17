import { and, desc, eq, gt, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { credentials, invitations, orgs, people } from "@/db/schema";
import { DEPARTMENT } from "@/db/scope";
import { sign, verify } from "@/lib/secrets";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";
import { asRole, endAllSessions, hashToken, newToken, type Role } from "./sessions";

export const INVITE_DAYS = 7;
export const RESET_HOURS = 2;
export const SIGN_IN_LINK_MINUTES = 15;

const normalEmail = (email: string) => email.trim().toLowerCase();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A plain-English problem the form can show. */
export class AccountError extends Error {}

/** Anyone may create a company when sign-up is open, or when this deployment has no company yet (first run). */
export async function signUpAllowed(db: Db): Promise<boolean> {
  if (process.env.ALRO_SIGNUP === "open") return true;
  if (process.env.ALRO_SIGNUP === "closed") return false;
  return isFirstRun(db);
}

/** No company exists yet, so nobody can sign in: the first visitor sets one up. */
export async function isFirstRun(db: Db): Promise<boolean> {
  const [any] = await db.select({ id: orgs.id }).from(orgs).limit(1);
  return !any;
}

/** Serialises everything that gives an email address a password, so two requests at once can't both pass the check below. */
const lockEmail = (tx: Db, email: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alro-login:${email}`}))`);

/** An address can sign in to one company only, so sign-in by email is never ambiguous. */
async function assertEmailFree(db: Db, email: string, exceptPersonId?: string) {
  const [taken] = await db
    .select({ id: credentials.personId })
    .from(credentials)
    .innerJoin(people, eq(people.id, credentials.personId))
    .where(and(sql`lower(${people.primaryEmail}) = ${email}`, exceptPersonId ? ne(people.id, exceptPersonId) : undefined))
    .limit(1);
  if (taken) throw new AccountError("That email already has an ALRO account. Sign in instead.");
}

async function setPassword(db: Db, orgId: string, personId: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  const passwordHash = await hashPassword(password);
  await db.insert(credentials).values({ personId, orgId, passwordHash }).onConflictDoUpdate({ target: credentials.personId, set: { passwordHash, updatedAt: new Date() } });
}

/** Creates a company and its owner. */
export async function signUp(
  db: Db,
  input: {
    company: string;
    name: string;
    email: string;
    /** May be left out only when the address is proven: the owner then signs in with that provider or an emailed link. */
    password?: string;
    timezone?: string;
    /** The address was proven by a signed link (open sign-up) or by Google / Microsoft / single sign-on. */
    emailProven?: boolean;
  },
): Promise<{ orgId: string; personId: string }> {
  if (!(await signUpAllowed(db))) throw new AccountError("New companies can't be created here. Ask your admin for an invitation.");
  if (signUpNeedsEmailProof() && !input.emailProven) throw new AccountError("Confirm your email address first: use the link we sent you.");
  const email = normalEmail(input.email);
  const company = input.company.trim();
  const name = input.name.trim();
  if (!company || !name) throw new AccountError("Enter your name and your company's name.");
  if (!EMAIL.test(email)) throw new AccountError("Enter a valid email address.");
  const password = input.password ?? (input.emailProven ? undefined : "");
  const problem = password === undefined ? undefined : passwordProblem(password);
  if (problem) throw new AccountError(problem);
  const timezone = validTimeZone(input.timezone) ?? "UTC";
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockEmail(tx, email);
    await assertEmailFree(tx, email);
    const [org] = await tx.insert(orgs).values({ name: company.slice(0, 120), timezone }).returning({ id: orgs.id });
    const [person] = await tx.insert(people).values({ orgId: org.id, displayName: name.slice(0, 120), primaryEmail: email, isMember: true, role: "owner" }).returning({ id: people.id });
    if (password !== undefined) await setPassword(tx, org.id, person.id, password);
    return { orgId: org.id, personId: person.id };
  });
}

/**
 * Open sign-up (a hosted deployment anyone can join) first proves the mailbox: the form's details
 * travel in a signed, one-hour link sent to that address, and the company is only created from it.
 * Otherwise anyone could register someone else's address and wait for them to arrive.
 */
export const signUpNeedsEmailProof = () => process.env.ALRO_SIGNUP === "open";

export function signUpToken(input: { company: string; name: string; email: string; timezone?: string }): string {
  return sign({ k: "signup", c: input.company.trim().slice(0, 120), n: input.name.trim().slice(0, 120), e: normalEmail(input.email), z: input.timezone ?? "" }, 60 * 60 * 1000);
}

export function readSignUpToken(token: string | null | undefined): { company: string; name: string; email: string; timezone: string } | undefined {
  const claim = verify<{ k: string; c: string; n: string; e: string; z: string }>(token);
  return claim?.k === "signup" ? { company: claim.c, name: claim.n, email: claim.e, timezone: claim.z } : undefined;
}

/** Checks a sign-up form before any email is sent, with the same messages the final step would give. */
export async function checkSignUp(db: Db, input: { company: string; name: string; email: string }) {
  if (!(await signUpAllowed(db))) throw new AccountError("New companies can't be created here. Ask your admin for an invitation.");
  if (!input.company.trim() || !input.name.trim()) throw new AccountError("Enter your name and your company's name.");
  if (!EMAIL.test(normalEmail(input.email))) throw new AccountError("Enter a valid email address.");
}

function validTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** The member for an email and password, or undefined. Takes the same time whether or not the account exists. */
export async function signIn(db: Db, emailInput: string, password: string): Promise<{ orgId: string; personId: string } | undefined> {
  const email = normalEmail(emailInput);
  const [row] = await db
    .select({ orgId: people.orgId, personId: people.id, hash: credentials.passwordHash })
    .from(credentials)
    .innerJoin(people, eq(people.id, credentials.personId))
    .where(and(sql`lower(${people.primaryEmail}) = ${email}`, eq(people.isMember, true), isNull(people.deactivatedAt)))
    .limit(1);
  const ok = await verifyPassword(password, row?.hash);
  return ok && row ? { orgId: row.orgId, personId: row.personId } : undefined;
}

/** The active member with this email, for single sign-on (the identity provider already proved the address). */
export async function memberByEmail(db: Db, emailInput: string): Promise<{ orgId: string; personId: string } | undefined> {
  const [row] = await db
    .select({ orgId: people.orgId, personId: people.id })
    .from(people)
    .where(and(sql`lower(${people.primaryEmail}) = ${normalEmail(emailInput)}`, eq(people.isMember, true), isNull(people.deactivatedAt)))
    .orderBy(people.createdAt)
    .limit(1);
  return row;
}

/**
 * Invites someone to a company. Returns the one-time token for the link; only its hash is kept.
 * Inviting an address again replaces the earlier invitation.
 */
export async function createInvitation(
  db: Db,
  org: { orgId: string },
  input: { email: string; role?: Role; department?: string | null; invitedBy?: string; /** The inviter's role; leave out for the operator's own script. */ actorRole?: Role },
  now = new Date(),
): Promise<{ token: string; email: string }> {
  const email = normalEmail(input.email);
  if (!EMAIL.test(email)) throw new AccountError("Enter a valid email address.");
  const department = input.department?.trim() || null;
  if (department && !DEPARTMENT.test(department)) throw new AccountError("A department is a short name like finance or sales.");
  // Someone ALRO already knows from a source (a Slack user, an email correspondent) keeps their history.
  const [known] = await db
    .select({ id: people.id, isMember: people.isMember, role: people.role, department: people.department, deactivatedAt: people.deactivatedAt })
    .from(people)
    .where(and(eq(people.orgId, org.orgId), sql`lower(${people.primaryEmail}) = ${email}`))
    .limit(1);
  if (known?.deactivatedAt) throw new AccountError("They were removed from this company. Restore them first, then invite them.");
  // An existing member without a password (they signed in another way, or predate sign-in) only gets a link to set one:
  // an invitation never changes who they are, and only someone who could manage them may send it.
  const existing = known?.isMember ? known : undefined;
  if (existing) {
    const [has] = await db.select({ id: credentials.personId }).from(credentials).where(eq(credentials.personId, existing.id));
    if (has) throw new AccountError("They're already a member.");
    const senior = existing.role === "owner" || existing.role === "admin";
    if (input.actorRole && senior && input.actorRole !== "owner") throw new AccountError(`Only an owner can send ${existing.role === "owner" ? "an owner" : "another admin"} a sign-in link.`);
  }
  await assertEmailFree(db, email, known?.id);
  await db.delete(invitations).where(and(eq(invitations.orgId, org.orgId), eq(invitations.kind, "invite"), eq(invitations.email, email), isNull(invitations.usedAt)));
  const token = newToken();
  await db.insert(invitations).values({
    orgId: org.orgId,
    kind: "invite",
    email,
    personId: known?.id,
    role: existing ? asRole(existing.role) : input.role === "admin" || input.role === "owner" ? input.role : "member",
    department: existing ? existing.department : department,
    tokenHash: hashToken(token),
    invitedBy: input.invitedBy,
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
  });
  return { token, email };
}

/** Live (unused, unexpired) invitations, resets and sign-in links matching `where`, newest first, with the company's name. */
const liveInvitations = (db: Db, where: SQL | undefined, now: Date) =>
  db
    .select({ id: invitations.id, orgId: invitations.orgId, kind: invitations.kind, email: invitations.email, personId: invitations.personId, role: invitations.role, department: invitations.department, company: orgs.name })
    .from(invitations)
    .innerJoin(orgs, eq(orgs.id, invitations.orgId))
    .where(and(where, isNull(invitations.usedAt), gt(invitations.expiresAt, now)))
    .orderBy(desc(invitations.createdAt))
    .limit(1);

type Invitation = NonNullable<Awaited<ReturnType<typeof findInvitation>>>;

/** The live invitation, reset or sign-in link a token belongs to, with the company's name for the page. */
export async function findInvitation(db: Db, token: string, now = new Date()) {
  const [row] = await liveInvitations(db, eq(invitations.tokenHash, hashToken(token)), now);
  return row;
}

/** The live invitation to join a company for this address, if there is one. */
async function invitationFor(db: Db, email: string, now: Date): Promise<Invitation | undefined> {
  const [row] = await liveInvitations(db, and(eq(invitations.kind, "invite"), eq(invitations.email, normalEmail(email))), now);
  return row;
}

/** Joins the company: creates (or switches on) the member, sets their password and uses up the invitation. */
export async function acceptInvitation(db: Db, token: string, input: { name: string; password: string }, now = new Date()): Promise<{ orgId: string; personId: string }> {
  const invite = await findInvitation(db, token, now);
  if (!invite || invite.kind !== "invite") throw new AccountError("That invitation has expired or was already used. Ask for a new one.");
  const name = input.name.trim();
  if (!name) throw new AccountError("Enter your name.");
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(problem);
  return join(db, invite, name, input.password, now);
}

/**
 * Joins the company from an invitation whose address was proven another way (Google, Microsoft,
 * single sign-on or an emailed sign-in link), without a password: they keep signing in that way,
 * and can choose a password later on their account page. Without a live invitation, nobody joins.
 */
export async function acceptInvitationProven(db: Db, email: string, name: string, now = new Date()): Promise<{ orgId: string; personId: string }> {
  const invite = await invitationFor(db, email, now);
  if (!invite) throw new AccountError(`${normalEmail(email)} isn't a member of a company on ALRO yet. Ask your admin for an invitation.`);
  return join(db, invite, name.trim() || normalEmail(email).split("@")[0], undefined, now);
}

/** Creates (or switches on) the member, uses up the invitation and, when given, sets their password. */
function join(db: Db, invite: Invitation, name: string, password: string | undefined, now: Date): Promise<{ orgId: string; personId: string }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockEmail(tx, invite.email);
    await assertEmailFree(tx, invite.email, invite.personId ?? undefined);
    // Claimed first, so two tabs can't both use it.
    const [claimed] = await tx.update(invitations).set({ usedAt: now }).where(and(eq(invitations.id, invite.id), isNull(invitations.usedAt))).returning({ id: invitations.id });
    if (!claimed) throw new AccountError("That invitation was already used.");
    let personId = invite.personId;
    if (personId) {
      const [person] = await tx.select({ isMember: people.isMember, deactivatedAt: people.deactivatedAt }).from(people).where(and(eq(people.id, personId), eq(people.orgId, invite.orgId)));
      const [has] = await tx.select({ id: credentials.personId }).from(credentials).where(eq(credentials.personId, personId));
      if (!person || person.deactivatedAt || has) throw new AccountError("That invitation isn't valid any more. Ask for a new one.");
      // Someone who was already a member keeps their role, department and name: the link only lets them sign in.
      if (!person.isMember) await tx.update(people).set({ isMember: true, role: asRole(invite.role), department: invite.department, displayName: name.slice(0, 120) }).where(eq(people.id, personId));
      await endAllSessions(tx, personId);
    } else {
      [{ id: personId }] = await tx
        .insert(people)
        .values({ orgId: invite.orgId, primaryEmail: invite.email, isMember: true, role: asRole(invite.role), department: invite.department, displayName: name.slice(0, 120) })
        .returning({ id: people.id });
    }
    if (password !== undefined) await setPassword(tx, invite.orgId, personId, password);
    return { orgId: invite.orgId, personId };
  });
}

/**
 * A one-time link that signs in whoever can open this mailbox: a member, or someone with a live
 * invitation (who joins on first use). Undefined for anyone else; the caller must not reveal which.
 */
export async function createSignInLink(db: Db, emailInput: string, now = new Date()): Promise<{ token: string; email: string; orgId: string; personId?: string } | undefined> {
  const email = normalEmail(emailInput);
  const member = await memberByEmail(db, email);
  const orgId = member?.orgId ?? (await invitationFor(db, email, now))?.orgId;
  if (!orgId) return undefined;
  // Asking again replaces the earlier link.
  await db.delete(invitations).where(and(eq(invitations.kind, "signin"), eq(invitations.email, email), isNull(invitations.usedAt)));
  const token = newToken();
  await db.insert(invitations).values({ orgId, kind: "signin", email, personId: member?.personId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + SIGN_IN_LINK_MINUTES * 60_000) });
  return { token, email, orgId, personId: member?.personId };
}

/** Uses up a sign-in link: the member it belongs to, or, for an invitee, the member they just became. */
export async function redeemSignInLink(db: Db, token: string, now = new Date()): Promise<{ orgId: string; personId: string; joined: boolean }> {
  const link = await findInvitation(db, token, now);
  if (!link || link.kind !== "signin") throw new AccountError("That sign-in link has expired or was already used. Ask for a new one.");
  const [claimed] = await db.update(invitations).set({ usedAt: now }).where(and(eq(invitations.id, link.id), isNull(invitations.usedAt))).returning({ id: invitations.id });
  if (!claimed) throw new AccountError("That sign-in link was already used. Ask for a new one.");
  const member = await memberByEmail(db, link.email);
  if (member) {
    if (member.orgId !== link.orgId) throw new AccountError("That sign-in link isn't valid any more. Ask for a new one.");
    return { ...member, joined: false };
  }
  return { ...(await acceptInvitationProven(db, link.email, "", now)), joined: true };
}

/** A one-time link to choose a new password. Undefined when no such member exists (the caller must not reveal which). */
export async function createReset(db: Db, emailInput: string, now = new Date()): Promise<{ token: string; email: string; orgId: string; personId: string } | undefined> {
  const email = normalEmail(emailInput);
  const member = await memberByEmail(db, email);
  if (!member) return undefined;
  await db.delete(invitations).where(and(eq(invitations.kind, "reset"), eq(invitations.personId, member.personId)));
  const token = newToken();
  await db.insert(invitations).values({ orgId: member.orgId, kind: "reset", email, personId: member.personId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_HOURS * 3_600_000) });
  return { token, email, ...member };
}

/** Sets a new password from a reset link and signs the member out everywhere. */
export async function resetPassword(db: Db, token: string, password: string, now = new Date()): Promise<{ orgId: string; personId: string }> {
  const reset = await findInvitation(db, token, now);
  if (!reset || reset.kind !== "reset" || !reset.personId) throw new AccountError("That link has expired or was already used. Ask for a new one.");
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  const [claimed] = await db.update(invitations).set({ usedAt: now }).where(and(eq(invitations.id, reset.id), isNull(invitations.usedAt))).returning({ id: invitations.id });
  if (!claimed) throw new AccountError("That link was already used.");
  await setPassword(db, reset.orgId, reset.personId, password);
  await endAllSessions(db, reset.personId);
  return { orgId: reset.orgId, personId: reset.personId };
}

/** Changes a signed-in member's password after checking the current one, and signs out their other browsers. */
export async function changePassword(db: Db, viewer: { orgId: string; personId: string; sessionId?: string }, current: string, next: string) {
  const [row] = await db.select({ hash: credentials.passwordHash }).from(credentials).where(eq(credentials.personId, viewer.personId));
  if (row && !(await verifyPassword(current, row.hash))) throw new AccountError("That isn't your current password.");
  await setPassword(db, viewer.orgId, viewer.personId, next);
  await endAllSessions(db, viewer.personId, viewer.sessionId);
}

export const pendingInvitations = (db: Db, orgId: string, now = new Date()) =>
  db
    .select({ id: invitations.id, email: invitations.email, role: invitations.role, department: invitations.department, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
    .from(invitations)
    .where(and(eq(invitations.orgId, orgId), eq(invitations.kind, "invite"), isNull(invitations.usedAt), gt(invitations.expiresAt, now)))
    .orderBy(desc(invitations.createdAt));
