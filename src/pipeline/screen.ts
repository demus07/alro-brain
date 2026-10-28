import { generateText, Output } from "ai";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { messages, orgs, people, threads } from "@/db/schema";
import { formatLocal } from "@/lib/time";

const BATCH = 25;
const MAX_TEXT = 1200;

export const SCREEN_SYSTEM = `You triage workplace messages (Slack, email, WhatsApp, meeting transcripts, CRM changes) for a system that tracks promises and company facts.

Flag a message when it might:
- make a commitment: someone says they will do something, or accepts a request ("sure, will do", "kal tak kar deti hoon"),
- change one: reschedule, cancel, re-promise, or report partial progress,
- close one: report something promised as done ("PR is up", "sent", "booked", "transferred"), including CRM changes like a deal stage moving,
- state a fact worth remembering that may change over time: a price, a decision, a customer's status, who owns what, a plan's scope.

Do not flag greetings, reactions, small talk, or messages with nothing actionable or factual. When unsure, flag it: missing a promise costs more than a second look.
Messages may mix English and Hindi (Hinglish).`;

const screenSchema = z.object({
  flagged: z.array(z.number().int()).describe("Numbers of the messages to flag"),
});

/**
 * First pass over new messages with the cheap model. Sets screen_result to
 * 'extract' or 'skip'. Returns how many messages were screened.
 */
export async function screenPending(db: Db, orgId: string, models: Models, opts: { limit?: number } = {}): Promise<number> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const pending = await db
    .select({
      id: messages.id,
      text: messages.text,
      subject: messages.subject,
      sentAt: messages.sentAt,
      kind: messages.kind,
      author: people.displayName,
      thread: threads.title,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(and(eq(messages.orgId, orgId), isNull(messages.screenResult), isNull(messages.deletedAt)))
    .orderBy(asc(messages.sentAt))
    .limit(opts.limit ?? 500);

  let screened = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const listing = batch
      .map((m, n) => {
        const text = m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)}…` : m.text;
        const subject = m.subject ? ` [${m.subject}]` : "";
        return `${n + 1}. (${m.thread ?? m.kind}, ${formatLocal(m.sentAt, org.timezone)}) ${m.author ?? "Unknown"}${subject}: ${text}`;
      })
      .join("\n\n");

    let result;
    try {
      result = await generateText({
        model: models.screen,
        instructions: SCREEN_SYSTEM,
        prompt: `Messages:\n\n${listing}\n\nReturn the numbers of the messages to flag.`,
        output: Output.object({ schema: screenSchema }),
      });
    } catch (e) {
      // Leave this batch unscreened for the next run rather than failing the whole pass.
      console.error("screening failed", e instanceof Error ? e.message : e);
      continue;
    }
    const { output, usage } = result;
    await recordRun(db, {
      orgId,
      stage: "screen",
      model: models.screen,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      messageIds: batch.map((m) => m.id),
    });

    const flagged = new Set(output.flagged.filter((n) => n >= 1 && n <= batch.length).map((n) => batch[n - 1].id));
    const extract = batch.filter((m) => flagged.has(m.id)).map((m) => m.id);
    const skip = batch.filter((m) => !flagged.has(m.id)).map((m) => m.id);
    if (extract.length) await db.update(messages).set({ screenResult: "extract" }).where(inArray(messages.id, extract));
    // Skipped messages need no extraction, so they're done.
    if (skip.length) await db.update(messages).set({ screenResult: "skip", extractedAt: new Date() }).where(inArray(messages.id, skip));
    screened += batch.length;
  }
  return screened;
}
