"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { AccountError, acceptInvitation, checkSignUp, createReset, memberByEmail, readSignUpToken, resetPassword, signIn, signUp, signUpNeedsEmailProof, signUpToken } from "@/auth/accounts";
import { clientIp, endBrowserSession, startBrowserSession } from "@/auth/browser";
import { safeNext } from "@/auth/sso";
import { getDb } from "@/db/client";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/origin";
import { escapeHtml } from "@/lib/html";
import { emailConfigured, sendEmail } from "@/notify/email";
import { clearRateLimit, limitKey, rateLimit } from "@/platform/rate-limit";

export interface AuthState {
  error?: string;
  /** Shown in place of the form: "check your email". */
  done?: string;
}

const WINDOW = 15 * 60;
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const problem = (e: unknown) => (e instanceof AccountError ? e.message : (console.error(e), "Something went wrong. Try again."));

export async function signInAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  const email = field(form, "email").trim().toLowerCase();
  const ip = await clientIp();
  // Three counters: this caller on this account (so a stranger's wrong guesses don't lock the owner out),
  // this account from anywhere (bounds guessing spread over many addresses), and this caller on any account.
  const checks = await Promise.all([
    rateLimit(db, limitKey("signin", email, ip), 8, WINDOW),
    rateLimit(db, limitKey("signin-account", email), 60, WINDOW),
    rateLimit(db, limitKey("signin-ip", ip), 40, WINDOW),
  ]);
  const blocked = checks.filter((c) => !c.ok);
  if (blocked.length) return { error: `Too many attempts. Try again in ${Math.ceil(Math.max(...blocked.map((c) => c.retryAfterSeconds)) / 60)} minutes.` };
  const member = await signIn(db, email, field(form, "password"));
  if (!member) {
    const known = await memberByEmail(db, email);
    // Recorded after the response, so the reply takes the same time whether or not the account exists.
    if (known) after(() => audit(db, { orgId: known.orgId, personId: known.personId, action: "auth.sign_in_failed", ip }));
    return { error: "That email and password don't match." };
  }
  await clearRateLimit(db, limitKey("signin", email, ip));
  await startBrowserSession(member, "password");
  redirect(safeNext(field(form, "next")));
}

/**
 * Creates a company. On a deployment anyone can sign up to, the address is proven first: this
 * only sends a link, and the company is created from it (confirmSignUpAction).
 */
export async function signUpAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  const ip = await clientIp();
  if (!(await rateLimit(db, limitKey("signup-ip", ip), 5, 3600)).ok) return { error: "Too many attempts. Try again later." };
  const details = { company: field(form, "company"), name: field(form, "name"), email: field(form, "email"), timezone: field(form, "timezone") };
  if (signUpNeedsEmailProof()) {
    try {
      await checkSignUp(db, details);
    } catch (e) {
      return { error: problem(e) };
    }
    if (!emailConfigured()) return { error: "This server can't send email yet, so it can't confirm your address. Ask whoever runs it." };
    const address = details.email.trim().toLowerCase();
    if (!(await rateLimit(db, limitKey("signup-email", address), 3, 3600)).ok) return { error: "A confirmation link was already sent. Check your inbox, or try again in an hour." };
    const link = `${await appOrigin()}/sign-up/confirm?token=${encodeURIComponent(signUpToken(details))}`;
    after(() =>
      sendEmail({
        to: address,
        subject: "Confirm your email to set up ALRO",
        text: `Confirm this address to finish setting up your company on ALRO (the link works for an hour):\n${link}\n\nIf it wasn't you, ignore this email.`,
        html: `<p>Confirm this address to finish setting up your company on ALRO.</p><p><a href="${escapeHtml(link)}">Confirm and choose a password</a> (the link works for an hour).</p><p>If it wasn't you, ignore this email.</p>`,
      }).catch((e) => console.error("sign-up email failed", e instanceof Error ? e.message : e)),
    );
    return { done: `We've sent a link to ${address}. Open it to choose a password and finish. It works for an hour.` };
  }
  let member;
  try {
    member = await signUp(db, { ...details, password: field(form, "password") });
  } catch (e) {
    return { error: problem(e) };
  }
  await audit(db, { orgId: member.orgId, personId: member.personId, action: "org.create", ip });
  await startBrowserSession(member, "password");
  redirect("/welcome");
}

/** The second step of open sign-up: the link proved the address, now the password creates the company. */
export async function confirmSignUpAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  const details = readSignUpToken(field(form, "token"));
  if (!details) return { error: "That link has expired. Start again from the sign-up page." };
  let member;
  try {
    member = await signUp(db, { ...details, password: field(form, "password"), emailProven: true });
  } catch (e) {
    return { error: problem(e) };
  }
  await audit(db, { orgId: member.orgId, personId: member.personId, action: "org.create", ip: await clientIp() });
  await startBrowserSession(member, "password");
  redirect("/welcome");
}

export async function acceptInviteAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  let member;
  try {
    member = await acceptInvitation(db, field(form, "token"), { name: field(form, "name"), password: field(form, "password") });
  } catch (e) {
    return { error: problem(e) };
  }
  await audit(db, { orgId: member.orgId, personId: member.personId, action: "member.join", ip: await clientIp() });
  await startBrowserSession(member, "invite");
  redirect("/welcome");
}

/** Always answers the same way and in the same time, so it can't be used to find out who has an account. */
export async function requestResetAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  const email = field(form, "email").trim().toLowerCase();
  const ip = await clientIp();
  const done = { done: "If that address has an account, a link to choose a new password is on its way. It works for two hours. No email? Ask your admin for a reset link." };
  if (!(await rateLimit(db, limitKey("reset", email), 3, 3600)).ok || !(await rateLimit(db, limitKey("reset-ip", ip), 10, 3600)).ok) return done;
  const origin = await appOrigin();
  // The lookup and the email happen after the reply has gone.
  after(async () => {
    const reset = await createReset(db, email);
    if (!reset) return;
    const link = `${origin}/reset/${reset.token}`;
    await sendEmail({
      to: reset.email,
      subject: "Choose a new ALRO password",
      text: `Someone asked to reset the password for this address.\n\nChoose a new one here (works for two hours):\n${link}\n\nIf it wasn't you, ignore this email.`,
      html: `<p>Someone asked to reset the password for this address.</p><p><a href="${escapeHtml(link)}">Choose a new password</a> (works for two hours).</p><p>If it wasn't you, ignore this email.</p>`,
    }).catch((e) => console.error("reset email failed", e instanceof Error ? e.message : e));
    await audit(db, { orgId: reset.orgId, personId: reset.personId, action: "auth.reset_requested", ip });
  });
  return done;
}

export async function resetPasswordAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const db = getDb();
  let member;
  try {
    member = await resetPassword(db, field(form, "token"), field(form, "password"));
  } catch (e) {
    return { error: problem(e) };
  }
  await audit(db, { orgId: member.orgId, personId: member.personId, action: "auth.password_reset", ip: await clientIp() });
  await startBrowserSession(member, "password");
  redirect("/");
}

export async function signOutAction() {
  await endBrowserSession();
  redirect("/sign-in");
}
