import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedModel, testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, connections, messages, orgs, people, rollups, threadMembers, threads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { previousLocalDay } from "@/lib/time";
import { applyUpdate } from "./fulfil";
import { writeThreadRollups } from "./rollups";
import { runWatcher } from "./watcher";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let rohan: string;
let ananya: string;
let threadId: string;
const ids: Record<string, string> = {};

// Tue 27 Oct 2026, 10:00 in India.
const NOW = new Date("2026-10-27T04:30:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [org] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  orgId = org.id;
  const [r, a] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Rohan Kulkarni", isMember: true },
      { orgId, displayName: "Ananya Desai", isMember: true },
    ])
    .returning();
  rohan = r.id;
  ananya = a.id;
  const [conn] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org" }).returning();
  const [t] = await db.insert(threads).values({ orgId, connectionId: conn.id, kind: "dm", externalId: "D1", title: "DM", visibility: "members" }).returning();
  threadId = t.id;
  await db.insert(threadMembers).values([
    { orgId, threadId, personId: rohan },
    { orgId, threadId, personId: ananya },
  ]);
  const day = (h: number, text: string, author = rohan) => ({
    orgId,
    threadId,
    connectionId: conn.id,
    externalId: `m${h}`,
    kind: "chat" as const,
    authorPersonId: author,
    sentAt: new Date(Date.UTC(2026, 9, 26, h)),
    text,
  });
  const msgs = await db
    .insert(messages)
    .values([day(4, "I'll send Kabir the offer letter today"), day(6, "Demo seeded except Gmail", ananya), day(8, "CASA still pending", ananya), day(10, "ok")])
    .returning();

  const promise = (key: string, dueAt: Date, status: "open" | "done" = "open") => ({
    orgId,
    ownerPersonId: rohan,
    counterpartyPersonId: ananya,
    title: key,
    quote: "I'll send Kabir the offer letter today",
    dueAt,
    dueKind: "hard" as const,
    status,
    confidence: 0.9,
    sourceMessageId: msgs[0].id,
    acl: [`t:${threadId}`],
  });
  const rows = await db
    .insert(commitments)
    .values([promise("later", hours(48)), promise("soon", hours(10)), promise("late", hours(-96)), promise("kept", hours(-96), "done")])
    .returning();
  for (const c of rows) ids[c.title] = c.id;
  ids.message = msgs[3].id;
}, 60_000);

afterAll(() => close());

const statusOf = async (key: string) => (await db.select({ s: commitments.status }).from(commitments).where(eq(commitments.id, ids[key])))[0].s;

describe("watcher", () => {
  it("moves deadlines along and queues each reminder once", async () => {
    const first = await runWatcher(db, orgId, NOW);
    expect(first.statusChanges).toBe(2);
    expect(await statusOf("later")).toBe("open");
    expect(await statusOf("soon")).toBe("due_soon");
    expect(await statusOf("late")).toBe("overdue");
    expect(await statusOf("kept")).toBe("done");

    const kinds = first.reminders.map((r) => `${r.kind}${r.commitmentId === ids.soon ? ":soon" : r.commitmentId === ids.late ? ":late" : ""}`).sort();
    expect(kinds).toEqual(["digest:2026-10-27", "digest:2026-10-27", "due_soon:soon", "overdue:late", "overdue_followup:late"]);

    const events = await db.select().from(commitmentEvents).where(eq(commitmentEvents.commitmentId, ids.late));
    expect(events).toEqual([expect.objectContaining({ type: "status_changed", fromStatus: "open", toStatus: "overdue", actor: "watcher" })]);

    const again = await runWatcher(db, orgId, hours(0.5));
    expect(again).toEqual({ statusChanges: 0, reminders: [] });
  });

  it("does not send a digest before 9am local time", async () => {
    const early = await runWatcher(db, orgId, new Date("2026-10-28T02:00:00Z")); // 07:30 IST
    expect(early.reminders.some((r) => r.kind.startsWith("digest:"))).toBe(false);
  });

  it("reopens an overdue promise when it's rescheduled, and the watcher picks it up from there", async () => {
    const [m] = await db.select().from(messages).where(eq(messages.id, ids.message));
    const applied = await applyUpdate(db, ids.late, {
      kind: "rescheduled",
      message: m,
      quote: "ok",
      newDueAt: hours(5),
      newDueText: "this afternoon",
      confidence: 0.8,
      actor: "system",
    });
    expect(applied).toBe(true);
    expect(await statusOf("late")).toBe("open");
    await runWatcher(db, orgId, hours(1));
    expect(await statusOf("late")).toBe("due_soon");
  });

  it("never reopens a closed promise", async () => {
    const [m] = await db.select().from(messages).where(eq(messages.id, ids.message));
    expect(await applyUpdate(db, ids.kept, { kind: "rescheduled", message: m, quote: "ok", newDueAt: hours(5), confidence: 0.9, actor: "system" })).toBe(false);
  });
});

describe("rollups", () => {
  it("finds the previous local day", () => {
    const { start, end } = previousLocalDay(NOW, "Asia/Kolkata");
    expect(start.toISOString()).toBe("2026-10-25T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-10-26T18:30:00.000Z");
  });

  it("summarises each active thread once, visible to the same people", async () => {
    let calls = 0;
    const models = testModels({
      screen: scriptedModel((prompt) => {
        calls++;
        expect(prompt).toContain("offer letter");
        return "- Rohan promised Kabir's offer letter today.\n- Demo seeded except Gmail; CASA pending.";
      }),
    });
    const { start, end } = previousLocalDay(NOW, "Asia/Kolkata");
    expect(await writeThreadRollups(db, orgId, models, start, end)).toBe(1);
    expect(await writeThreadRollups(db, orgId, models, start, end)).toBe(0);
    expect(calls).toBe(1);

    const [r] = await db.select().from(rollups);
    expect(r).toMatchObject({ scopeType: "thread", scopeId: threadId, acl: [`t:${threadId}`] });
    expect(r.sourceMessageIds).toHaveLength(4);
    expect(r.embedding).not.toBeNull();
  });
});
