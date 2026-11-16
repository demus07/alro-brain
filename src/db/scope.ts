import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { people, threadMembers } from "./schema";

export type Principal = "org" | `p:${string}` | `t:${string}` | `d:${string}`;

export interface Viewer {
  orgId: string;
  personId: string;
}

/** Everything a person may see: the org, their department, themselves, and each members-only thread they belong to. */
export async function principalsFor(db: Db, viewer: Viewer): Promise<Principal[]> {
  const [person] = await db.select({ department: people.department }).from(people).where(and(eq(people.id, viewer.personId), eq(people.orgId, viewer.orgId)));
  const department: Principal[] = person?.department && DEPARTMENT.test(person.department) ? [`d:${person.department}`] : [];
  const rows = await db
    .select({ threadId: threadMembers.threadId })
    .from(threadMembers)
    .where(
      and(
        eq(threadMembers.orgId, viewer.orgId),
        eq(threadMembers.personId, viewer.personId),
      ),
    );
  return ["org", ...department, `p:${viewer.personId}`, ...rows.map((r) => `t:${r.threadId}` as const)];
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

/** A department is a short lowercase slug, so it can be a principal without quoting. */
export const DEPARTMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const departmentSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function toPgArray(values: readonly string[]): string {
  // Principals are 'org', a prefix plus a UUID, or a department slug, so no quoting is needed; reject anything else.
  for (const v of values) {
    if (!/^(org|[pt]:[0-9a-f-]{36}|d:[a-z0-9][a-z0-9-]{0,39})$/.test(v)) throw new Error(`Invalid principal: ${v}`);
  }
  return `{${values.join(",")}}`;
}
