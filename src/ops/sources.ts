import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { connections } from "@/db/schema";
import { sourceOf } from "@/lib/sources";
import { alert, recovered } from "./alerts";

const statuses = (db: Db, orgId: string) =>
  db.select({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status }).from(connections).where(and(eq(connections.orgId, orgId), ne(connections.status, "revoked")));

/**
 * Runs a company's sync, then tells its admins about any source that just stopped working
 * (the app refused ALRO's access, so it needs reconnecting) and clears that for sources that
 * work again. A source that stays broken is reported once, not every 15 minutes.
 */
export async function syncAndWatch<T>(db: Db, orgId: string, sync: () => Promise<T>): Promise<T> {
  const before = new Map((await statuses(db, orgId)).map((c) => [c.id, c.status]));
  const synced = await sync();
  const after = await statuses(db, orgId);
  for (const c of after) {
    if (c.status !== "error" || before.get(c.id) === "error") continue;
    const name = `${sourceOf(c.provider).label}${c.label ? ` (${c.label})` : ""}`;
    await alert(db, { orgId, key: `source:${c.id}`, text: `${name} stopped syncing: it no longer accepts ALRO's access. Reconnect it in Settings → Sources.` });
  }
  await recovered(db, { orgId, key: after.filter((c) => c.status !== "error").map((c) => `source:${c.id}`) });
  return synced;
}
