"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { AccountError, createInvitation, createReset, pendingInvitations } from "@/auth/accounts";
import { clientIp, endBrowserSession } from "@/auth/browser";
import { getDb } from "@/db/client";
import { verifyPassword } from "@/auth/passwords";
import { connections, credentials, invitations, orgs, threads } from "@/db/schema";
import { DEPARTMENT } from "@/db/scope";
import { audit } from "@/lib/audit";
import { escapeHtml, oneLine } from "@/lib/html";
import { appOrigin } from "@/lib/origin";
import { getViewer } from "@/lib/viewer";
import { excludeThread, includeThread } from "@/memory/forget";
import { purgeRevoked, recomputeDerivedAcls } from "@/memory/revoke";
import { sendEmail } from "@/notify/email";
import { deleteCompany } from "@/platform/data";
import { deactivateMember, listMembers, manageable, MemberError, reactivateMember, setDepartment, setRole } from "@/platform/members";
import { limitKey, rateLimit } from "@/platform/rate-limit";
import { requireAdmin } from "@/platform/roles";
import { LimitError, limitsFor } from "@/platform/usage";

export interface AdminState {
  error?: string;
  ok?: string;
  /** A one-time link to hand over when it couldn't be emailed. */
  link?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const friendly = (e: unknown) => (e instanceof MemberError || e instanceof AccountError || e instanceof LimitError ? e.message : undefined);

/** Runs an admin change; a refusal comes back as a notice at the top of the page instead of an error screen. */
async function change(run: (viewer: Awaited<ReturnType<typeof getViewer>>) => Promise<void>) {
  const viewer = await getViewer();
  try {
    requireAdmin(viewer);
    await run(viewer);
  } catch (e) {
    const message = friendly(e) ?? (e instanceof Error && e.message === "Only an admin can do that." ? e.message : undefined);
    if (!message) throw e;
    redirect(`/admin?error=${encodeURIComponent(message)}`);
  }
  refresh();
}

export async function invite(_prev: AdminState, form: FormData): Promise<AdminState> {
  const viewer = await getViewer();
  const db = getDb();
  try {
    requireAdmin(viewer);
    // Invitations send email from ALRO's address: a company gets a daily allowance, and pending invitations count as seats.
    if (!(await rateLimit(db, limitKey("invite", viewer.orgId), 40, 86_400)).ok) return { error: "That's a lot of invitations for one day. Try again tomorrow." };
    const { limits } = await limitsFor(db, viewer.orgId);
    const [members, pending] = await Promise.all([listMembers(db, viewer.orgId), pendingInvitations(db, viewer.orgId)]);
    if (members.filter((m) => !m.deactivatedAt).length + pending.length >= limits.members) return { error: "Your plan's member limit is reached, counting people already invited. Remove someone or cancel an invitation first." };
    const role = field(form, "role") === "admin" ? "admin" : "member";
    const { token, email } = await createInvitation(db, viewer, { email: field(form, "email"), role, department: field(form, "department").toLowerCase() || null, invitedBy: viewer.personId, actorRole: viewer.role });
    const link = `${await appOrigin()}/invite/${token}`;
    const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, viewer.orgId));
    const sent = await sendEmail({
      to: email,
      subject: oneLine(`${viewer.displayName} invited you to ${org.name} on ALRO`),
      text: `${viewer.displayName} invited you to join ${org.name} on ALRO, the company's shared memory.\n\nJoin here (the link works for 7 days):\n${link}`,
      html: `<p>${escapeHtml(viewer.displayName)} invited you to join <strong>${escapeHtml(org.name)}</strong> on ALRO, the company's shared memory.</p><p><a href="${escapeHtml(link)}">Join ${escapeHtml(org.name)}</a> (the link works for 7 days).</p>`,
    }).catch(() => false);
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "member.invite", target: email, detail: { role, delivery: sent ? "email" : "link shown to the inviter" }, ip: await clientIp() });
    refresh();
    return sent ? { ok: `Invitation sent to ${email}.` } : { ok: `Send ${email} this link. It works once, for 7 days:`, link };
  } catch (e) {
    const message = friendly(e) ?? (e instanceof Error ? e.message : "Couldn't invite them.");
    return { error: message };
  }
}

export async function revokeInvite(form: FormData) {
  await change(async (viewer) => {
    const [gone] = await getDb().delete(invitations).where(and(eq(invitations.id, field(form, "id")), eq(invitations.orgId, viewer.orgId))).returning({ email: invitations.email });
    if (gone) await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "member.invite_revoked", target: gone.email });
  });
}

/**
 * A way back in for someone who forgot their password. It goes to their own mailbox when email
 * is set up; only without email delivery is the link shown to the admin to pass on. Either way
 * the admin must be allowed to manage that person: an admin can't open an owner's account this way.
 */
export async function resetLink(_prev: AdminState, form: FormData): Promise<AdminState> {
  const viewer = await getViewer();
  const db = getDb();
  try {
    const person = await manageable(db, viewer, field(form, "id"));
    const reset = person.primaryEmail && person.isMember ? await createReset(db, person.primaryEmail) : undefined;
    if (!reset || reset.orgId !== viewer.orgId || reset.personId !== person.id) return { error: "That person can't sign in. Invite them instead." };
    const link = `${await appOrigin()}/reset/${reset.token}`;
    const sent = await sendEmail({
      to: reset.email,
      subject: "Choose a new ALRO password",
      text: `${viewer.displayName} sent you a link to choose a new ALRO password (works for two hours):\n${link}\n\nIf you didn't ask for this, ignore it and tell them.`,
      html: `<p>${escapeHtml(viewer.displayName)} sent you a link to choose a new ALRO password.</p><p><a href="${escapeHtml(link)}">Choose a new password</a> (works for two hours).</p><p>If you didn't ask for this, ignore it and tell them.</p>`,
    }).catch(() => false);
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "auth.reset_link_created", target: reset.email, detail: { delivery: sent ? "email" : "link shown to the admin" }, ip: await clientIp() });
    return sent ? { ok: `A reset link was emailed to ${reset.email}.` } : { ok: `Give ${reset.email} this link. It works once, for two hours:`, link };
  } catch (e) {
    return { error: friendly(e) ?? (e instanceof Error ? e.message : "Couldn't create a link.") };
  }
}

export async function updateMember(form: FormData) {
  await change(async (viewer) => {
    const db = getDb();
    const id = field(form, "id");
    const role = await setRole(db, viewer, id, field(form, "role"));
    const department = await setDepartment(db, viewer, id, field(form, "department").toLowerCase() || null);
    if (role.from !== role.to) await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "member.role", target: role.email, detail: { from: role.from, to: role.to } });
    if (department.from !== department.to) {
      await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "member.department", target: department.email, detail: { from: department.from, to: department.to } });
      // What they copied into trackers and procedures from the department they left goes with their access.
      await purgeRevoked(db, viewer.orgId);
    }
  });
}

export async function removeMember(form: FormData) {
  await change(async (viewer) => {
    const done = await deactivateMember(getDb(), viewer, field(form, "id"));
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "member.remove", target: done.email, detail: { sourcesStopped: done.sourcesStopped }, ip: await clientIp() });
  });
}

export async function restoreMember(form: FormData) {
  await change(async (viewer) => {
    const done = await reactivateMember(getDb(), viewer, field(form, "id"));
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "member.restore", target: done.email });
  });
}

export async function updateCompany(form: FormData) {
  await change(async (viewer) => {
    const name = field(form, "name").slice(0, 120);
    const timezone = field(form, "timezone");
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new MemberError("That isn't a time zone ALRO knows. Use a name like Asia/Kolkata.");
    }
    if (!name) throw new MemberError("The company needs a name.");
    await getDb().update(orgs).set({ name, timezone }).where(eq(orgs.id, viewer.orgId));
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "org.update", detail: { name, timezone } });
  });
}

/** How long messages are kept, and how long a proposal waits before it's dropped. */
export async function updatePolicies(form: FormData) {
  await change(async (viewer) => {
    const db = getDb();
    const retention = Number(field(form, "retentionDays"));
    const expiry = Number(field(form, "approvalExpiryDays"));
    if (retention && (retention < 30 || retention > 3650)) throw new MemberError("Keep messages for at least 30 days, or leave it empty to keep everything.");
    if (expiry && (expiry < 1 || expiry > 90)) throw new MemberError("A proposal can wait between 1 and 90 days.");
    const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, viewer.orgId));
    const settings = { ...org.settings, retentionDays: retention || undefined, approvalExpiryDays: expiry || undefined };
    await db.update(orgs).set({ settings }).where(eq(orgs.id, viewer.orgId));
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "org.policies", detail: { retentionDays: retention || null, approvalExpiryDays: expiry || null } });
  });
}

/** Limits a team source to one department, or opens it to the whole company again. */
export async function setSourceDepartment(form: FormData) {
  await change(async (viewer) => {
    const department = field(form, "department").toLowerCase() || null;
    if (department && !DEPARTMENT.test(department)) throw new MemberError("A department is a short name like finance or sales.");
    const [c] = await getDb()
      .update(connections)
      .set({ department })
      .where(and(eq(connections.id, field(form, "id")), eq(connections.orgId, viewer.orgId), eq(connections.scope, "org")))
      .returning({ id: connections.id, provider: connections.provider });
    if (!c) return;
    // Threads, messages and search follow by trigger; facts, promises and summaries built from them are re-derived here.
    const moved = await getDb().select({ id: threads.id }).from(threads).where(eq(threads.connectionId, c.id));
    await recomputeDerivedAcls(getDb(), viewer.orgId, moved.map((t) => t.id));
    await purgeRevoked(getDb(), viewer.orgId);
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "source.department", target: c.provider, detail: { department } });
  });
}

/** Stops ALRO reading one conversation and deletes what it took from it, or lets it read it again. */
export async function setConversation(form: FormData) {
  await change(async (viewer) => {
    const db = getDb();
    const id = field(form, "id");
    const [t] = await db
      .select({ title: threads.title, excludedAt: threads.excludedAt })
      .from(threads)
      .innerJoin(connections, eq(connections.id, threads.connectionId))
      .where(and(eq(threads.id, id), eq(threads.orgId, viewer.orgId), eq(connections.scope, "org")));
    if (!t) throw new MemberError("That conversation isn't part of a team source.");
    if (t.excludedAt) await includeThread(db, viewer.orgId, id);
    else await excludeThread(db, viewer.orgId, id);
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: t.excludedAt ? "conversation.include" : "conversation.exclude", target: t.title ?? id });
  });
}

/** Deletes the company and everything ALRO holds for it. Owners only, and only after typing its name. */
export async function deleteCompanyAction(form: FormData) {
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, viewer.orgId));
  if (viewer.role !== "owner") redirect(`/admin?error=${encodeURIComponent("Only an owner can delete the company.")}`);
  if (field(form, "confirm") !== org.name) redirect(`/admin?error=${encodeURIComponent("Type the company's name exactly to delete it.")}`);
  // A stolen session isn't enough: the owner's password is asked for again (when they have one).
  const [credential] = await db.select({ hash: credentials.passwordHash }).from(credentials).where(eq(credentials.personId, viewer.personId));
  if (credential && !(await verifyPassword(String(form.get("password") ?? ""), credential.hash))) redirect(`/admin?error=${encodeURIComponent("That isn't your password. Nothing was deleted.")}`);
  console.warn(`company ${viewer.orgId} (${org.name}) deleted by ${viewer.email}`);
  await deleteCompany(db, viewer.orgId);
  await endBrowserSession();
  redirect("/sign-in");
}
