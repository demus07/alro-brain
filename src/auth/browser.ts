import { cookies, headers } from "next/headers";
import { getDb } from "@/db/client";
import { audit } from "@/lib/audit";
import { createSession, endSession, SESSION_COOKIE } from "./sessions";

/**
 * The caller's address, for rate limits and the audit log. Taken from what the platform in front
 * sets (x-real-ip), or the last hop of x-forwarded-for: the first entries of that header are
 * whatever the caller chose to send.
 */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null;
}

/** Signs this browser in: creates the session and sets its cookie (http-only, so page scripts can't read it). */
export async function startBrowserSession(person: { orgId: string; personId: string }, method: string) {
  const db = getDb();
  const ip = await clientIp();
  const { token, expiresAt } = await createSession(db, person, method, { userAgent: (await headers()).get("user-agent"), ip });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
  await audit(db, { orgId: person.orgId, personId: person.personId, action: "auth.sign_in", detail: { method }, ip });
}

export async function endBrowserSession() {
  const jar = await cookies();
  await endSession(getDb(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
}
