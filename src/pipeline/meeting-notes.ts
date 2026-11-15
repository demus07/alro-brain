import { generateText, Output } from "ai";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { proposeEmail } from "@/approvals/approvals";
import { connections, meetingNotes, messages, orgs, people, threadMembers, threads } from "@/db/schema";
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
    .select({ id: threads.id, title: threads.title, connectionId: threads.connectionId })
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
    const [saved] = await db
      .insert(meetingNotes)
      .values({ orgId, threadId: thread.id, summary: renderNotes(output), followUp: output.followUp.trim() || null })
      .onConflictDoNothing()
      .returning({ id: meetingNotes.id });
    written++;
    if (saved && output.followUp.trim()) await proposeFollowUp(db, orgId, thread, output.followUp.trim()).catch((e) => console.error(`follow-up for ${thread.id} not proposed`, e));
  }
  return written;
}

/**
 * The follow-up email goes to whoever connected the meeting's source, if they were in the meeting,
 * as a proposal from their own mailbox to the other attendees. Nothing is sent until they approve it.
 */
async function proposeFollowUp(db: Db, orgId: string, thread: { id: string; title: string | null; connectionId: string | null }, followUp: string) {
  if (!thread.connectionId) return;
  const [owner] = await db
    .select({ personId: connections.ownerPersonId, isMember: people.isMember })
    .from(connections)
    .innerJoin(people, eq(people.id, connections.ownerPersonId))
    .where(eq(connections.id, thread.connectionId));
  if (!owner?.personId || !owner.isMember) return;
  // A team-wide recording account (Zoom) sees every meeting: only propose to someone who was in this one.
  const [present] = await db
    .select({ personId: threadMembers.personId })
    .from(threadMembers)
    .where(and(eq(threadMembers.threadId, thread.id), eq(threadMembers.personId, owner.personId)));
  if (!present) return;
  const attendees = await db
    .select({ email: people.primaryEmail })
    .from(threadMembers)
    .innerJoin(people, eq(people.id, threadMembers.personId))
    .where(and(eq(threadMembers.threadId, thread.id), ne(threadMembers.personId, owner.personId), isNotNull(people.primaryEmail)));
  const to = [...new Set(attendees.flatMap((a) => (a.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email) ? [a.email.toLowerCase()] : [])))];
  if (!to.length) return;
  await proposeEmail(
    db,
    { orgId, personId: owner.personId },
    { to, subject: `Notes and next steps: ${thread.title ?? "our call"}`, body: followUp },
    "Follow-up from the call's notes: decisions and who does what.",
    { origin: "meeting", notify: true },
  );
}
