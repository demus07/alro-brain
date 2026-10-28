import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, connections, messages, orgs, people, threadMembers, threads } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { recordVerdict } from "./verdicts";

let db: Db;
let close: () => Promise<void>;
let owner: Viewer;
let bystander: Viewer;
let outsider: Viewer;
let commitmentId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [org] = await db.insert(orgs).values({ name: "ALRO" }).returning();
  const orgId = org.id;
  const [o, b, x] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Owner", isMember: true },
      { orgId, displayName: "Bystander", isMember: true },
      { orgId, displayName: "Outsider", isMember: true },
    ])
    .returning();
  [owner, bystander, outsider] = [o, b, x].map((p) => ({ orgId, personId: p.id }));
  const [conn] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org" }).returning();
  const [t] = await db.insert(threads).values({ orgId, connectionId: conn.id, kind: "channel", externalId: "C", visibility: "members" }).returning();
  await db.insert(threadMembers).values([
    { orgId, threadId: t.id, personId: o.id },
    { orgId, threadId: t.id, personId: b.id },
  ]);
  const [m] = await db
    .insert(messages)
    .values({ orgId, threadId: t.id, connectionId: conn.id, externalId: "1", kind: "chat", sentAt: new Date(), text: "I'll do it" })
    .returning();
  const [c] = await db
    .insert(commitments)
    .values({ orgId, ownerPersonId: o.id, title: "Do it", quote: "I'll do it", confidence: 0.8, sourceMessageId: m.id, acl: m.acl })
    .returning();
  commitmentId = c.id;
});

afterAll(() => close());

describe("verdicts", () => {
  it("lets the owner close, dismiss and reopen, logging each", async () => {
    await recordVerdict(db, owner, commitmentId, "done");
    expect((await db.select().from(commitments))[0]).toMatchObject({ status: "done", userVerdict: "confirmed", verdictByPersonId: owner.personId });
    await recordVerdict(db, owner, commitmentId, "reopen");
    await recordVerdict(db, owner, commitmentId, "not_a_promise");
    expect((await db.select().from(commitments))[0]).toMatchObject({ status: "dismissed", userVerdict: "rejected" });

    const events = await db.select().from(commitmentEvents).where(eq(commitmentEvents.commitmentId, commitmentId));
    expect(events.map((e) => e.toStatus)).toEqual(["done", "open", "dismissed"]);
    expect(events.every((e) => e.actor === `person:${owner.personId}`)).toBe(true);
  });

  it("refuses people who aren't party to it, or can't see it", async () => {
    await expect(recordVerdict(db, bystander, commitmentId, "reopen")).rejects.toThrow(/Only the people/);
    await expect(recordVerdict(db, outsider, commitmentId, "reopen")).rejects.toThrow(/not found/);
  });
});
