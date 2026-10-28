import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, notifications, orgs, people } from "@/db/schema";

const DUE_SOON_MS = 24 * 60 * 60 * 1000;
/** A second reminder this long after the deadline if it's still open. */
const FOLLOWUP_MS = 3 * 24 * 60 * 60 * 1000;
/** Local hour after which the day's digest is created. */
const DIGEST_HOUR = 9;

export interface Reminder {
  personId: string;
  commitmentId: string | null;
  kind: string;
}

export interface WatcherResult {
  statusChanges: number;
  /** Reminders created by this run, ready to deliver. Never repeats one already created. */
  reminders: Reminder[];
}

/**
 * Moves commitments between open, due_soon and overdue as time passes, and
 * queues reminders. Only deadlines move these states; done and cancelled come
 * from evidence (see fulfil.ts). Safe to rerun at any time.
 */
export async function runWatcher(db: Db, orgId: string, now = new Date()): Promise<WatcherResult> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const live = await db
    .select({ id: commitments.id, status: commitments.status, dueAt: commitments.dueAt, ownerPersonId: commitments.ownerPersonId })
    .from(commitments)
    .where(and(eq(commitments.orgId, orgId), inArray(commitments.status, ["open", "due_soon", "overdue"]), isNotNull(commitments.dueAt)));

  let statusChanges = 0;
  const wanted: Reminder[] = [];
  for (const c of live) {
    const due = c.dueAt!.getTime();
    const status = due < now.getTime() ? "overdue" : due - now.getTime() <= DUE_SOON_MS ? "due_soon" : "open";
    if (status !== c.status) {
      await db.transaction(async (tx) => {
        await tx.update(commitments).set({ status }).where(eq(commitments.id, c.id));
        await tx.insert(commitmentEvents).values({
          orgId,
          commitmentId: c.id,
          type: "status_changed",
          fromStatus: c.status,
          toStatus: status,
          actor: "watcher",
          detail: { dueAt: c.dueAt!.toISOString() },
        });
      });
      statusChanges++;
    }
    if (!c.ownerPersonId) continue;
    if (status === "due_soon") wanted.push({ personId: c.ownerPersonId, commitmentId: c.id, kind: "due_soon" });
    if (status === "overdue") wanted.push({ personId: c.ownerPersonId, commitmentId: c.id, kind: "overdue" });
    if (status === "overdue" && now.getTime() - due >= FOLLOWUP_MS) {
      wanted.push({ personId: c.ownerPersonId, commitmentId: c.id, kind: "overdue_followup" });
    }
  }

  // One digest per member per local day, for members with anything open.
  const local = localDateParts(now, org.timezone);
  if (local.hour >= DIGEST_HOUR) {
    const withOpen = await db
      .selectDistinct({ personId: people.id })
      .from(people)
      .innerJoin(
        commitments,
        and(
          inArray(commitments.status, ["open", "due_soon", "overdue"]),
          sql`(${commitments.ownerPersonId} = ${people.id} or ${commitments.counterpartyPersonId} = ${people.id})`,
        ),
      )
      .where(and(eq(people.orgId, orgId), eq(people.isMember, true)));
    for (const p of withOpen) wanted.push({ personId: p.personId, commitmentId: null, kind: `digest:${local.date}` });
  }

  const reminders: Reminder[] = [];
  for (const r of wanted) {
    // The unique constraint makes "send once" hold even if two watchers race.
    const inserted = await db
      .insert(notifications)
      .values({ orgId, personId: r.personId, commitmentId: r.commitmentId, kind: r.kind, channel: "in_app", sentAt: now })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (inserted.length) reminders.push(r);
  }
  return { statusChanges, reminders };
}

function localDateParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
