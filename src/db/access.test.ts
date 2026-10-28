import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import {
  chunks,
  commitments,
  connections,
  edges,
  entities,
  entityAliases,
  EMBEDDING_DIMS,
  messages,
  orgs,
  people,
  threadMembers,
  threads,
} from "./schema";
import { unionAcl, withScope, type Viewer } from "./scope";
import { createTestDb } from "./test-db";

/** A unit vector pointing along one axis, so similarity is easy to reason about. */
const axis = (i: number) => Array.from({ length: EMBEDDING_DIMS }, (_, j) => (j === i ? 1 : 0));

let db: Db;
let close: () => Promise<void>;
let asha: Viewer; // in #acme-deal and owns the Gmail thread
let ben: Viewer; // only sees public things
let outsider: Viewer; // different org
const ids = {} as Record<string, string>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());

  const [org] = await db.insert(orgs).values({ name: "Alro Test" }).returning();
  const [otherOrg] = await db.insert(orgs).values({ name: "Other Co" }).returning();
  const [a, b] = await db
    .insert(people)
    .values([
      { orgId: org.id, displayName: "Asha", isMember: true },
      { orgId: org.id, displayName: "Ben", isMember: true },
    ])
    .returning();
  const [o] = await db
    .insert(people)
    .values({ orgId: otherOrg.id, displayName: "Olu", isMember: true })
    .returning();
  asha = { orgId: org.id, personId: a.id };
  ben = { orgId: org.id, personId: b.id };
  outsider = { orgId: otherOrg.id, personId: o.id };

  const [slack] = await db
    .insert(connections)
    .values({ orgId: org.id, provider: "slack", scope: "org" })
    .returning();
  const [gmail] = await db
    .insert(connections)
    .values({ orgId: org.id, provider: "google", scope: "personal", ownerPersonId: a.id })
    .returning();

  const [general, acmeDeal, inbox] = await db
    .insert(threads)
    .values([
      { orgId: org.id, connectionId: slack.id, kind: "channel", externalId: "C1", title: "#general", visibility: "org" },
      { orgId: org.id, connectionId: slack.id, kind: "channel", externalId: "C2", title: "#acme-deal", visibility: "members" },
      { orgId: org.id, connectionId: gmail.id, kind: "email", externalId: "G1", title: "Re: Acme pricing", visibility: "members" },
    ])
    .returning();
  ids.acmeDeal = acmeDeal.id;
  await db.insert(threadMembers).values([
    { orgId: org.id, threadId: acmeDeal.id, personId: a.id },
    { orgId: org.id, threadId: inbox.id, personId: a.id },
  ]);

  const sentAt = new Date("2026-10-20T10:00:00Z");
  const [pub, priv, mail] = await db
    .insert(messages)
    .values([
      { orgId: org.id, threadId: general.id, connectionId: slack.id, externalId: "m1", kind: "chat", sentAt, text: "Acme renewal kickoff is next week" },
      // A buggy connector claims this private message is org-wide; the trigger must override it.
      { orgId: org.id, threadId: acmeDeal.id, connectionId: slack.id, externalId: "m2", kind: "chat", sentAt, text: "I'll send Acme the security questionnaire by Friday", acl: ["org"] },
      { orgId: org.id, threadId: inbox.id, connectionId: gmail.id, externalId: "e1", kind: "email", sentAt, text: "Acme wants a 20% discount" },
    ])
    .returning();
  Object.assign(ids, { pub: pub.id, priv: priv.id, mail: mail.id });

  await db.insert(chunks).values([
    { orgId: org.id, threadId: general.id, messageIds: [pub.id], startAt: sentAt, endAt: sentAt, text: pub.text, embedding: axis(1) },
    { orgId: org.id, threadId: acmeDeal.id, messageIds: [priv.id], startAt: sentAt, endAt: sentAt, text: priv.text, embedding: axis(0) },
  ]);

  await db.insert(commitments).values({
    orgId: org.id,
    ownerPersonId: a.id,
    title: "Send Acme the security questionnaire",
    quote: "I'll send Acme the security questionnaire by Friday",
    confidence: 0.92,
    sourceMessageId: priv.id,
    acl: unionAcl(priv.acl, [`p:${a.id}`]),
  });

  const [acme, discount] = await db
    .insert(entities)
    .values([
      // Mentioned publicly and privately: visible to anyone who saw either.
      { orgId: org.id, type: "company", name: "Acme", acl: unionAcl(pub.acl, priv.acl) },
      // Only known from Asha's inbox.
      { orgId: org.id, type: "topic", name: "Acme discount request", acl: mail.acl },
    ])
    .returning();
  ids.discount = discount.id;
  await db.insert(entityAliases).values([
    { orgId: org.id, entityId: acme.id, alias: "Acme Corp" },
    { orgId: org.id, entityId: discount.id, alias: "20% discount" },
  ]);
  await db.insert(edges).values({
    orgId: org.id,
    sourceEntityId: acme.id,
    targetEntityId: discount.id,
    relation: "requested",
    fact: "Acme asked for a 20% discount",
    sourceMessageIds: [mail.id],
    acl: mail.acl,
  });
});

afterAll(() => close());

const visibleMessageTexts = (viewer: Viewer) =>
  withScope(db, viewer, (tx) => tx.select({ text: messages.text }).from(messages)).then((rows) =>
    rows.map((r) => r.text).sort(),
  );

describe("access control", () => {
  it("shows each person only the messages they could see in the source", async () => {
    expect(await visibleMessageTexts(asha)).toHaveLength(3);
    expect(await visibleMessageTexts(ben)).toEqual(["Acme renewal kickoff is next week"]);
  });

  it("isolates organisations completely", async () => {
    expect(await visibleMessageTexts(outsider)).toEqual([]);
    const seen = await withScope(db, outsider, (tx) => tx.select().from(entities));
    expect(seen).toEqual([]);
  });

  it("ignores a connector's ACL and inherits the thread's", async () => {
    const [row] = await db.select({ acl: messages.acl }).from(messages).where(eq(messages.id, ids.priv));
    expect(row.acl).toEqual([`t:${ids.acmeDeal}`]);
  });

  it("filters vector search, even when the private chunk is the nearest match", async () => {
    const query = `[${axis(0).join(",")}]`;
    const nearest = (viewer: Viewer) =>
      withScope(db, viewer, (tx) =>
        tx
          .select({ text: chunks.text })
          .from(chunks)
          .orderBy(sql`${chunks.embedding} <=> ${query}::halfvec`)
          .limit(1),
      );
    expect((await nearest(asha))[0].text).toMatch(/security questionnaire/);
    expect((await nearest(ben))[0].text).toMatch(/renewal kickoff/);
  });

  it("hides commitments derived from private evidence", async () => {
    const titles = (viewer: Viewer) =>
      withScope(db, viewer, (tx) => tx.select({ title: commitments.title }).from(commitments));
    expect(await titles(asha)).toHaveLength(1);
    expect(await titles(ben)).toEqual([]);
  });

  it("shows derived memory if any supporting evidence is visible", async () => {
    const names = (viewer: Viewer) =>
      withScope(db, viewer, (tx) => tx.select({ name: entities.name }).from(entities)).then((r) =>
        r.map((x) => x.name).sort(),
      );
    expect(await names(asha)).toEqual(["Acme", "Acme discount request"]);
    expect(await names(ben)).toEqual(["Acme"]);

    const aliases = await withScope(db, ben, (tx) => tx.select().from(entityAliases));
    expect(aliases.map((a) => a.alias)).toEqual(["Acme Corp"]);
    expect(await withScope(db, ben, (tx) => tx.select().from(edges))).toEqual([]);
  });

  it("follows a channel when it goes public", async () => {
    await db.update(threads).set({ visibility: "org" }).where(eq(threads.id, ids.acmeDeal));
    expect(await visibleMessageTexts(ben)).toContain("I'll send Acme the security questionnaire by Friday");
    await db.update(threads).set({ visibility: "members" }).where(eq(threads.id, ids.acmeDeal));
    expect(await visibleMessageTexts(ben)).toHaveLength(1);
  });

  it("fails closed without a scope, and the app role cannot write evidence", async () => {
    const unscoped = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role alro_app`);
      return tx.select().from(messages);
    });
    expect(unscoped).toEqual([]);

    const error = await withScope(db, ben, (tx) => tx.update(messages).set({ text: "tampered" })).catch(
      (e: Error) => e,
    );
    expect((error as Error).cause).toMatchObject({ message: expect.stringMatching(/permission denied/) });
  });
});
