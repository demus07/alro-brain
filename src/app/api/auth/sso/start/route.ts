import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { signUpAllowed } from "@/auth/accounts";
import { safeNext, ssoStart, type SsoProvider, type SsoSignUp } from "@/auth/sso";
import { getDb } from "@/db/client";

const NONCE_COOKIE = "alro_sso";

async function start(url: URL, provider: SsoProvider, next: string, signUp: SsoSignUp | undefined, failTo: string) {
  const nonce = randomBytes(24).toString("base64url");
  try {
    const to = await ssoStart(provider, url.origin, nonce, next, signUp);
    const res = NextResponse.redirect(to, 303);
    res.cookies.set(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/sso", maxAge: 600 });
    return res;
  } catch (e) {
    return NextResponse.redirect(new URL(`${failTo}?error=${encodeURIComponent(e instanceof Error ? e.message : "Sign-in failed.")}`, url.origin), 303);
  }
}

/** Sends the browser to the company's identity provider. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  return start(url, url.searchParams.get("provider") as SsoProvider, safeNext(url.searchParams.get("next")), undefined, "/sign-in");
}

/** The sign-up form's "Continue with …": the company's details ride along in the signed state, and the company is created on return. */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const fail = (message: string) => NextResponse.redirect(new URL(`/sign-up?error=${encodeURIComponent(message)}`, url.origin), 303);
  if (!(await signUpAllowed(getDb()))) return fail("New companies can't be created here. Ask your admin for an invitation.");
  const signUp = { company: field("company"), name: field("name"), timezone: field("timezone") };
  if (!signUp.company || !signUp.name) return fail("Enter your name and your company's name first.");
  return start(url, field("provider") as SsoProvider, "/welcome", signUp, "/sign-up");
}
