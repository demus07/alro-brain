import { generateText, Output } from "ai";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { meetingNotes, messages, orgs, people, threads } from "@/db/schema";
import { formatLocal } from "@/lib/time";

const MAX_CHARS = 30_000;
const MIN_CHARS = 200;

const NOTES_INSTRUCTIONS = `You write the notes for a meeting from its transcript, for a company memory.
Only use what was said. Use people's names. Translate Hindi or other languages to English.
- summary: 2-5 short sentences on what the meeting was about and where it landed.
- decisions: each thing that was decided, one sentence each. Empty if none.
- actions: who agreed to do what, and by when if a time was said (keep their wording, e.g. "by Friday"). Empty if none.
- followUp: a short follow-up email to the attendees from the organiser: thanks, the decisions, the actions with owners. Plain text, no subject line, no placeholders.`;

const notesSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  actions: z.array(z.object({ owner: z.string(), task: z.string(), due: z.string().nullable() })),
  followUp: z.string(),
});

export type MeetingNotesDraft = z.infer<typeof notesSchema>;

/** The stored notes: a summary, then decisions and actions as lists. */
export function renderNotes(n: MeetingNotesDraft): string {
  return [
    n.summary.trim(),
    ...(n.decisions.length ? ["**Decisions**", ...n.decisions.map((d) => `- ${d}`)] : []),
    ...(n.actions.length ? ["**Actions**", ...n.actions.map((a) => `- ${a.owner}: ${a.task}${a.due ? ` (${a.due})` : ""}`)] : []),
  ].join("\n");
}

/**
 * Writes notes for meeting transcripts that don't have them yet: what was decided,
 * who owes what, and a follow-up email draft. Runs once per meeting; a meeting whose
 * transcript is still arriving simply gets its notes on a later run.
 */
export async function notePending(db: Db, orgId: string, models: Models, limit = 5): Promise<number> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const pending = await db
    .select({ id: threads.id, title: threads.title })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.kind, "meeting"), sql`not exists (select 1 from meeting_notes n where n.thread_id = ${threads.id})`))
    .orderBy(asc(threads.createdAt))
    .limit(limit);

  let written = 0;
  for (const thread of pending) {
    const rows = await db
      .select({ id: messages.id, sentAt: messages.sentAt, text: messages.text, author: people.displayName })
      .from(messages)
      .leftJoin(people, eq(people.id, messages.authorPersonId))
      .where(and(eq(messages.threadId, thread.id), isNull(messages.deletedAt)))
      .orderBy(asc(messages.sentAt));
    const full = rows.map((m) => `${m.author ?? "Unknown"}: ${m.text}`).join("\n");
    if (full.length < MIN_CHARS) continue;
    // Long meetings: the opening and the closing carry the agenda and the decisions.
    const transcript = full.length > MAX_CHARS ? `${full.slice(0, MAX_CHARS / 2)}\n[...]\n${full.slice(-MAX_CHARS / 2)}` : full;

    const { output, usage } = await generateText({
      model: models.extract,
      instructions: NOTES_INSTRUCTIONS,
      output: Output.object({ schema: notesSchema }),
      prompt: `${thread.title ?? "Meeting"}, ${formatLocal(rows[0].sentAt, org.timezone)}\n\n${transcript}`,
    });
    await recordRun(db, { orgId, stage: "notes", model: models.extract, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    await db
      .insert(meetingNotes)
      .values({ orgId, threadId: thread.id, summary: renderNotes(output), followUp: output.followUp.trim() || null })
      .onConflictDoNothing();
    written++;
  }
  return written;
}
