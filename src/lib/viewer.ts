import { and, eq, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { API_CALL_HEADER, asRole, SESSION_COOKIE, sessionViewer, type Role } from "@/auth/sessions";
import { getDb } from "@/db/client";
import { people } from "@/db/schema";
import type { Viewer } from "@/db/scope";

export interface SignedInViewer extends Viewer {
  displayName: string;
  email: string;
  role: Role;
  department: string | null;
  /** Absent for the development stand-in. */
  sessionId?: string;
}

/**
 * Sign-in is always required in production. In development it's optional: without a session,
 * the app acts as the member in ALRO_DEV_USER_EMAIL, unless ALRO_AUTH=on.
 */
export const authRequired = () => process.env.NODE_ENV === "production" || process.env.ALRO_AUTH === "on";

/** The signed-in member, or undefined. Never redirects. */
export async function currentViewer(): Promise<SignedInViewer | undefined> {
  const db = getDb();
  const signedIn = await sessionViewer(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (signedIn) return signedIn;
  if (authRequired()) return undefined;
  // The stand-in is for this machine only: a dev server reached through a tunnel or the network asks for a sign-in.
  const h = await headers();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h.get("host") ?? "");
  // A tunnel may rewrite the host to localhost, but it passes on the real caller's address.
  const callers = (h.get("x-forwarded-for") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (!local || !callers.every((a) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(a))) return undefined;
  const email = process.env.ALRO_DEV_USER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("Set ALRO_DEV_USER_EMAIL in .env.local to the member you want to act as, or ALRO_AUTH=on to sign in.");
  const [person] = await db
    .select({ orgId: people.orgId, personId: people.id, displayName: people.displayName, email: people.primaryEmail, role: people.role, department: people.department })
    .from(people)
    .where(and(eq(people.primaryEmail, email), eq(people.isMember, true), isNull(people.deactivatedAt)))
    .limit(1);
  if (!person) throw new Error(`No ALRO member with email ${email}. Run npm run fixtures:load or add one.`);
  return { ...person, email: person.email ?? email, role: asRole(person.role) };
}

/** The signed-in member. Sends anyone else to the sign-in page. */
export async function getViewer(): Promise<SignedInViewer> {
  const viewer = await currentViewer();
  // A page goes to sign-in; an API call (its session expired mid-use) gets a 401 it can show.
  if (!viewer) redirect((await headers()).get(API_CALL_HEADER) ? "/api/auth/required" : "/sign-in");
  return viewer;
}
