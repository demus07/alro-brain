import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { threadMembers } from "./schema";

export type Principal = "org" | `p:${string}` | `t:${string}`;

export interface Viewer {
  orgId: string;
  personId: string;
}

/** Everything a person may see: the org, themselves, and each members-only thread they belong to. */
export async function principalsFor(db: Db, viewer: Viewer): Promise<Principal[]> {
  const rows = await db
    .select({ threadId: threadMembers.threadId })
    .from(threadMembers)
    .where(
      and(
        eq(threadMembers.orgId, viewer.orgId),
        eq(threadMembers.personId, viewer.personId),
      ),
    );
  return ["org", `p:${viewer.personId}`, ...rows.map((r) => `t:${r.threadId}` as const)];
}

/** ACL for a derived row: visible to anyone who can see any of its evidence, plus extra principals (e.g. the owner). */
export function unionAcl(...acls: readonly (readonly string[])[]): string[] {
  return [...new Set(acls.flat())].sort();
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` in a transaction as the `alro_app` role with the viewer's
 * principals set, so row-level security hides anything they could not see in
 * the source tool. Every user-facing read must go through here.
 */
export async function withScope<T>(
  db: Db,
  viewer: Viewer,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const principals = await principalsFor(db, viewer);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role alro_app`);
    await tx.execute(sql`select
      set_config('app.org_id', ${viewer.orgId}, true),
      set_config('app.person_id', ${viewer.personId}, true),
      set_config('app.principals', ${toPgArray(principals)}, true)`);
    return fn(tx);
  });
}

function toPgArray(values: readonly string[]): string {
  // Principals are 'org' or a prefix plus a UUID, so no quoting is needed; reject anything else.
  for (const v of values) {
    if (!/^(org|[pt]:[0-9a-f-]{36})$/.test(v)) throw new Error(`Invalid principal: ${v}`);
  }
  return `{${values.join(",")}}`;
}
