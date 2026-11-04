import { aliasedTable, and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitments, notifications, orgs, people } from "@/db/schema";
import { formatShort } from "@/lib/time";
import type { Reminder } from "@/pipeline/watcher";
import { buildBrief, renderBrief } from "./brief";
import { sendEmail } from "./email";

const LABEL: Record<string, string> = { due_soon: "Due soon", overdue: "Overdue", overdue_followup: "Still overdue" };

/**
 * Emails what the watcher queued: one brief per person for the daily digest, and otherwise
 * one short reminder listing their promises. Notifications stay as in-app ones when email
 * isn't configured or fails; a failure for one person doesn't stop the rest.
 */
export async function deliverReminders(db: Db, orgId: string, reminders: Reminder[], now = new Date()): Promise<{ emailed: number; failed: number }> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const stats = { emailed: 0, failed: 0 };
  const appUrl = process.env.ALRO_APP_URL;

  for (const personId of new Set(reminders.map((r) => r.personId))) {
    const theirs = reminders.filter((r) => r.personId === personId);
    const [person] = await db.select({ name: people.displayName, email: people.primaryEmail, isMember: people.isMember }).from(people).where(eq(people.id, personId));
    if (!person?.email || !person.isMember) continue;
    try {
      const digest = theirs.find((r) => r.kind.startsWith("digest:"));
      let mail: { subject: string; text: string; html: string };
      if (digest) {
        // The brief already lists everything due, so it replaces the single reminders.
        mail = renderBrief(await buildBrief(db, { orgId, personId }, org.timezone, now), person.name, appUrl);
      } else {
        mail = await reminderMail(db, theirs, org.timezone, person.name);
      }
      if (!(await sendEmail({ to: person.email, ...mail }))) continue;
      await db.update(notifications).set({ channel: "email" }).where(and(eq(notifications.orgId, orgId), eq(notifications.personId, personId), inArray(notifications.kind, theirs.map((r) => r.kind))));
      stats.emailed++;
    } catch (e) {
      stats.failed++;
      console.error(`reminder email failed for ${personId}`, e instanceof Error ? e.message : e);
    }
  }
  return stats;
}

async function reminderMail(db: Db, reminders: Reminder[], timeZone: string, name: string) {
  const other = aliasedTable(people, "other");
  const ids = reminders.flatMap((r) => (r.commitmentId ? [r.commitmentId] : []));
  const rows = await db
    .select({ id: commitments.id, title: commitments.title, dueAt: commitments.dueAt, to: other.displayName })
    .from(commitments)
    .leftJoin(other, eq(other.id, commitments.counterpartyPersonId))
    .where(inArray(commitments.id, ids));
  const lines = reminders.flatMap((r) => {
    const c = rows.find((x) => x.id === r.commitmentId);
    return c ? [`${LABEL[r.kind] ?? r.kind}: ${c.title}${c.to ? ` (to ${c.to})` : ""}${c.dueAt ? `, ${formatShort(c.dueAt, timeZone)}` : ""}`] : [];
  });
  const text = [`Hi ${name.split(/\s+/)[0]},`, ...lines.map((l) => `- ${l}`)].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5"><ul>${lines.map((l) => `<li>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("")}</ul></div>`;
  return { subject: lines.length === 1 ? lines[0] : `${lines.length} promises need attention`, text, html };
}
