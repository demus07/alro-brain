import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { safeNext, ssoStart, type SsoProvider } from "@/auth/sso";

const NONCE_COOKIE = "alro_sso";

/** Sends the browser to the company's identity provider. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") as SsoProvider;
  const nonce = randomBytes(24).toString("base64url");
  try {
    const to = await ssoStart(provider, url.origin, nonce, safeNext(url.searchParams.get("next")));
    const res = NextResponse.redirect(to, 302);
    res.cookies.set(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/sso", maxAge: 600 });
    return res;
  } catch (e) {
    return NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(e instanceof Error ? e.message : "Sign-in failed.")}`, url.origin), 302);
  }
}
