import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountError, acceptInvitation, acceptInvitationProven, changePassword, createInvitation, createReset, createSignInLink, findInvitation, memberByEmail, pendingInvitations, readSignUpToken, redeemSignInLink, resetPassword, signIn, signUp, signUpAllowed, signUpNeedsEmailProof, signUpToken } from "@/auth/accounts";
import { hashPassword, passwordProblem, verifyPassword } from "@/auth/passwords";
import { createSession, endSession, sessionViewer } from "@/auth/sessions";
import { safeNext, ssoProviders } from "@/auth/sso";
import type { Db } from "@/db/client";
import { approvals, channelLinkCodes, channelLinks, chunks, commitments, connections, credentials, edges, entities, invitations, messages, orgs, people, routines, sessions, threadMembers, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { writeBatch } from "@/ingest/writer";
import { audit } from "@/lib/audit";
import { excludeThread, includeThread } from "@/memory/forget";
import { applyRetention, deleteCompany } from "./data";
import { deactivateMember, listMembers, manageable, MemberError, reactivateMember, setDepartment, setRole } from "./members";
import { setupSteps } from "./onboarding";
import { clearRateLimit, limitKey, rateLimit } from "./rate-limit";
import { assertWithin, bump, LimitError, usageReport } from "./usage";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-11-16T06:00:00Z");

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(() => close());
afterEach(() => vi.unstubAllEnvs());

describe("passwords", () => {
  it("are stored hashed and checked in constant shape", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery!", hash)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
  });

  it("refuses short and obvious ones", () => {
    expect(passwordProblem("short")).toContain("at least 10");
    expect(passwordProblem("aaaaaaaaaaaa")).toContain("easy to guess");
    expect(passwordProblem("password12345")).toContain("easy to guess");
    expect(passwordProblem("a perfectly fine passphrase")).toBeUndefined();
  });
});

describe("companies and members", () => {
  let acme: { orgId: string; personId: string };

  it("lets the first company be created on a fresh deployment, then closes sign-up", async () => {
    expect(await signUpAllowed(db)).toBe(true);
    acme = await signUp(db, { company: "Acme Metals", name: "Asha Rao", email: "Asha@Acme.example", password: "a long enough password", timezone: "Asia/Kolkata" });
    const [owner] = await db.select().from(people).where(eq(people.id, acme.personId));
    expect(owner).toMatchObject({ role: "owner", isMember: true, primaryEmail: "asha@acme.example" });
    const [org] = await db.select().from(orgs).where(eq(orgs.id, acme.orgId));
    expect(org).toMatchObject({ name: "Acme Metals", timezone: "Asia/Kolkata", plan: "pilot" });
    expect(await signUpAllowed(db)).toBe(false);
    await expect(signUp(db, { company: "Other", name: "X", email: "x@other.example", password: "a long enough password" })).rejects.toThrow("can't be created here");
    vi.stubEnv("ALRO_SIGNUP", "open");
    await expect(signUp(db, { company: "Dup", name: "Asha", email: "asha@acme.example", password: "a long enough password", emailProven: true })).rejects.toThrow("already has an ALRO account");
  });

  it("signs in with the right password only, whatever the email's case", async () => {
    expect(await signIn(db, "ASHA@acme.example", "a long enough password")).toEqual(acme);
    expect(await signIn(db, "asha@acme.example", "wrong password here")).toBeUndefined();
    expect(await signIn(db, "nobody@acme.example", "a long enough password")).toBeUndefined();
  });

  it("invites by one-time link, reusing the person ALRO already knows from a source", async () => {
    const [known] = await db.insert(people).values({ orgId: acme.orgId, displayName: "ravi (slack)", primaryEmail: "ravi@acme.example", isMember: false }).returning();
    const { token } = await createInvitation(db, acme, { email: "Ravi@acme.example", role: "member", department: "finance", invitedBy: acme.personId }, NOW);
    expect((await findInvitation(db, token, NOW))?.company).toBe("Acme Metals");
    // The link is useless without the token, and the token isn't stored.
    expect(await findInvitation(db, "not-the-token", NOW)).toBeUndefined();
    await expect(acceptInvitation(db, token, { name: "Ravi Kumar", password: "short" }, NOW)).rejects.toThrow("at least 10");
    const ravi = await acceptInvitation(db, token, { name: "Ravi Kumar", password: "ravi's long password" }, NOW);
    expect(ravi.personId).toBe(known.id);
    const [row] = await db.select().from(people).where(eq(people.id, known.id));
    expect(row).toMatchObject({ isMember: true, role: "member", department: "finance", displayName: "Ravi Kumar" });
    await expect(acceptInvitation(db, token, { name: "Again", password: "another long password" }, NOW)).rejects.toThrow(AccountError);
    await expect(createInvitation(db, acme, { email: "ravi@acme.example" }, NOW)).rejects.toThrow("already a member");
    expect(await signIn(db, "ravi@acme.example", "ravi's long password")).toEqual(ravi);
  });

  it("expires invitations", async () => {
    const { token } = await createInvitation(db, acme, { email: "late@acme.example" }, NOW);
    expect(await findInvitation(db, token, new Date(NOW.getTime() + 8 * 86_400_000))).toBeUndefined();
  });

  it("signs a member in with a one-time emailed link that expires", async () => {
    const link = await createSignInLink(db, "ASHA@acme.example", NOW);
    expect(link).toMatchObject({ email: "asha@acme.example", orgId: acme.orgId, personId: acme.personId });
    // Not an invitation: it never shows up as one.
    expect((await pendingInvitations(db, acme.orgId, NOW)).map((i) => i.email)).not.toContain("asha@acme.example");
    expect(await redeemSignInLink(db, link!.token, NOW)).toEqual({ ...acme, joined: false });
    await expect(redeemSignInLink(db, link!.token, NOW)).rejects.toThrow("expired or was already used");
    const late = await createSignInLink(db, "asha@acme.example", NOW);
    await expect(redeemSignInLink(db, late!.token, new Date(NOW.getTime() + 16 * 60_000))).rejects.toThrow(AccountError);
    // Asking again replaces the earlier link.
    const first = await createSignInLink(db, "asha@acme.example", NOW);
    await createSignInLink(db, "asha@acme.example", NOW);
    await expect(redeemSignInLink(db, first!.token, NOW)).rejects.toThrow(AccountError);
  });

  it("sends no sign-in link to an address that is neither a member nor invited", async () => {
    expect(await createSignInLink(db, "stranger@acme.example", NOW)).toBeUndefined();
    expect(await createSignInLink(db, "not an email", NOW)).toBeUndefined();
  });

  it("lets an invitee join through an emailed link, without a password, as invited", async () => {
    const { token } = await createInvitation(db, acme, { email: "nina@acme.example", role: "admin", department: "sales", invitedBy: acme.personId }, NOW);
    const link = await createSignInLink(db, "nina@acme.example", NOW);
    expect(link?.personId).toBeUndefined();
    const nina = await redeemSignInLink(db, link!.token, NOW);
    expect(nina).toMatchObject({ orgId: acme.orgId, joined: true });
    const [row] = await db.select().from(people).where(eq(people.id, nina.personId));
    expect(row).toMatchObject({ isMember: true, role: "admin", department: "sales", displayName: "nina", primaryEmail: "nina@acme.example" });
    expect(await db.select().from(credentials).where(eq(credentials.personId, nina.personId))).toHaveLength(0);
    // The invitation is used up, and next time the link just signs her in.
    expect(await findInvitation(db, token, NOW)).toBeUndefined();
    const again = await createSignInLink(db, "nina@acme.example", NOW);
    expect(await redeemSignInLink(db, again!.token, NOW)).toEqual({ orgId: acme.orgId, personId: nina.personId, joined: false });
    // She can choose a password later from her account page.
    await changePassword(db, { orgId: acme.orgId, personId: nina.personId }, "", "nina's long password");
    expect(await signIn(db, "nina@acme.example", "nina's long password")).toEqual({ orgId: acme.orgId, personId: nina.personId });
  });

  it("lets an invitee join with Google or Microsoft, and nobody without an invitation", async () => {
    await expect(acceptInvitationProven(db, "uninvited@acme.example", "Someone", NOW)).rejects.toThrow("Ask your admin for an invitation");
    await createInvitation(db, acme, { email: "omar@acme.example", department: "finance" }, NOW);
    const omar = await acceptInvitationProven(db, "Omar@acme.example", "Omar Farooq", NOW);
    const [row] = await db.select().from(people).where(eq(people.id, omar.personId));
    expect(row).toMatchObject({ isMember: true, role: "member", department: "finance", displayName: "Omar Farooq" });
    expect(await memberByEmail(db, "omar@acme.example")).toEqual(omar);
    await expect(acceptInvitationProven(db, "omar@acme.example", "Omar", NOW)).rejects.toThrow(AccountError);
  });

  it("resets a password with a short-lived link and signs out every browser", async () => {
    const ravi = (await memberByEmail(db, "ravi@acme.example"))!;
    const { token: session } = await createSession(db, ravi, "password", {}, NOW);
    expect(await sessionViewer(db, session, NOW)).toMatchObject({ personId: ravi.personId, role: "member", department: "finance" });
    expect(await createReset(db, "nobody@acme.example", NOW)).toBeUndefined();
    const reset = (await createReset(db, "ravi@acme.example", NOW))!;
    await expect(resetPassword(db, reset.token, "ravi's newer password", new Date(NOW.getTime() + 3 * 3_600_000))).rejects.toThrow("expired");
    await resetPassword(db, reset.token, "ravi's newer password", NOW);
    expect(await sessionViewer(db, session, NOW)).toBeUndefined();
    expect(await signIn(db, "ravi@acme.example", "ravi's long password")).toBeUndefined();
    expect(await signIn(db, "ravi@acme.example", "ravi's newer password")).toEqual(ravi);
    await expect(resetPassword(db, reset.token, "yet another password", NOW)).rejects.toThrow();
  });

  it("changing a password needs the current one and keeps only this browser signed in", async () => {
    const ravi = (await memberByEmail(db, "ravi@acme.example"))!;
    const here = await createSession(db, ravi, "password", {}, NOW);
    const there = await createSession(db, ravi, "password", {}, NOW);
    const me = (await sessionViewer(db, here.token, NOW))!;
    await expect(changePassword(db, me, "not it", "brand new password 1")).rejects.toThrow("isn't your current password");
    await changePassword(db, me, "ravi's newer password", "brand new password 1");
    expect(await sessionViewer(db, here.token, NOW)).toBeTruthy();
    expect(await sessionViewer(db, there.token, NOW)).toBeUndefined();
  });

  it("sessions end on sign-out, on expiry, and the moment a member is removed", async () => {
    const ravi = (await memberByEmail(db, "ravi@acme.example"))!;
    const a = await createSession(db, ravi, "password", {}, NOW);
    await endSession(db, a.token);
    expect(await sessionViewer(db, a.token, NOW)).toBeUndefined();
    const b = await createSession(db, ravi, "password", {}, NOW);
    expect(await sessionViewer(db, b.token, new Date(NOW.getTime() + 31 * 86_400_000))).toBeUndefined();
    const [stored] = await db.select().from(sessions).where(eq(sessions.personId, ravi.personId));
    expect(stored.tokenHash).not.toBe(b.token);

    // Removing someone: signed out, password gone, messaging unlinked, tasks stopped, own sources stopped, proposals dropped.
    await db.insert(channelLinks).values({ orgId: acme.orgId, personId: ravi.personId, channel: "telegram", externalUserId: "42" });
    await db.insert(routines).values({ orgId: acme.orgId, ownerPersonId: ravi.personId, title: "Daily", instruction: "x", schedule: { kind: "daily", time: "07:00" }, nextRunAt: NOW });
    const [mailbox] = await db.insert(connections).values({ orgId: acme.orgId, provider: "gmail", scope: "personal", ownerPersonId: ravi.personId, externalAccountId: "ravi@acme.example" }).returning();
    await db.insert(approvals).values({ orgId: acme.orgId, personId: ravi.personId, tool: "gmail_send_email", input: {}, summary: "Email", audience: "external", origin: "chat", code: "AAAA" });
    const owner = { ...acme, role: "owner" as const };
    await expect(deactivateMember(db, { ...ravi, orgId: acme.orgId, role: "member" }, acme.personId)).rejects.toThrow("Only an admin");
    await expect(deactivateMember(db, owner, acme.personId)).rejects.toThrow("can't remove yourself");
    const done = await deactivateMember(db, owner, ravi.personId, NOW);
    expect(done.sourcesStopped).toBe(1);
    expect(await sessionViewer(db, b.token, NOW)).toBeUndefined();
    expect(await signIn(db, "ravi@acme.example", "brand new password 1")).toBeUndefined();
    expect(await memberByEmail(db, "ravi@acme.example")).toBeUndefined();
    expect(await db.select().from(channelLinks).where(eq(channelLinks.personId, ravi.personId))).toHaveLength(0);
    expect((await db.select().from(routines).where(eq(routines.ownerPersonId, ravi.personId)))[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await db.select().from(connections).where(eq(connections.id, mailbox.id)))[0].status).toBe("revoked");
    expect((await db.select().from(approvals).where(eq(approvals.personId, ravi.personId)))[0].status).toBe("rejected");
    expect(await db.select().from(credentials).where(eq(credentials.personId, ravi.personId))).toHaveLength(0);
  });

  it("keeps at least one owner, and only owners change owners", async () => {
    const owner = { ...acme, role: "owner" as const };
    await expect(setRole(db, owner, acme.personId, "member")).rejects.toThrow("at least one owner");
    const [bo] = await db.insert(people).values({ orgId: acme.orgId, displayName: "Bo", primaryEmail: "bo@acme.example", isMember: true, role: "admin" }).returning();
    const admin = { orgId: acme.orgId, personId: bo.id, role: "admin" as const };
    await expect(setRole(db, admin, acme.personId, "member")).rejects.toThrow("Only an owner can change an owner");
    await expect(setRole(db, admin, bo.id, "owner")).rejects.toThrow("Only an owner can make someone an owner");
    await setRole(db, owner, bo.id, "owner");
    await setRole(db, owner, acme.personId, "admin");
    await setRole(db, { ...admin, role: "owner" }, acme.personId, "owner");
    await expect(setDepartment(db, owner, bo.id, "Not A Slug!")).rejects.toThrow(MemberError);
    // Someone from another company can't be touched.
    const [elsewhere] = await db.insert(orgs).values({ name: "Elsewhere" }).returning();
    const [stranger] = await db.insert(people).values({ orgId: elsewhere.id, displayName: "Stranger", isMember: true }).returning();
    await expect(setRole(db, owner, stranger.id, "admin")).rejects.toThrow("isn't a member of this company");
  });

  it("gives an admin no side door into a more senior account", async () => {
    const [cy, ed, di, fay] = await db
      .insert(people)
      .values([
        { orgId: acme.orgId, displayName: "Cy", primaryEmail: "cy@acme.example", isMember: true, role: "admin" },
        { orgId: acme.orgId, displayName: "Ed", primaryEmail: "ed@acme.example", isMember: true, role: "admin" },
        { orgId: acme.orgId, displayName: "Di", primaryEmail: "di@acme.example", isMember: true, role: "member" },
        { orgId: acme.orgId, displayName: "Fay", primaryEmail: "fay@acme.example", isMember: true, role: "owner" },
      ])
      .returning();
    const admin = { orgId: acme.orgId, personId: cy.id, role: "admin" as const };
    const owner = { ...acme, role: "owner" as const };
    // Reset links and every other change go through this check.
    await expect(manageable(db, admin, acme.personId)).rejects.toThrow("Only an owner can change an owner");
    await expect(manageable(db, admin, ed.id)).rejects.toThrow("Only an owner can change another admin");
    await expect(manageable(db, { ...admin, role: "member" }, di.id)).rejects.toThrow("Only an admin");
    expect((await manageable(db, admin, di.id)).id).toBe(di.id);
    expect((await manageable(db, owner, ed.id)).id).toBe(ed.id);

    // "Inviting" someone who is already a member only lets them set a password: it can't change their role,
    // and an admin can't send one to an owner (who has no password yet) and then use it.
    await expect(createInvitation(db, acme, { email: "fay@acme.example", role: "member", actorRole: "admin" }, NOW)).rejects.toThrow("Only an owner can send an owner");
    await expect(createInvitation(db, acme, { email: "ed@acme.example", actorRole: "admin" }, NOW)).rejects.toThrow("Only an owner can send another admin");
    const { token } = await createInvitation(db, acme, { email: "fay@acme.example", role: "member", department: "sales", actorRole: "owner" }, NOW);
    const session = await createSession(db, { orgId: acme.orgId, personId: fay.id }, "sso:oidc", {}, NOW);
    await acceptInvitation(db, token, { name: "Someone Else", password: "fay's long password" }, NOW);
    const [after] = await db.select().from(people).where(eq(people.id, fay.id));
    expect(after).toMatchObject({ role: "owner", department: null, displayName: "Fay" });
    // Whoever was signed in as them before the password was set is signed out.
    expect(await sessionViewer(db, session.token, NOW)).toBeUndefined();
    await expect(createInvitation(db, acme, { email: "fay@acme.example", actorRole: "owner" }, NOW)).rejects.toThrow("already a member");
  });

  it("a removed member is no longer a member anywhere, can be seen and restored by an admin, and can't be re-invited around that", async () => {
    const owner = { ...acme, role: "owner" as const };
    const removed = (await listMembers(db, acme.orgId)).find((m) => m.email === "ravi@acme.example")!;
    expect(removed.deactivatedAt).toBeTruthy();
    const [row] = await db.select({ isMember: people.isMember }).from(people).where(eq(people.id, removed.id));
    expect(row.isMember).toBe(false);
    await expect(createInvitation(db, acme, { email: "ravi@acme.example", actorRole: "owner" }, NOW)).rejects.toThrow("Restore them first");
    await reactivateMember(db, owner, removed.id);
    expect(await memberByEmail(db, "ravi@acme.example")).toEqual({ orgId: acme.orgId, personId: removed.id });
    await expect(reactivateMember(db, owner, removed.id)).rejects.toThrow("already a member");
    // Leaving also cancels a messaging link code and a reset link made just before.
    await db.insert(channelLinkCodes).values({ code: "12345678", orgId: acme.orgId, personId: removed.id, expiresAt: new Date(NOW.getTime() + 600_000) });
    await createReset(db, "ravi@acme.example", NOW);
    await deactivateMember(db, owner, removed.id, NOW);
    expect(await db.select().from(channelLinkCodes).where(eq(channelLinkCodes.personId, removed.id))).toHaveLength(0);
    expect(await db.select().from(invitations).where(eq(invitations.personId, removed.id))).toHaveLength(0);
  });

  it("where anyone can sign up, the email is proven first and single sign-on is off", async () => {
    vi.stubEnv("ALRO_SIGNUP", "open");
    vi.stubEnv("OIDC_ISSUER", "https://id.example");
    vi.stubEnv("OIDC_CLIENT_ID", "id");
    vi.stubEnv("OIDC_CLIENT_SECRET", "secret");
    expect(signUpNeedsEmailProof()).toBe(true);
    expect(ssoProviders()).toEqual([]);
    const details = { company: "Proven Co", name: "Pat", email: "Pat@proven.example", timezone: "Asia/Kolkata" };
    await expect(signUp(db, { ...details, password: "a long enough password" })).rejects.toThrow("Confirm your email");
    const token = signUpToken(details);
    expect(readSignUpToken(token)).toEqual({ company: "Proven Co", name: "Pat", email: "pat@proven.example", timezone: "Asia/Kolkata" });
    expect(readSignUpToken(`${token}x`)).toBeUndefined();
    expect(readSignUpToken("nonsense")).toBeUndefined();
    const created = await signUp(db, { ...readSignUpToken(token)!, password: "a long enough password", emailProven: true });
    expect(await signIn(db, "pat@proven.example", "a long enough password")).toEqual(created);
    // Proven by Google or Microsoft instead: no password needed, and none is set.
    const viaGoogle = await signUp(db, { company: "Google Co", name: "Gita", email: "gita@google-co.example", emailProven: true });
    expect(await db.select().from(credentials).where(eq(credentials.personId, viaGoogle.personId))).toHaveLength(0);
    expect(await memberByEmail(db, "gita@google-co.example")).toEqual(viaGoogle);
    vi.stubEnv("ALRO_SIGNUP", "");
    // Without proof, a password is still required (and here sign-up is closed anyway).
    await expect(signUp(db, { company: "No Proof", name: "N", email: "n@noproof.example" })).rejects.toThrow(AccountError);
    vi.stubEnv("ALRO_SIGNUP", "closed");
    expect(ssoProviders().map((p) => p.id)).toEqual(["oidc"]);
  });

  it("only redirects to paths on this site after sign-in", () => {
    expect(safeNext("/approvals?x=1")).toBe("/approvals?x=1");
    for (const bad of ["//evil.example", "https://evil.example", "/api/export", "javascript:alert(1)", "/..//evil.example", "/a//b", undefined, ""]) expect(safeNext(bad)).toBe("/");
  });

  it("refuses Microsoft single sign-on unless it's pinned to one tenant", () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "secret");
    vi.stubEnv("MICROSOFT_TENANT_ID", "common");
    expect(ssoProviders().map((p) => p.id)).not.toContain("microsoft");
    vi.stubEnv("MICROSOFT_TENANT_ID", "3f2a1c8e-0000-4000-8000-000000000000");
    expect(ssoProviders().map((p) => p.id)).toContain("microsoft");
  });
});

describe("rate limits", () => {
  it("allow a number of attempts per window, then refuse until it passes", async () => {
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    for (let i = 0; i < 3; i++) expect((await rateLimit(db, "signin:x", 3, 60, at(i))).ok).toBe(true);
    const blocked = await rateLimit(db, "signin:x", 3, 60, at(5));
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(50);
    expect((await rateLimit(db, "signin:x", 3, 60, at(61))).ok).toBe(true);
    await clearRateLimit(db, "signin:x");
    expect((await rateLimit(db, "signin:x", 1, 60, at(62))).ok).toBe(true);
    expect((await rateLimit(db, "signin:other", 1, 60, at(62))).ok).toBe(true);
  });

  it("uses fixed-length keys whatever was typed", () => {
    const key = limitKey("signin", "a".repeat(5000), "203.0.113.9");
    expect(key.length).toBeLessThan(50);
    expect(key).toBe(limitKey("signin", "a".repeat(5000), "203.0.113.9"));
    expect(key).not.toBe(limitKey("signin", "a".repeat(5000), "203.0.113.10"));
  });
});

describe("usage and plan limits", () => {
  it("counts usage per company per day and stops at the plan's limit", async () => {
    const [org] = await db.insert(orgs).values({ name: "Tiny", settings: { limits: { questionsPerDay: 2, members: 1 } } }).returning();
    await assertWithin(db, org.id, ["questionsPerDay", "tokensPerDay"], NOW);
    await bump(db, org.id, "questions", 1, NOW);
    await bump(db, org.id, "questions", 1, NOW);
    await bump(db, org.id, "tokens", 1234, NOW);
    await expect(assertWithin(db, org.id, ["questionsPerDay"], NOW)).rejects.toThrow(LimitError);
    // A new day starts from zero.
    await assertWithin(db, org.id, ["questionsPerDay"], new Date(NOW.getTime() + 86_400_000));
    await db.insert(people).values({ orgId: org.id, displayName: "Only", isMember: true });
    await expect(assertWithin(db, org.id, ["members"], NOW)).rejects.toThrow("member limit");
    const report = await usageReport(db, org.id, NOW);
    expect(report.rows.find((r) => r.limit === "questionsPerDay")).toMatchObject({ used: 2, max: 2 });
    expect(report.rows.find((r) => r.limit === "tokensPerDay")).toMatchObject({ used: 1234 });
    expect(report.month).toMatchObject({ questions: 2, tokens: 1234 });
  });
});

describe("departments, retention and deletion", () => {
  let orgId: string;
  let fin: string;
  let ops: string;
  let financeThread: string;

  beforeAll(async () => {
    [{ id: orgId }] = await db.insert(orgs).values({ name: "Depts", settings: { retentionDays: 90 } }).returning();
    [{ id: fin }, { id: ops }] = await db
      .insert(people)
      .values([
        { orgId, displayName: "Fin", isMember: true, department: "finance", role: "owner" },
        { orgId, displayName: "Ops", isMember: true, department: "operations" },
      ])
      .returning();
    const [books] = await db.insert(connections).values({ orgId, provider: "zendesk", scope: "org", ownerPersonId: fin, department: "finance" }).returning();
    const [chat] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", ownerPersonId: fin }).returning();
    const [t1] = await db.insert(threads).values({ orgId, connectionId: books.id, kind: "doc", externalId: "t1", title: "Invoice dispute", visibility: "org" }).returning();
    const [t2] = await db.insert(threads).values({ orgId, connectionId: chat.id, kind: "channel", externalId: "t2", title: "#general", visibility: "org" }).returning();
    financeThread = t1.id;
    const old = new Date(NOW.getTime() - 200 * 86_400_000);
    const recent = new Date(NOW.getTime() - 5 * 86_400_000);
    const rows = await db
      .insert(messages)
      .values([
        { orgId, threadId: t1.id, connectionId: books.id, externalId: "m1", kind: "note", sentAt: recent, text: "Acme disputes invoice 4417" },
        { orgId, threadId: t2.id, connectionId: chat.id, externalId: "m2", kind: "chat", sentAt: old, text: "old chatter from the spring" },
        { orgId, threadId: t2.id, connectionId: chat.id, externalId: "m3", kind: "chat", sentAt: recent, text: "recent chatter" },
      ])
      .returning();
    const [e1, e2] = await db.insert(entities).values([{ orgId, type: "company", name: "Acme", acl: ["org"] }, { orgId, type: "topic", name: "Spring", acl: ["org"] }]).returning();
    await db.insert(edges).values([
      { orgId, sourceEntityId: e1.id, targetEntityId: e2.id, relation: "old_fact", fact: "only in old messages", sourceMessageIds: [rows[1].id], acl: ["org"] },
      { orgId, sourceEntityId: e1.id, targetEntityId: e2.id, relation: "mixed_fact", fact: "old and new evidence", sourceMessageIds: [rows[1].id, rows[2].id], acl: ["org"] },
    ]);
    await db.insert(commitments).values({ orgId, title: "Old promise", ownerPersonId: fin, status: "open", quote: "will do", confidence: 0.9, sourceMessageId: rows[1].id, extractor: "test", acl: ["org"] });
    await db.insert(chunks).values([
      { orgId, threadId: t2.id, text: "old chatter", messageIds: [rows[1].id], startAt: old, endAt: old },
      { orgId, threadId: t2.id, text: "recent chatter", messageIds: [rows[2].id], startAt: recent, endAt: recent },
    ]);
  });

  it("a team source limited to a department is visible to that department only", async () => {
    const titles = (personId: string) => withScope(db, { orgId, personId }, async (tx) => (await tx.select({ title: threads.title }).from(threads)).map((t) => t.title).sort());
    expect(await titles(fin)).toEqual(["#general", "Invoice dispute"]);
    expect(await titles(ops)).toEqual(["#general"]);
    const texts = (personId: string) => withScope(db, { orgId, personId }, async (tx) => (await tx.select({ text: messages.text }).from(messages)).map((m) => m.text));
    expect(await texts(ops)).not.toContain("Acme disputes invoice 4417");
    // Opening the source to everyone, or moving the person, changes access at once.
    await db.update(people).set({ department: "finance" }).where(eq(people.id, ops));
    expect(await titles(ops)).toEqual(["#general", "Invoice dispute"]);
    await db.update(people).set({ department: "operations" }).where(eq(people.id, ops));
    const [t] = await db.select({ connectionId: threads.connectionId }).from(threads).where(eq(threads.id, financeThread));
    await db.update(connections).set({ department: null }).where(eq(connections.id, t.connectionId));
    expect(await titles(ops)).toEqual(["#general", "Invoice dispute"]);
    expect(await texts(ops)).toContain("Acme disputes invoice 4417");
  });

  it("retention deletes what's older than the period, with what came only from it", async () => {
    expect(await applyRetention(db, orgId, NOW)).toEqual({ messages: 1 });
    expect((await db.select({ text: messages.text }).from(messages).where(eq(messages.orgId, orgId))).map((m) => m.text).sort()).toEqual(["Acme disputes invoice 4417", "recent chatter"]);
    expect((await db.select({ r: edges.relation }).from(edges).where(eq(edges.orgId, orgId))).map((e) => e.r)).toEqual(["mixed_fact"]);
    expect(await db.select().from(commitments).where(eq(commitments.orgId, orgId))).toHaveLength(0);
    expect((await db.select({ text: chunks.text }).from(chunks).where(eq(chunks.orgId, orgId))).map((c) => c.text)).toEqual(["recent chatter"]);
    // No period set: nothing is touched.
    await db.update(orgs).set({ settings: {} }).where(eq(orgs.id, orgId));
    expect(await applyRetention(db, orgId, new Date(NOW.getTime() + 400 * 86_400_000))).toBeUndefined();
  });

  it("the setup checklist reflects what exists", async () => {
    const { steps } = await setupSteps(db, { orgId, personId: fin, displayName: "Fin", email: "", role: "owner", department: "finance" });
    const done = Object.fromEntries(steps.map((s) => [s.id, s.done]));
    expect(done).toMatchObject({ people: true, sources: true, departments: false, goals: false, sync: true });
    const member = await setupSteps(db, { orgId, personId: ops, displayName: "Ops", email: "", role: "member", department: "operations" });
    expect(member.steps.map((s) => s.id)).toEqual(["my-sources", "goals", "sync", "memory", "review", "daily"]);
  });

  it("deleting a company leaves nothing of it behind, and nothing of others is touched", async () => {
    await audit(db, { orgId, personId: fin, action: "test" });
    const before = await db.select({ id: orgs.id }).from(orgs);
    await deleteCompany(db, orgId);
    expect(await db.select().from(people).where(eq(people.orgId, orgId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.orgId, orgId))).toHaveLength(0);
    expect(await db.select().from(threadMembers).where(and(eq(threadMembers.orgId, orgId)))).toHaveLength(0);
    expect(await db.select({ id: orgs.id }).from(orgs)).toHaveLength(before.length - 1);
  });
});

describe("conversations ALRO is told not to read", () => {
  it("are emptied, skipped by later syncs, and read again once included", async () => {
    const [org] = await db.insert(orgs).values({ name: "Reads" }).returning();
    const [admin] = await db.insert(people).values({ orgId: org.id, displayName: "Admin", isMember: true, role: "owner" }).returning();
    const batch = (texts: string[]) => ({
      connection: { provider: "slack", scope: "org" as const, externalAccountId: "T9" },
      people: [],
      threads: [
        { externalId: "C-hr", kind: "channel" as const, title: "#hr", visibility: "org" as const, memberKeys: [] },
        { externalId: "C-gen", kind: "channel" as const, title: "#general", visibility: "org" as const, memberKeys: [] },
      ],
      messages: texts.map((text, i) => ({ threadExternalId: i % 2 ? "C-gen" : "C-hr", externalId: `m${i}`, kind: "chat" as const, sentAt: new Date(NOW.getTime() - i * 60_000), text })),
    });
    await writeBatch(db, org.id, batch(["salary review for Ravi", "lunch at one"]), "incremental", admin.id);
    const [hr] = await db.select().from(threads).where(and(eq(threads.orgId, org.id), eq(threads.externalId, "C-hr")));
    const texts = async () => (await db.select({ text: messages.text }).from(messages).where(eq(messages.orgId, org.id))).map((m) => m.text).sort();
    expect(await texts()).toEqual(["lunch at one", "salary review for Ravi"]);

    await excludeThread(db, org.id, hr.id, NOW);
    expect(await texts()).toEqual(["lunch at one"]);
    expect((await db.select().from(threads).where(eq(threads.id, hr.id)))[0].excludedAt).toEqual(NOW);

    // The next sync brings the same and newer messages: none of the excluded channel's are stored.
    await writeBatch(db, org.id, batch(["salary review for Ravi", "lunch at one", "new HR note", "standup moved"]), "incremental", admin.id);
    expect(await texts()).toEqual(["lunch at one", "standup moved"]);

    await includeThread(db, org.id, hr.id);
    await writeBatch(db, org.id, batch(["salary review for Ravi", "lunch at one", "new HR note", "standup moved"]), "incremental", admin.id);
    expect(await texts()).toEqual(["lunch at one", "new HR note", "salary review for Ravi", "standup moved"]);
    // Another company's conversation can't be excluded from here.
    await expect(excludeThread(db, (await db.insert(orgs).values({ name: "Other" }).returning())[0].id, hr.id)).rejects.toThrow("Not found");
  });
});
