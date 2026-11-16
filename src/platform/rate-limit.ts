import { createHash } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimits } from "@/db/schema";

/** A fixed-length key whatever was typed: "signin:" plus a hash, never the raw (unbounded) input. */
export const limitKey = (kind: string, ...parts: (string | null | undefined)[]) => `${kind}:${createHash("sha256").update(parts.map((p) => p ?? "").join("\n")).digest("base64url").slice(0, 32)}`;

/**
 * Counts one attempt against `key` in a fixed window and says whether it's within the limit.
 * One statement, so concurrent attempts can't slip past the count.
 */
export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number, now = new Date()): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const start = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const expired = sql`${rateLimits.windowStart} < ${start}::timestamptz`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: { count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`, windowStart: sql`case when ${expired} then ${now.toISOString()}::timestamptz else ${rateLimits.windowStart} end` },
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });
  const retryAfterSeconds = Math.max(1, Math.ceil((row.windowStart.getTime() + windowSeconds * 1000 - now.getTime()) / 1000));
  return { ok: row.count <= limit, retryAfterSeconds };
}

/** Forgets a key's count: after a successful sign-in, earlier typos shouldn't count against the next one. */
export async function clearRateLimit(db: Db, key: string) {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}

/** Drops counters whose window ended long ago. */
export async function pruneRateLimits(db: Db, now = new Date()): Promise<number> {
  return (await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - 2 * 86_400_000))).returning({ key: rateLimits.key })).length;
}
