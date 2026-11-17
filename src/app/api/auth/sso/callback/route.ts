import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AccountError, acceptInvitationProven, memberByEmail, signUp } from "@/auth/accounts";
import { clientIp, startBrowserSession } from "@/auth/browser";
import { ssoFinish } from "@/auth/sso";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { audit } from "@/lib/audit";
import { limitKey, rateLimit } from "@/platform/rate-limit";

/**
 * The identity provider sends the browser back here with a proven email address. That address:
 * creates the company (the first owner signing up), signs in the member who has it, or joins
 * the company it was invited to. Anyone else is turned away.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  let failTo = "/sign-in";
  const fail = (message: string) => NextResponse.redirect(new URL(`${failTo}?error=${encodeURIComponent(message)}`, url.origin), 302);
  const db = getDb();
  const ip = await clientIp();
  if (!(await rateLimit(db, limitKey("sso", ip), 30, 900)).ok) return fail("Too many attempts. Try again in a few minutes.");
  try {
    const jar = await cookies();
    const proven = await ssoFinish({ state: url.searchParams.get("state"), code: url.searchParams.get("code"), nonce: jar.get("alro_sso")?.value }, url.origin);
    jar.delete({ name: "alro_sso", path: "/api/auth/sso" });
    const method = `sso:${proven.provider}`;
    if (proven.signUp) {
      failTo = "/sign-up";
      // signUp checks this is still a fresh install, so a replayed sign-up can't create a second company.
      const owner = await signUp(db, { ...proven.signUp, email: proven.email, emailProven: true });
      await audit(db, { orgId: owner.orgId, personId: owner.personId, action: "org.create", detail: { method }, ip });
      await startBrowserSession(owner, method);
      return NextResponse.redirect(new URL("/welcome", url.origin), 302);
    }
    // The provider belongs to the one company this deployment serves; with more than one, its word can't be taken for all of them.
    if ((await db.select({ id: orgs.id }).from(orgs).limit(2)).length > 1) return fail("Single sign-on is only available where ALRO serves one company. Sign in with your password.");
    const member = await memberByEmail(db, proven.email);
    if (member) {
      await startBrowserSession(member, method);
      return NextResponse.redirect(new URL(proven.next, url.origin), 302);
    }
    // Not a member yet: only a live invitation lets them in (refused with an explanation otherwise).
    const joined = await acceptInvitationProven(db, proven.email, proven.name);
    await audit(db, { orgId: joined.orgId, personId: joined.personId, action: "member.join", detail: { method }, ip });
    await startBrowserSession(joined, method);
    return NextResponse.redirect(new URL("/welcome", url.origin), 302);
  } catch (e) {
    if (!(e instanceof AccountError)) console.error("sso callback", e);
    return fail(e instanceof Error ? e.message : "Sign-in failed.");
  }
}
