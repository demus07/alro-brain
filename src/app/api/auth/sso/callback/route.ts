import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { memberByEmail } from "@/auth/accounts";
import { clientIp, startBrowserSession } from "@/auth/browser";
import { ssoFinish } from "@/auth/sso";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { limitKey, rateLimit } from "@/platform/rate-limit";

/** The identity provider sends the browser back here; sign in the member whose email it proved. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (message: string) => NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(message)}`, url.origin), 302);
  const db = getDb();
  const ip = await clientIp();
  if (!(await rateLimit(db, limitKey("sso", ip), 30, 900)).ok) return fail("Too many attempts. Try again in a few minutes.");
  try {
    const jar = await cookies();
    const proven = await ssoFinish({ state: url.searchParams.get("state"), code: url.searchParams.get("code"), nonce: jar.get("alro_sso")?.value }, url.origin);
    jar.delete({ name: "alro_sso", path: "/api/auth/sso" });
    // The provider belongs to the one company this deployment serves; with more than one, its word can't be taken for all of them.
    if ((await db.select({ id: orgs.id }).from(orgs).limit(2)).length > 1) return fail("Single sign-on is only available where ALRO serves one company. Sign in with your password.");
    const member = await memberByEmail(db, proven.email);
    // Single sign-on never creates anyone: people join by invitation.
    if (!member) return fail(`${proven.email} isn't a member of a company on ALRO yet. Ask your admin for an invitation.`);
    await startBrowserSession(member, `sso:${proven.provider}`);
    return NextResponse.redirect(new URL(proven.next, url.origin), 302);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Sign-in failed.");
  }
}
