import { z } from "zod";
import type { Schedule } from "@/db/schema";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the agent or the form sends. Times are local to the org: "07:00". A one-off is a local date and time. */
export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().describe("Local date and time, e.g. 2026-11-16T05:00") }),
  z.object({ kind: z.literal("daily"), time: z.string().regex(TIME).describe("24-hour local time, e.g. 07:00") }),
  z.object({ kind: z.literal("weekdays"), time: z.string().regex(TIME) }),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6).describe("0 Sunday … 6 Saturday"), time: z.string().regex(TIME) }),
  z.object({
    kind: z.literal("every"),
    minutes: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(120), z.literal(240)]).describe("How often to check, for watching for new things (inquiries, payments)"),
  }),
]);

/** Watches only speak up when there's something to say; a run that finds nothing replies with this. */
export const NOTHING_NEW = "NOTHING_NEW";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localParts(date: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, Number(x.value)]),
  );
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** The instant at which a wall-clock time occurs in a time zone. */
export function localToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  // Two passes settle the offset across a daylight-saving change.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/** A one-off's local "YYYY-MM-DDTHH:MM" (or a full ISO instant with an offset) as an instant. */
export function onceInstant(at: string, timeZone: string): Date | undefined {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(at)) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const m = at.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
  return m ? localToInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), timeZone) : undefined;
}

/** When a schedule next fires after `after`; null when a one-off is in the past. */
export function nextRun(schedule: Schedule, timeZone: string, after: Date): Date | null {
  if (schedule.kind === "once") {
    const at = onceInstant(schedule.at, timeZone);
    return at && at > after ? at : null;
  }
  if (schedule.kind === "every") return new Date(after.getTime() + schedule.minutes * 60_000);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = localParts(after, timeZone);
  for (let k = 0; k <= 8; k++) {
    // Calendar arithmetic on the local date; Date.UTC normalises month ends.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + k));
    const weekday = day.getUTCDay();
    if (schedule.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.kind === "weekly" && weekday !== schedule.weekday) continue;
    const at = localToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone);
    if (at > after) return at;
  }
  return null;
}

export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once":
      return `Once, ${schedule.at.replace("T", " ").slice(0, 16)}`;
    case "daily":
      return `Every day at ${schedule.time}`;
    case "weekdays":
      return `Weekdays at ${schedule.time}`;
    case "weekly":
      return `Every ${DAYS[schedule.weekday]} at ${schedule.time}`;
    case "every":
      return schedule.minutes < 60 ? `Every ${schedule.minutes} minutes` : schedule.minutes === 60 ? "Every hour" : `Every ${schedule.minutes / 60} hours`;
  }
}
