import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { chunks, connections, messages, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { loadFounderFixtures } from "@/ingest/fixtures";
import { chunkPending, windowMessages } from "./chunks";
import { search } from "./search";

const models = testModels();
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let rohan: Viewer;
let newHire: Viewer;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ orgId } = await loadFounderFixtures(db));
  const [r] = await db.select({ id: people.id }).from(people).where(eq(people.primaryEmail, "rohan@alro.ai"));
  rohan = { orgId, personId: r.id };
  // A member who is in none of the private threads: sees only public Slack channels.
  const [n] = await db.insert(people).values({ orgId, displayName: "New Hire", isMember: true }).returning();
  newHire = { orgId, personId: n.id };
}, 120_000);

afterAll(() => close());

describe("windowing", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 8, 1, h));
  const msg = (i: number, h: number, text = "hi") => ({ id: `m${i}`, sentAt: at(h), author: "A", subject: null, text });

  it("starts a new window after 15 messages or a long gap", () => {
    const msgs = [...Array.from({ length: 17 }, (_, i) => msg(i, 1)), msg(17, 12)];
    expect(windowMessages(msgs).map((w) => w.length)).toEqual([15, 2, 1]);
  });

  it("caps a window's size in characters", () => {
    const long = "x".repeat(3000);
    expect(windowMessages([msg(1, 1, long), msg(2, 1, long)]).map((w) => w.length)).toEqual([1, 1]);
  });
});

describe("chunking and search", () => {
  it("chunks every message exactly once, and a rerun does nothing", async () => {
    expect(await chunkPending(db, orgId, models)).toBeGreaterThan(40);
    expect(await chunkPending(db, orgId, models)).toBe(0);

    const [{ unchunked }] = await db
      .select({ unchunked: sql<number>`count(*)::int` })
      .from(messages)
      .where(sql`${messages.deletedAt} is null and not exists (select 1 from chunks c where ${messages.id} = any(c.message_ids))`);
    expect(unchunked).toBe(0);
    const [{ dupes }] = await db.execute(
      sql`select count(*)::int as dupes from (select m from chunks, unnest(message_ids) m group by m having count(*) > 1) d`,
    ).then((r) => (r as unknown as { rows: { dupes: number }[] }).rows);
    expect(dupes).toBe(0);
  });

  it("rebuilds only the tail of a thread when a message arrives", async () => {
    const [eng] = await db.select().from(threads).where(eq(threads.title, "#eng"));
    const before = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.threadId, eng.id)).orderBy(chunks.startAt);
    await db.insert(messages).values({
      orgId,
      threadId: eng.id,
      connectionId: eng.connectionId,
      externalId: "late-1",
      kind: "chat",
      authorPersonId: rohan.personId,
      sentAt: new Date("2026-10-26T12:00:00Z"),
      text: "Slack signing secret rotated, ready for Brightdesk",
    });
    expect(await chunkPending(db, orgId, models)).toBe(1);
    const after = await db.select({ id: chunks.id, messageIds: chunks.messageIds }).from(chunks).where(eq(chunks.threadId, eng.id)).orderBy(chunks.startAt);
    expect(after.slice(0, -1).map((c) => c.id)).toEqual(before.slice(0, after.length - 1).map((c) => c.id));
  });

  it("finds a message by keyword and meaning", async () => {
    const hits = await withScope(db, rohan, (tx) => search(tx, models, "CASA application submitted", { limit: 3 }));
    expect(hits[0].text).toContain("Submitted the CASA application");
    expect(hits[0].threadTitle).toBe("#eng");
    expect(hits[0].messageIds.length).toBeGreaterThan(0);
  });

  it("never returns chunks from threads the asker can't see", async () => {
    const forRohan = await withScope(db, rohan, (tx) => search(tx, models, "Kabir offer letter", { limit: 20 }));
    const forNewHire = await withScope(db, newHire, (tx) => search(tx, models, "Kabir offer letter", { limit: 20 }));
    expect(forRohan.some((h) => h.threadKind === "whatsapp")).toBe(true);
    expect(forNewHire.length).toBeGreaterThan(0);
    expect(forNewHire.every((h) => h.threadKind === "channel")).toBe(true);
  });

  it("filters by time", async () => {
    const since = new Date("2026-10-20T00:00:00Z");
    const hits = await withScope(db, rohan, (tx) => search(tx, models, "demo", { since, limit: 20 }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.endAt >= since)).toBe(true);
  });

  it("skips deleted messages", async () => {
    const [conn] = await db.select().from(connections).where(and(eq(connections.orgId, orgId), eq(connections.provider, "slack")));
    expect(conn).toBeDefined();
    const deleted = await db.select({ id: messages.id }).from(messages).where(sql`${messages.deletedAt} is not null`);
    for (const { id } of deleted) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(chunks).where(sql`${id} = any(${chunks.messageIds})`);
      expect(n).toBe(0);
    }
  });
});
