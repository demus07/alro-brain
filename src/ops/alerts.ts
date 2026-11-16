import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { Db } from "@/db/client";
import { notifications, orgs, people } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { errorText, log } from "./log";

const PREFIX = "alert:";

export interface Alert {
  /** Leave out for a problem that isn't one company's (a job that covers everyone). */
  orgId?: string | null;
  /** What is wrong, stable while it stays wrong: "job:sync", "source:<id>", "retry:<kind>:<ref>". */
  key: string;
  /** One or two plain sentences. No message text, no credentials. */
  text: string;
}

/**
 * Tells people about a problem once. The company's admins get an in-app note (a row in
 * `notifications`, shown on the Health page), and the text is posted to ALRO_ALERT_WEBHOOK_URL
 * when that is set (Slack-compatible). While the note is there the same problem stays quiet;
 * `recovered` removes it so the next failure is reported again. Never throws.
 */
export async function alert(db: Db, a: Alert, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    let name: string | undefined;
    if (a.orgId) {
      const admins = await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.orgId, a.orgId), inArray(people.role, ["owner", "admin"]), eq(people.isMember, true), isNull(people.deactivatedAt)));
      if (admins.length) {
        const noted = await db
          .insert(notifications)
          .values(admins.map((p) => ({ orgId: a.orgId!, personId: p.id, commitmentId: null, kind: `${PREFIX}${a.key}`, channel: "in_app" })))
          .onConflictDoNothing()
          .returning({ id: notifications.id });
        // Every admin already has this note: it has been reported and hasn't recovered since.
        if (!noted.length) return false;
      }
      name = (await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, a.orgId)))[0]?.name;
    }
    log.warn("alert", { key: a.key, orgId: a.orgId ?? undefined, message: a.text });
    const url = process.env.ALRO_ALERT_WEBHOOK_URL;
    if (url) {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${name ? `[${name}] ` : ""}${a.text}`.slice(0, 1500) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn("alert.webhook_refused", { key: a.key, status: res.status });
    }
    return true;
  } catch (e) {
    log.error("alert.failed", { key: a.key, error: errorText(e) });
    return false;
  }
}

/** The problem is over: clears its note so it would be reported again if it comes back. */
export async function recovered(db: Db, a: { orgId?: string | null; key: string | string[] }): Promise<void> {
  const kinds = [a.key].flat().map((k) => `${PREFIX}${k}`);
  if (!a.orgId || !kinds.length) return;
  try {
    await db.delete(notifications).where(and(eq(notifications.orgId, a.orgId), inArray(notifications.kind, kinds), isNull(notifications.commitmentId)));
  } catch (e) {
    log.error("alert.clear_failed", { key: kinds.join(","), error: errorText(e) });
  }
}

/** The problems this admin has been told about and that haven't recovered, newest first. */
export async function openAlerts(db: Db, viewer: Viewer): Promise<{ key: string; since: Date }[]> {
  const rows = await db
    .select({ kind: notifications.kind, since: notifications.sentAt })
    .from(notifications)
    .where(and(eq(notifications.orgId, viewer.orgId), eq(notifications.personId, viewer.personId), like(notifications.kind, `${PREFIX}%`)));
  return rows.map((r) => ({ key: r.kind.slice(PREFIX.length), since: r.since })).sort((a, b) => b.since.getTime() - a.since.getTime());
}
