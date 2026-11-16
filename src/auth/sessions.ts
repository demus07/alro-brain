import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { people, sessions } from "@/db/schema";

export const SESSION_COOKIE = "alro_session";
/** Set by the proxy on API requests (and stripped from everything else), never trusted from the browser for anything but picking 401 over a redirect. */
export const API_CALL_HEADER = "x-alro-api-call";
/** A session lasts this long from sign-in, however much it's used. */
export const SESSION_DAYS = 30;
const TOUCH_MS = 10 * 60_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");
export const newToken = () => randomBytes(32).toString("base64url");

export type Role = "owner" | "admin" | "member";

export interface SessionViewer {
  sessionId: string;
  orgId: string;
  personId: string;
  displayName: string;
  email: string;
  role: Role;
  department: string | null;
}

/** Starts a session and returns the token for the cookie. Only its hash is stored. */
export async function createSession(
  db: Db,
  person: { orgId: string; personId: string },
  method: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ orgId: person.orgId, personId: person.personId, tokenHash: hashToken(token), method, userAgent: meta.userAgent?.slice(0, 300), ip: meta.ip, expiresAt, createdAt: now, lastSeenAt: now });
  // Tidy up as we go: expired sessions are useless to everyone.
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  return { token, expiresAt };
}

/** The member a session token belongs to, if the session is live and they're still an active member. */
export async function sessionViewer(db: Db, token: string | undefined, now = new Date()): Promise<SessionViewer | undefined> {
  if (!token) return undefined;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      orgId: people.orgId,
      personId: people.id,
      displayName: people.displayName,
      email: people.primaryEmail,
      role: people.role,
      department: people.department,
      isMember: people.isMember,
      deactivatedAt: people.deactivatedAt,
    })
    .from(sessions)
    .innerJoin(people, eq(people.id, sessions.personId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)));
  if (!row || !row.isMember || row.deactivatedAt) return undefined;
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_MS) await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  return { sessionId: row.sessionId, orgId: row.orgId, personId: row.personId, displayName: row.displayName, email: row.email ?? "", role: asRole(row.role), department: row.department };
}

export const asRole = (role: string): Role => (role === "owner" || role === "admin" ? role : "member");

export async function endSession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Signs someone out everywhere: after a password change, or when an admin removes them. */
export async function endAllSessions(db: Db, personId: string, except?: string) {
  const rows = await db.delete(sessions).where(eq(sessions.personId, personId)).returning({ id: sessions.id, tokenHash: sessions.tokenHash, orgId: sessions.orgId, personId: sessions.personId, method: sessions.method, userAgent: sessions.userAgent, ip: sessions.ip, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt });
  const keep = except ? rows.find((r) => r.id === except) : undefined;
  if (keep) await db.insert(sessions).values(keep);
}
