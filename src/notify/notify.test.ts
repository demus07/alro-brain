import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderError, transient, withRetries, type Api } from "@/connectors/api";
import type { Db } from "@/db/client";
import { chunks, commitments, connections, edges, entities, entityMentions, messages, notifications, orgs, people, threadMembers, threads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { forgetConnection } from "@/memory/forget";
import { buildBrief, renderBrief } from "./brief";
import { deliverReminders } from "./deliver";

const NOW = new Date("2026-11-05T04:00:00Z");
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: string;
let jash: string;
let outsider: string;
let connectionId: string;
let otherConnection: string;
let messageId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  [{ id: sumedh }, { id: jash }, { id: outsider }] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com" },
      { orgId, displayName: "Jash Doshi", isMember: true },
      { orgId, displayName: "Olu Outsider", isMember: true, primaryEmail: "olu@example.com" },
    ])
    .returning();
  [{ id: connectionId }, { id: otherConnection }] = await db
    .insert(connections)
    .values([
      { orgId, provider: "upload:whatsapp", scope: "personal", ownerPersonId: sumedh },
      { orgId, provider: "upload:email", scope: "personal", ownerPersonId: sumedh },
    ])
    .returning();
  const [t] = await db.insert(threads).values({ orgId, connectionId, kind: "whatsapp", externalId: "wa:1", title: "Alro", visibility: "members" }).returning();
  await db.insert(threadMembers).values([
    { orgId, threadId: t.id, personId: sumedh },
    { orgId, threadId: t.id, personId: jash },
  ]);
  const [m] = await db.insert(messages).values({ orgId, threadId: t.id, connectionId, externalId: "1", kind: "chat", authorPersonId: sumedh, sentAt: new Date("2026-11-04T18:00:00Z"), text: "I'll send the deck" }).returning();
  messageId = m.id;
  const acl = [`t:${t.id}`];
  const promise = (title: string, ownerPersonId: string, counterpartyPersonId: string, status: "overdue" | "due_soon" | "open", dueAt?: Date) => ({
    orgId, title, ownerPersonId, counterpartyPersonId, status, dueAt, quote: "I'll send the deck", confidence: 0.9, sourceMessageId: m.id, extractor: "test", acl,
  });
  await db.insert(commitments).values([
    promise("Send the deck", sumedh, jash, "overdue", new Date("2026-11-03T18:00:00Z")),
    promise("Book the call", sumedh, jash, "due_soon", new Date("2026-11-05T18:00:00Z")),
    promise("Review the site", sumedh, jash, "open"),
    promise("Share the logo", jash, sumedh, "open"),
  ]);
}, 60_000);

afterAll(() => close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the morning brief", () => {
  it("sorts promises by what needs doing, and counts the last day", async () => {
    const b = await buildBrief(db, { orgId, personId: sumedh }, "Asia/Kolkata", NOW);
    expect(b.overdue.map((p) => p.title)).toEqual(["Send the deck"]);
    expect(b.dueSoon.map((p) => p.title)).toEqual(["Book the call"]);
    expect(b.waitingOnYou.map((p) => [p.title, p.person])).toEqual([["Review the site", "Jash Doshi"]]);
    expect(b.owedToYou.map((p) => [p.title, p.person])).toEqual([["Share the logo", "Jash Doshi"]]);
    expect(b.active).toEqual([{ title: "Alro", messages: 1 }]);
    expect(renderBrief(b, "Sumedh Kudav").subject).toBe("Your ALRO brief: 1 overdue");
  });

  it("shows nothing from conversations the person isn't in", async () => {
    const b = await buildBrief(db, { orgId, personId: outsider }, "Asia/Kolkata", NOW);
    expect(b).toMatchObject({ overdue: [], active: [], messages: 0, newPromises: 0 });
  });
});

describe("delivery", () => {
  const reminders = () => [{ personId: sumedh, commitmentId: null, kind: "digest:2026-11-05" }];

  it("keeps reminders in the app when no email service is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    expect(await deliverReminders(db, orgId, reminders(), NOW)).toEqual({ emailed: 0, messaged: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("emails the brief, marks it sent, and survives a failed send", async () => {
    vi.stubEnv("RESEND_API_KEY", "test");
    await db.insert(notifications).values({ orgId, personId: sumedh, kind: "digest:2026-11-05", channel: "in_app" });
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", send);
    expect(await deliverReminders(db, orgId, reminders(), NOW)).toEqual({ emailed: 1, messaged: 0, failed: 0 });
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.to).toEqual(["sumedh@example.com"]);
    expect(body.subject).toContain("1 overdue");
    const [row] = await db.select().from(notifications).where(eq(notifications.kind, "digest:2026-11-05"));
    expect(row.channel).toBe("email");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await deliverReminders(db, orgId, reminders(), NOW)).toEqual({ emailed: 0, messaged: 0, failed: 1 });
  });
});

describe("sync retries", () => {
  it("retries network blips and rate limits, not auth failures", async () => {
    expect(transient(new ProviderError("x", 429))).toBe(true);
    expect(transient(new ProviderError("x", 503))).toBe(true);
    expect(transient(new ProviderError("x", 401))).toBe(false);
    expect(transient(new Error("getaddrinfo ENOTFOUND slack.com"))).toBe(true);

    let calls = 0;
    const flaky: Api = async () => {
      if (++calls < 3) throw new ProviderError("busy", 503);
      return { ok: true } as never;
    };
    await expect(withRetries(flaky, [0, 0, 0])("GET", "x")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);

    let denied = 0;
    const auth: Api = async () => {
      denied++;
      throw new ProviderError("no", 401);
    };
    await expect(withRetries(auth, [0, 0, 0])("GET", "x")).rejects.toThrow("no");
    expect(denied).toBe(1);
  });
});

describe("deleting a source", () => {
  it("removes what came only from it and keeps what has evidence elsewhere", async () => {
    const [t] = await db.select().from(threads).where(eq(threads.connectionId, connectionId));
    const [t2] = await db.insert(threads).values({ orgId, connectionId: otherConnection, kind: "email", externalId: "mail:1", title: "Proposal", visibility: "members" }).returning();
    const [other] = await db.insert(messages).values({ orgId, threadId: t2.id, connectionId: otherConnection, externalId: "1", kind: "email", sentAt: NOW, text: "The deck is ready" }).returning();
    const [c] = await db.insert(chunks).values({ orgId, threadId: t.id, messageIds: [messageId], startAt: NOW, endAt: NOW, text: "deck" }).returning();
    const [c2] = await db.insert(chunks).values({ orgId, threadId: t2.id, messageIds: [other.id], startAt: NOW, endAt: NOW, text: "deck" }).returning();
    const acl = [`t:${t.id}`];
    const [gone, kept, also] = await db
      .insert(entities)
      .values([
        { orgId, type: "topic", name: "Only in chat", acl },
        { orgId, type: "product", name: "The deck", acl },
        { orgId, type: "person", name: "Priya", acl },
      ])
      .returning();
    await db.insert(entityMentions).values([
      { orgId, entityId: gone.id, chunkId: c.id },
      { orgId, entityId: kept.id, chunkId: c.id },
      { orgId, entityId: kept.id, chunkId: c2.id },
    ]);
    await db.insert(edges).values([
      { orgId, sourceEntityId: gone.id, targetEntityId: kept.id, relation: "mentions", fact: "from the chat", sourceMessageIds: [messageId], acl },
      { orgId, sourceEntityId: kept.id, targetEntityId: also.id, relation: "owned_by", fact: "from both", sourceMessageIds: [messageId, other.id], acl },
    ]);

    const result = await forgetConnection(db, orgId, connectionId);
    expect(result).toMatchObject({ messages: 1, threads: 1, promises: 4, facts: 1 });
    expect(await db.$count(messages, eq(messages.connectionId, connectionId))).toBe(0);
    expect(await db.$count(chunks, eq(chunks.id, c.id))).toBe(0);
    const names = (await db.select({ name: entities.name }).from(entities)).map((e) => e.name).sort();
    expect(names).toEqual(["Priya", "The deck"]);
    expect((await db.select({ fact: edges.fact }).from(edges)).map((e) => e.fact)).toEqual(["from both"]);
  });
});
