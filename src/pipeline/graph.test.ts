import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedModel, testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { chunks, connections, edges, entities, entityMentions, messages, orgs, people, threadMembers, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { chunkPending } from "@/memory/chunks";
import { recall } from "@/memory/search";
import { graphPending, type GraphExtraction } from "./graph";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: Viewer;
let outsider: Viewer;
let emailThread: string;

const labelOf = (prompt: string, text: string) => prompt.match(new RegExp(`(M\\d+) [^\\n]*${text}`))?.[1];

/** Reads names and prices the way a model would, keyed on words in the excerpt. */
const graph = scriptedModel((prompt): GraphExtraction => {
  const out: GraphExtraction = { entities: [], relations: [] };
  if (labelOf(prompt, "Inclusions")) {
    out.entities.push({ name: "Website package", type: "product", description: "Includes 5 pages, a CMS, SEO setup and two revision rounds; delivered in 3 weeks.", aliases: [] });
  }
  const sovra = labelOf(prompt, "SOVRA");
  if (sovra) {
    out.entities.push(
      { name: "SOVRA", type: "product", description: "A name Sumedh proposed for the agency.", aliases: [] },
      { name: "Sumedh Kudav", type: "person", description: "Co-founder brainstorming agency names.", aliases: ["Sumedh"] },
    );
    out.relations.push({ source: "Sumedh Kudav", relation: "proposed", target: "SOVRA", fact: "Sumedh Kudav proposed SOVRA as the agency name.", evidence: sovra, invalidates: [] });
  }
  const old = labelOf(prompt, "40k");
  const changed = labelOf(prompt, "55k");
  if (old || changed) {
    out.entities.push(
      { name: "Website package", type: "product", description: changed ? "Now ₹55k per site." : "Priced at ₹40k per site.", aliases: [] },
      { name: "Alro agency", type: "company", description: "The agency selling the website package.", aliases: [] },
    );
    const f1 = prompt.match(/^(F\d+)\. .*40k/m)?.[1];
    out.relations.push({
      source: "Alro agency",
      relation: "priced_at",
      target: "Website package",
      fact: changed ? "The Alro agency charges ₹55k per website package." : "The Alro agency charges ₹40k per website package.",
      evidence: (changed ?? old)!,
      invalidates: changed && f1 ? [f1] : [],
    });
  }
  return out;
});
const models = testModels({ graph });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [org] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  orgId = org.id;
  const [s, j, o] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true },
      { orgId, displayName: "Jash Doshi", isMember: true },
      { orgId, displayName: "Olu Outsider", isMember: true },
    ])
    .returning();
  sumedh = { orgId, personId: s.id };
  outsider = { orgId, personId: o.id };
  const [conn] = await db.insert(connections).values({ orgId, provider: "upload:whatsapp", scope: "personal", ownerPersonId: s.id }).returning();
  const [t] = await db
    .insert(threads)
    .values({ orgId, connectionId: conn.id, kind: "whatsapp", externalId: "whatsapp:Alro", title: "Alro", visibility: "members" })
    .returning();
  await db.insert(threadMembers).values([
    { orgId, threadId: t.id, personId: s.id },
    { orgId, threadId: t.id, personId: j.id },
  ]);
  const say = (id: string, author: string, sentAt: string, text: string) =>
    db.insert(messages).values({ orgId, threadId: t.id, connectionId: conn.id, externalId: id, kind: "chat", authorPersonId: author, sentAt: new Date(sentAt), text });
  await say("1", s.id, "2026-10-25T16:30:00Z", "name idea for the agency: SOVRA");
  await say("2", j.id, "2026-10-25T16:31:00Z", "nice, and the website package is 40k per site");
  // Next day (a new chunk): the price changes, plus a pasted document far longer than one chunk.
  await say("3", s.id, "2026-10-26T16:30:00Z", "update: website package is now 55k per site");
  await say("4", s.id, "2026-10-26T16:35:00Z", "brand doc\n\n" + "Positioning and tone notes for the brand. ".repeat(500));

  // The detail lives in another source: an email thread only Sumedh is in.
  const [mail] = await db.insert(connections).values({ orgId, provider: "upload:email", scope: "personal", ownerPersonId: s.id }).returning();
  const [mt] = await db
    .insert(threads)
    .values({ orgId, connectionId: mail.id, kind: "email", externalId: "mail:1", title: "Proposal for Acme", visibility: "members" })
    .returning();
  emailThread = mt.id;
  await db.insert(threadMembers).values({ orgId, threadId: mt.id, personId: s.id });
  await db.insert(messages).values({
    orgId,
    threadId: mt.id,
    connectionId: mail.id,
    externalId: "mail:1:1",
    kind: "email",
    authorPersonId: s.id,
    sentAt: new Date("2026-10-27T09:00:00Z"),
    text: "Scope of our offer. Inclusions: five pages, a CMS, SEO setup and two revision rounds. Delivery in three weeks.",
  });
}, 60_000);

afterAll(() => close());

describe("knowledge graph", () => {
  it("splits a long pasted message across chunks, so embedding never overflows", async () => {
    await chunkPending(db, orgId, models);
    const rows = await db.select({ text: chunks.text }).from(chunks);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...rows.map((r) => r.text.length))).toBeLessThan(4200);
  });

  it("reads every chunk once: entities, where they're mentioned, and relations", async () => {
    const stats = await graphPending(db, orgId, models);
    const total = await db.$count(chunks);
    expect(stats).toMatchObject({ chunks: total, failed: 0 });
    expect(await db.$count(chunks, isNull(chunks.graphedAt))).toBe(0);
    expect((await graphPending(db, orgId, models)).chunks).toBe(0);

    const [sovra] = await db.select().from(entities).where(eq(entities.name, "SOVRA"));
    expect(sovra.summary).toContain("proposed");
    expect(sovra.nameEmbedding).not.toBeNull();
    expect(await db.$count(entityMentions, eq(entityMentions.entityId, sovra.id))).toBe(1);
    // The person entity is tied to the directory person.
    const [person] = await db.select().from(entities).where(eq(entities.name, "Sumedh Kudav"));
    expect(person.personId).toBe(sumedh.personId);
  });

  it("expires a fact when a later conversation replaces it, citing the exact message", async () => {
    const prices = await db.select().from(edges).where(eq(edges.relation, "priced_at")).orderBy(edges.createdAt);
    expect(prices).toHaveLength(2);
    const [was, now] = prices;
    expect(was.fact).toContain("40k");
    expect(was.expiredAt).not.toBeNull();
    expect(was.invalidatedBy).toBe(now.id);
    expect(now.expiredAt).toBeNull();
    const [evidence] = await db.select().from(messages).where(eq(messages.id, now.sourceMessageIds[0]));
    expect(evidence.text).toContain("55k");
    expect(now.factEmbedding).not.toBeNull();
  });

  it("doesn't duplicate facts when a chunk is read again", async () => {
    const before = await db.$count(edges);
    await db.update(chunks).set({ graphedAt: null });
    await graphPending(db, orgId, models);
    expect(await db.$count(edges)).toBe(before);
  });

  it("folds spelling variants of one name into a single entity", async () => {
    const [sovra] = await db.select().from(entities).where(eq(entities.name, "SOVRA"));
    const [labs, dupe] = await db
      .insert(entities)
      .values([
        { orgId, type: "company", name: "360 Labs", summary: "Makes Enterprise Brain.", acl: sovra.acl },
        { orgId, type: "company", name: "360labs", summary: "A competitor.", acl: sovra.acl },
      ])
      .returning();
    await db.insert(edges).values({ orgId, sourceEntityId: dupe.id, targetEntityId: sovra.id, relation: "competes_with", fact: "360labs competes with SOVRA.", sourceMessageIds: [], acl: sovra.acl });
    await graphPending(db, orgId, models);

    const left = await db.select().from(entities).where(inArray(entities.id, [labs.id, dupe.id]));
    expect(left).toHaveLength(1);
    expect(left[0].summary).toContain("competitor");
    const [moved] = await db.select().from(edges).where(eq(edges.relation, "competes_with"));
    expect(moved.sourceEntityId).toBe(left[0].id);
  });

  it("brings in the detail from another source when the best match is a passing mention", async () => {
    // Only one best hit allowed: the rest must come in as related excerpts from elsewhere.
    const found = await withScope(db, sumedh, (tx) => recall(tx as unknown as Db, models, "the website package", { limit: 1 }));
    const threadsSeen = new Set([...found.hits, ...found.related].map((h) => h.threadId));
    expect(threadsSeen.has(emailThread)).toBe(true);
    expect(threadsSeen.size).toBeGreaterThan(1);
    expect([...found.hits, ...found.related].some((h) => h.text.includes("Inclusions"))).toBe(true);
    for (const r of found.related) expect(found.hits.some((h) => h.threadId === r.threadId)).toBe(false);
  });

  it("leaves out placeholder people and anything a person hid", async () => {
    const { usefulName } = await import("./graph");
    expect(["Speaker 1", "unknown", "You", "Participant 2"].some(usefulName)).toBe(false);
    expect(usefulName("Jash Doshi")).toBe(true);

    const [sovra] = await db.select().from(entities).where(eq(entities.name, "SOVRA"));
    await db.update(entities).set({ hiddenAt: new Date() }).where(eq(entities.id, sovra.id));
    const found = await withScope(db, sumedh, (tx) => recall(tx as unknown as Db, models, "what name did we pick for the agency?"));
    expect(found.graph.entities.map((e) => e.name)).not.toContain("SOVRA");
    await db.update(entities).set({ hiddenAt: null }).where(eq(entities.id, sovra.id));
  });

  it("answers through the graph, and only for people in the chat", async () => {
    const mine = await withScope(db, sumedh, (tx) => recall(tx as unknown as Db, models, "what name did we pick for the agency?"));
    expect(mine.graph.entities.map((e) => e.name)).toContain("SOVRA");
    expect(mine.graph.facts.some((f) => f.fact.includes("SOVRA"))).toBe(true);
    expect(mine.hits.some((h) => h.text.includes("SOVRA"))).toBe(true);

    const price = await withScope(db, sumedh, (tx) => recall(tx as unknown as Db, models, "how much is the website package?"));
    const current = price.graph.facts.filter((f) => f.relation === "priced_at" && f.current);
    expect(current.map((f) => f.fact)).toEqual(["The Alro agency charges ₹55k per website package."]);

    const theirs = await withScope(db, outsider, (tx) => recall(tx as unknown as Db, models, "what name did we pick for the agency?"));
    expect(theirs).toEqual({ hits: [], related: [], graph: { entities: [], facts: [], chunkIds: [], chunkThreads: {} } });
    const mentions = await withScope(db, outsider, (tx) => tx.select().from(entityMentions).where(and(eq(entityMentions.orgId, orgId))));
    expect(mentions).toHaveLength(0);
  });
});
