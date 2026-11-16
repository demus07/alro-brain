import { tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { routines } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { saveNote } from "@/memory/notes";
import { withinLimit } from "@/platform/usage";
import { describeSchedule, nextRun, scheduleSchema } from "@/routines/schedule";
import { NOTE_CATEGORIES, rememberNote } from "./profile";

/**
 * Tools that act for the asker alone: their personal brain, their private notes and
 * their scheduled tasks. Nothing here reaches anyone else.
 */
export function personalTools(db: Db, viewer: Viewer, timeZone: string, opts: { scheduling: boolean; now?: Date }) {
  const remember = {
    rememberAboutMe: tool({
      description:
        "Save something about the asker themselves to their personal brain: a goal for this quarter, a preference (how they like updates, tone, format), how they make a kind of decision, or a fact about their role. Use it when they tell you such a thing or ask you to remember it. Not for facts about the business: use saveNote for those.",
      inputSchema: z.object({ category: z.enum(NOTE_CATEGORIES), note: z.string().describe("One self-contained sentence") }),
      execute: async ({ category, note }) => ({ saved: true, id: await rememberNote(db, viewer, { category, text: note }) }),
    }),
    saveNote: tool({
      description:
        "Save something the asker tells you about the business into their private notes in company memory: a decision, an update, an instruction, a promise they are making, something dictated by voice. It becomes searchable for them, and promises in it are tracked. Keep their wording.",
      inputSchema: z.object({ text: z.string(), title: z.string().nullish().describe("A few words, optional") }),
      execute: async ({ text, title }) => {
        await saveNote(db, viewer, text, { title: title ?? undefined, now: opts.now });
        return { saved: true };
      },
    }),
  };
  if (!opts.scheduling) return remember;

  return {
    ...remember,
    scheduleTask: tool({
      description:
        'Schedule something for the asker: a one-off ("have the Acme summary ready by 5am"), a repeating task ("every Monday, list overdue payments") or a watch that checks every few minutes and only speaks up when there is something new ("draft a quote whenever a customer asks for prices"). At that time you run the instruction with their access and they get the result in ALRO, by email and in their linked messaging apps. Write the instruction so it makes sense on its own later.',
      inputSchema: z.object({
        title: z.string().describe("A few words"),
        instruction: z.string().describe("What to do, self-contained"),
        schedule: scheduleSchema,
        team: z.string().nullish().describe("A department of the agent team to do it (finance, sales, operations, ...) when the work fits one"),
      }),
      execute: async ({ title, instruction, schedule, team }) => {
        const nextRunAt = nextRun(schedule, timeZone, opts.now ?? new Date());
        if (!nextRunAt) return { scheduled: false, reason: "That time has already passed." };
        if (!(await withinLimit(db, viewer.orgId, "routines"))) return { scheduled: false, reason: "The company's plan limit on scheduled tasks is reached. One has to be paused or deleted first." };
        const department = team?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-") || null;
        const [row] = await db
          .insert(routines)
          .values({ orgId: viewer.orgId, ownerPersonId: viewer.personId, title, instruction, schedule, nextRunAt, team: department })
          .returning({ id: routines.id });
        return { scheduled: true, id: row.id, when: describeSchedule(schedule), firstRun: formatShort(nextRunAt, timeZone) };
      },
    }),
    listScheduledTasks: tool({
      description: "The asker's scheduled tasks, with their ids.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db
          .select()
          .from(routines)
          .where(and(eq(routines.orgId, viewer.orgId), eq(routines.ownerPersonId, viewer.personId)))
          .orderBy(desc(routines.createdAt));
        return { tasks: rows.map((r) => ({ id: r.id, title: r.title, when: describeSchedule(r.schedule), on: r.enabled, nextRun: r.nextRunAt ? formatShort(r.nextRunAt, timeZone) : null })) };
      },
    }),
    cancelScheduledTask: tool({
      description: "Delete one of the asker's scheduled tasks by id (from listScheduledTasks).",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const gone = await db.delete(routines).where(and(eq(routines.id, id), eq(routines.ownerPersonId, viewer.personId))).returning({ id: routines.id });
        return { cancelled: gone.length > 0 };
      },
    }),
  };
}
