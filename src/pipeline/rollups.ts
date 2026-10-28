import { embedMany, generateText } from "ai";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { messages, orgs, people, rollups, threads } from "@/db/schema";
import { formatLocal } from "@/lib/time";

const MIN_MESSAGES = 3;
const MAX_CHARS = 24_000;

const ROLLUP_INSTRUCTIONS = `Summarise one day of a workplace conversation for a company memory.
Write 2-6 short bullet points: decisions, numbers, status changes, promises made or kept, open questions. Use names. Keep the original language's meaning; translate Hindi to English.
No preamble. If nothing of substance happened, write "- Nothing of note."`;

/**
 * Writes one rollup per thread with activity in [periodStart, periodEnd), for
 * "what happened last week" questions. Skips quiet threads and periods that
 * already have a rollup, so reruns are cheap.
 */
export async function writeThreadRollups(db: Db, orgId: string, models: Models, periodStart: Date, periodEnd: Date): Promise<number> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const active = await db
    .select({ threadId: messages.threadId, n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), isNull(messages.deletedAt), gte(messages.sentAt, periodStart), lt(messages.sentAt, periodEnd)))
    .groupBy(messages.threadId)
    .having(sql`count(*) >= ${MIN_MESSAGES}`);

  const written: { id: string; text: string }[] = [];
  for (const { threadId } of active) {
    const [existing] = await db
      .select({ id: rollups.id })
      .from(rollups)
      .where(and(eq(rollups.scopeType, "thread"), eq(rollups.scopeId, threadId), eq(rollups.periodStart, periodStart), eq(rollups.periodEnd, periodEnd)));
    if (existing) continue;

    const [thread] = await db.select({ title: threads.title, kind: threads.kind, acl: threads.acl }).from(threads).where(eq(threads.id, threadId));
    const rows = await db
      .select({ id: messages.id, sentAt: messages.sentAt, text: messages.text, author: people.displayName })
      .from(messages)
      .leftJoin(people, eq(people.id, messages.authorPersonId))
      .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt), gte(messages.sentAt, periodStart), lt(messages.sentAt, periodEnd)))
      .orderBy(asc(messages.sentAt));
    const transcript = rows
      .map((m) => `[${formatLocal(m.sentAt, org.timezone)}] ${m.author ?? "Unknown"}: ${m.text}`)
      .join("\n")
      .slice(0, MAX_CHARS);

    const { text, usage } = await generateText({
      model: models.screen,
      instructions: ROLLUP_INSTRUCTIONS,
      prompt: `${thread.title ?? "Untitled"} (${thread.kind}), ${formatLocal(periodStart, org.timezone)} to ${formatLocal(periodEnd, org.timezone)}:\n\n${transcript}`,
    });
    await recordRun(db, {
      orgId,
      stage: "rollup",
      model: models.screen,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      messageIds: rows.map((m) => m.id),
    });
    const [row] = await db
      .insert(rollups)
      .values({
        orgId,
        scopeType: "thread",
        scopeId: threadId,
        periodStart,
        periodEnd,
        summary: text.trim(),
        sourceMessageIds: rows.map((m) => m.id),
        // Same audience as the thread it summarises.
        acl: thread.acl,
      })
      .returning({ id: rollups.id });
    written.push({ id: row.id, text: `${thread.title}: ${text}` });
  }

  if (written.length) {
    const { embeddings, usage } = await embedMany({ model: models.embed, values: written.map((w) => w.text), dimensions: models.embedDimensions });
    await recordRun(db, { orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
    for (const [i, w] of written.entries()) await db.update(rollups).set({ embedding: embeddings[i] }).where(eq(rollups.id, w.id));
  }
  return written.length;
}
