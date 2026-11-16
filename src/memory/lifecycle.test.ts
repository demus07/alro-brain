import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedModel, testModels, wordVector } from "@/ai/test-models";
import { agentTools } from "@/agent/tools";
import type { Db } from "@/db/client";
import { auditLog, chunks, connections, edges, entities, entityAliases, messages, orgs, people, threadMembers, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { entityText, graphPending, mergeEntities, type GraphExtraction } from "@/pipeline/graph";
import { chunkPending } from "./chunks";
import {
  confidenceWord,
  factCards,
  factsToCheck,
  findDuplicates,
  isStale,
  markFactWrong,
  openDisputes,
  reinforce,
  resolveDispute,
  sameStatement,
  settles,
  speakerKind,
  startingConfidence,
  verifyFact,
  weigh,
  writeFact,
  type NewFact,
} from "./facts";
import { embedQuery, RANKING, rerankScores, search } from "./search";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
/** Founder: in both conversations. */
let sumedh: Viewer;
/** Salesperson: in both conversations. */
let asha: Viewer;
/** In the sales channel only. */
let bob: Viewer;
/** In neither. */
let olu: Viewer;
/** The client: not a member. */
let neha: string;
let clientChat: { id: string; connectionId: string };
let salesChannel: { id: string; connectionId: string };

const budget = (amount: string) => `Acme's budget for the website project is ₹${amount}.`;
const labelOf = (prompt: string, text: string) => prompt.match(new RegExp(`(M\\d+) [^\\n]*${text}`))?.[1];

/** Reads the budget conversation the way a model would: who said what, and how it relates to what is already known. */
const graph = scriptedModel((prompt): GraphExtraction => {
  const out: GraphExtraction = { entities: [], relations: [] };
  const known = [...prompt.matchAll(/^(F\d+)\. Acme's budget[^\n]*$/gm)].map((m) => m[1]);
  const say = (text: string, amount: string, extra: Partial<GraphExtraction["relations"][number]> = {}) => {
    const evidence = labelOf(prompt, text);
    if (!evidence) return;
    if (!out.entities.length) {
      out.entities.push(
        { name: "Acme", type: "company", description: "A client buying a website.", aliases: [] },
        { name: "Website project", type: "project", description: "The website being built for Acme.", aliases: [] },
      );
    }
    out.relations.push({ source: "Acme", relation: "budget_is", target: "Website project", fact: budget(amount), evidence, invalidates: [], ...extra });
  };
  say("our budget for the website is 5L", "5L");
  // A colleague's different number, not presented as a change.
  say("Acme budget is 7L", "7L", { conflictsWith: known });
  say("final budget is 6L", "6L", { stance: "confirmed", invalidates: known });
  // The same fact written again from another conversation.
  say("noting the 6L", "6L");
  const stands = labelOf(prompt, "6L still stands");
  const six = prompt.match(/^(F\d+)\. Acme's budget[^\n]*₹6L/m)?.[1];
  if (stands && six) out.confirms = [{ fact: six, evidence: stands }];
  return out;
});
const models = testModels({ graph });

const say = async (thread: { id: string; connectionId: string }, author: string, sentAt: string, text: string, kind: "chat" | "email" = "chat") => {
  const [m] = await db
    .insert(messages)
    .values({ orgId, threadId: thread.id, connectionId: thread.connectionId, externalId: randomUUID(), kind, authorPersonId: author, sentAt: new Date(sentAt), text })
    .returning();
  return m;
};
const process = async () => {
  await chunkPending(db, orgId, models);
  return graphPending(db, orgId, models);
};
const budgetFacts = () => db.select().from(edges).where(eq(edges.relation, "budget_is")).orderBy(asc(edges.validFrom));
const scoped = <T>(viewer: Viewer, fn: (tx: Db) => Promise<T>) => withScope(db, viewer, (tx) => fn(tx as unknown as Db));
type Tools = ReturnType<typeof agentTools>;
const run = <K extends keyof Tools>(viewer: Viewer, name: K, input: Parameters<NonNullable<Tools[K]["execute"]>>[0]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agentTools(db, viewer, models, "Asia/Kolkata")[name].execute as any)(input, { toolCallId: "t", messages: [] });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [org] = await db.insert(orgs).values({ name: "Alro", timezone: "Asia/Kolkata" }).returning();
  orgId = org.id;
  const [s, a, b, o, n] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true },
      { orgId, displayName: "Asha Rao", isMember: true },
      { orgId, displayName: "Bob Mehta", isMember: true },
      { orgId, displayName: "Olu Outsider", isMember: true },
      { orgId, displayName: "Neha Kapoor", isMember: false, primaryEmail: "neha@acme.example" },
    ])
    .returning();
  [sumedh, asha, bob, olu] = [s, a, b, o].map((p) => ({ orgId, personId: p.id }));
  neha = n.id;
  const [conn] = await db.insert(connections).values({ orgId, provider: "upload:whatsapp", scope: "org" }).returning();
  const [client, sales] = await db
    .insert(threads)
    .values([
      { orgId, connectionId: conn.id, kind: "whatsapp", externalId: "wa:acme", title: "Acme x Alro", visibility: "members" },
      { orgId, connectionId: conn.id, kind: "channel", externalId: "slack:sales", title: "#sales", visibility: "members" },
    ])
    .returning();
  clientChat = { id: client.id, connectionId: conn.id };
  salesChannel = { id: sales.id, connectionId: conn.id };
  await db.insert(threadMembers).values([
    { orgId, threadId: client.id, personId: s.id },
    { orgId, threadId: client.id, personId: a.id },
    { orgId, threadId: client.id, personId: n.id },
    { orgId, threadId: sales.id, personId: s.id },
    { orgId, threadId: sales.id, personId: a.id },
    { orgId, threadId: sales.id, personId: b.id },
  ]);
}, 60_000);

afterAll(() => close());

describe("the rules", () => {
  const monday = new Date("2026-11-02T10:00:00Z");
  const wednesday = new Date("2026-11-04T10:00:00Z");

  it("tells the party a fact is about from an insider talking about them", () => {
    expect(speakerKind({ id: "client", isMember: false }, [null, null])).toBe("party");
    expect(speakerKind({ id: "asha", isMember: true }, [null, null])).toBe("insider");
    expect(speakerKind({ id: "asha", isMember: true }, ["asha", null])).toBe("party");
    expect(speakerKind(null, [null, null])).toBe("unknown");
  });

  it("starts confidence from how it was said and who said it", () => {
    expect(startingConfidence("confirmed", "party")).toBeGreaterThan(startingConfidence("firm", "party"));
    expect(startingConfidence("firm", "party")).toBeGreaterThan(startingConfidence("firm", "insider"));
    expect(startingConfidence("firm", "insider")).toBeGreaterThan(startingConfidence("firm", "unknown"));
    expect(confidenceWord(startingConfidence("confirmed", "party"))).toBe("confirmed");
    expect(confidenceWord(startingConfidence("firm", "insider"))).toBe("likely");
    expect(confidenceWord(startingConfidence("tentative", "party"))).toBe("uncertain");
    // Never settled while disputed; a person's check settles it; old rows without a number read as likely.
    expect(confidenceWord(0.95, { disputed: true })).toBe("uncertain");
    expect(confidenceWord(0.4, { verified: true })).toBe("confirmed");
    expect(confidenceWord(null)).toBe("likely");
    expect(reinforce(0.8, true)).toBeGreaterThan(reinforce(0.8, false));
    expect(reinforce(0.96, true)).toBeLessThan(1);
    expect(reinforce(1, true)).toBe(1);
  });

  it("lets a higher authority supersede, and turns the reverse into a dispute", () => {
    const client = { speaker: "party" as const, speakerId: "client", at: monday };
    const colleague = { speaker: "insider" as const, speakerId: "asha", at: monday };
    // A salesperson can't overwrite the client's own number, even when it's worded as a change.
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "asha", at: wednesday }, client, "replaces")).toBe("dispute");
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "asha", at: wednesday }, client, "same_slot")).toBe("dispute");
    // The client's firm word replaces a colleague's claim, even when the model only saw a contradiction.
    expect(weigh({ stance: "firm", speaker: "party", speakerId: "client", at: wednesday }, colleague, "conflicts")).toBe("replace");
    // Equals: a change replaces, a contradiction disputes; people may revise what they said themselves.
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "bob", at: wednesday }, colleague, "replaces")).toBe("replace");
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "bob", at: wednesday }, colleague, "conflicts")).toBe("dispute");
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "asha", at: wednesday }, colleague, "conflicts")).toBe("replace");
    // A guess never replaces anything.
    expect(weigh({ stance: "tentative", speaker: "party", speakerId: "client", at: wednesday }, colleague, "replaces")).toBe("dispute");
    // Read late: later evidence already stands, unless a stronger voice said this.
    expect(weigh({ stance: "firm", speaker: "insider", speakerId: "bob", at: monday }, { ...colleague, at: wednesday }, "same_slot")).toBe("keep");
    expect(weigh({ stance: "firm", speaker: "party", speakerId: "client", at: monday }, { ...colleague, at: wednesday }, "same_slot")).toBe("dispute");
    // What a person checked isn't overturned by something said before they checked.
    expect(weigh({ stance: "firm", speaker: "party", speakerId: "client", at: monday }, { ...colleague, verifiedAt: wednesday }, "replaces")).toBe("keep");
  });

  it("settles a dispute only on a firm word with enough authority", () => {
    expect(settles({ stance: "confirmed", speaker: "party", own: true, later: true }, ["insider"])).toBe(true);
    expect(settles({ stance: "firm", speaker: "insider", own: false, later: true }, ["insider"])).toBe(true);
    // Repeating yourself, guessing, or a colleague against the client settles nothing.
    expect(settles({ stance: "firm", speaker: "insider", own: true, later: true }, ["insider"])).toBe(false);
    expect(settles({ stance: "tentative", speaker: "party", own: false, later: true }, ["insider"])).toBe(false);
    expect(settles({ stance: "firm", speaker: "insider", own: false, later: true }, ["party"])).toBe(false);
  });

  it("recognises a restatement, but not a different number or a denial", () => {
    expect(sameStatement(budget("6L"), "Acme's budget for the Website project is ₹6L")).toBe(true);
    expect(sameStatement("The Alro agency charges ₹55k per website package.", "Alro agency charges ₹55k per website package")).toBe(true);
    expect(sameStatement(budget("6L"), budget("7L"))).toBe(false);
    expect(sameStatement("Acme's contact is Ravi.", "Acme's contact is Meera.")).toBe(false);
    expect(sameStatement("Acme is a customer of Alro.", "Acme is not a customer of Alro.")).toBe(false);
    expect(sameStatement("Acme is a customer of Alro.", "Sumedh owns the pricing page.")).toBe(false);
  });

  it("calls a fact stale sooner when it's the kind that moves", () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const fact = (relation: string, days: number, extra = {}) => ({ relation, validFrom: ago(days), createdAt: ago(days), lastConfirmedAt: null, verifiedAt: null, ...extra });
    expect(isStale(fact("priced_at", 40), now)).toBe(true);
    expect(isStale(fact("works_at", 40), now)).toBe(false);
    expect(isStale(fact("collaborates_with", 40), now)).toBe(false);
    expect(isStale(fact("works_at", 100), now)).toBe(true);
    expect(isStale(fact("works_at", 100, { lastConfirmedAt: ago(5) }), now)).toBe(false);
    expect(isStale(fact("works_at", 100, { expiredAt: ago(1) }), now)).toBe(false);
  });
});

describe("₹5L, then ₹7L, then ₹6L", () => {
  it("records who said it and how sure", async () => {
    await say(clientChat, neha, "2026-11-02T10:00:00Z", "Hi team, our budget for the website is 5L");
    await process();
    const [fact] = await budgetFacts();
    expect(fact).toMatchObject({ fact: budget("5L"), assertedByPersonId: neha, disputeGroup: null, expiredAt: null });
    expect(fact.confidence).toBeCloseTo(startingConfidence("firm", "party"));
  });

  it("keeps a colleague's different number beside the client's, as a dispute", async () => {
    await say(salesChannel, asha.personId, "2026-11-04T10:00:00Z", "Heads up: Acme budget is 7L");
    await process();
    const [five, seven] = await budgetFacts();
    expect([five.expiredAt, seven.expiredAt]).toEqual([null, null]);
    expect(seven.assertedByPersonId).toBe(asha.personId);
    expect(five.disputeGroup).not.toBeNull();
    expect(seven.disputeGroup).toBe(five.disputeGroup);

    // The agent sees both sides, who said each, where, and that neither is settled.
    const seen = await run(sumedh, "lookupEntity", { name: "Acme" });
    expect(seen.facts).toHaveLength(2);
    const [clientSide, salesSide] = seen.facts;
    expect(clientSide).toMatchObject({ fact: budget("5L"), current: true, confidence: "uncertain", saidBy: "Neha Kapoor" });
    expect(clientSide.source).toMatchObject({ thread: "Acme x Alro", author: "Neha Kapoor" });
    expect(clientSide.disputedWith).toEqual([expect.objectContaining({ fact: budget("7L"), saidBy: "Asha Rao", source: salesSide.source })]);
    expect(salesSide.disputedWith).toEqual([expect.objectContaining({ fact: budget("5L"), saidBy: "Neha Kapoor", source: clientSide.source })]);
    expect(salesSide.source.ref).not.toBe(clientSide.source.ref);

    const searched = await run(sumedh, "searchMemory", { query: "What is Acme's budget for the website project?" });
    const disputed = searched.facts.filter((f: { disputedWith?: unknown[] }) => f.disputedWith?.length);
    expect(disputed.map((f: { fact: string }) => f.fact).sort()).toEqual([budget("5L"), budget("7L")]);
    expect(disputed.every((f: { confidence: string }) => f.confidence === "uncertain")).toBe(true);

    expect(await scoped(sumedh, (tx) => openDisputes(tx, new Date()))).toHaveLength(1);
  });

  it("shows a dispute only to people who can see both sides", async () => {
    // Bob reads #sales only: he gets Asha's number and learns nothing of what the client said elsewhere.
    const forBob = await run(bob, "lookupEntity", { name: "Acme" });
    expect(forBob.facts).toEqual([expect.objectContaining({ fact: budget("7L"), confidence: "likely", saidBy: "Asha Rao" })]);
    expect(forBob.facts[0].disputedWith).toBeUndefined();
    expect(await scoped(bob, (tx) => openDisputes(tx, new Date()))).toEqual([]);
    expect((await run(olu, "lookupEntity", { name: "Acme" })).error).toMatch(/Nothing known/);
  });

  it("settles when the client confirms a number: one current fact, two historical", async () => {
    await say(clientChat, neha, "2026-11-06T10:00:00Z", "Confirming after our board call: final budget is 6L");
    await process();
    const [five, seven, six] = await budgetFacts();
    expect(six).toMatchObject({ fact: budget("6L"), expiredAt: null, disputeGroup: null, assertedByPersonId: neha });
    expect(confidenceWord(six.confidence)).toBe("confirmed");
    for (const old of [five, seven]) {
      expect(old.expiredAt).not.toBeNull();
      expect(old.invalidatedBy).toBe(six.id);
      expect(old.validTo?.toISOString()).toBe("2026-11-06T10:00:00.000Z");
    }

    const now = await run(sumedh, "lookupEntity", { name: "Acme" });
    expect(now.facts).toEqual([expect.objectContaining({ fact: budget("6L"), current: true, confidence: "confirmed", saidBy: "Neha Kapoor" })]);
    expect(now.facts[0].disputedWith).toBeUndefined();
    const history = await run(sumedh, "lookupEntity", { name: "Acme", includeHistory: true });
    expect(history.facts.map((f: { fact: string; current: boolean }) => [f.fact, f.current])).toEqual([
      [budget("5L"), false],
      [budget("7L"), false],
      [budget("6L"), true],
    ]);
    expect(await scoped(sumedh, (tx) => openDisputes(tx, new Date()))).toEqual([]);
  });

  it("confirms a restatement instead of adding a copy, and lets its readers see the fact", async () => {
    const [before] = (await budgetFacts()).filter((f) => !f.expiredAt);
    expect((await run(bob, "lookupEntity", { name: "Acme" })).facts).toEqual([]);

    const restated = await say(salesChannel, sumedh.personId, "2026-11-07T10:00:00Z", "noting the 6L for Acme in the plan");
    await process();
    const [after, ...rest] = (await budgetFacts()).filter((f) => !f.expiredAt);
    expect(rest).toEqual([]);
    expect(await db.$count(edges, eq(edges.relation, "budget_is"))).toBe(3);
    expect(after.id).toBe(before.id);
    expect(after.lastConfirmedAt?.toISOString()).toBe("2026-11-07T10:00:00.000Z");
    expect(after.confidence!).toBeGreaterThan(before.confidence!);
    expect(after.sourceMessageIds).toEqual([...before.sourceMessageIds, restated.id]);
    // The client's word still stands behind it, and #sales (where it was repeated in full) can now see it.
    expect(after.assertedByPersonId).toBe(neha);
    const forBob = await run(bob, "lookupEntity", { name: "Acme" });
    expect(forBob.facts).toEqual([expect.objectContaining({ fact: budget("6L"), confidence: "confirmed" })]);
    expect(forBob.facts[0].source).toMatchObject({ thread: "#sales" });
  });

  it("counts a passing confirmation once, however often the conversation is read again", async () => {
    await say(clientChat, asha.personId, "2026-11-08T10:00:00Z", "Great, 6L still stands on our side too");
    await process();
    const [once] = (await budgetFacts()).filter((f) => !f.expiredAt);
    expect(once.lastConfirmedAt?.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(once.sourceMessageIds).toHaveLength(3);

    await db.update(chunks).set({ graphedAt: null });
    await graphPending(db, orgId, models);
    const all = await budgetFacts();
    expect(all).toHaveLength(3);
    const [again] = all.filter((f) => !f.expiredAt);
    expect(again).toMatchObject({ id: once.id, confidence: once.confidence, sourceMessageIds: once.sourceMessageIds, disputeGroup: null });
    expect(all.filter((f) => f.expiredAt)).toHaveLength(2);
  });
});

describe("authority, straight to the database", () => {
  let base: Omit<NewFact, "fact" | "stance" | "messageIds">;
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 10));
  const current = (relation: string) => db.select().from(edges).where(and(eq(edges.relation, relation), isNull(edges.expiredAt))).orderBy(asc(edges.validFrom));

  beforeAll(async () => {
    const [acme] = await db.select().from(entities).where(eq(entities.name, "Acme"));
    const [project] = await db.select().from(entities).where(eq(entities.name, "Website project"));
    base = { orgId, sourceEntityId: acme.id, targetEntityId: project.id, relation: "delivery_due", acl: acme.acl, replaces: [], conflicts: [] };
  });

  it("makes a salesperson's 'change' to the client's own date a dispute, then lets the client's confirmation settle it", async () => {
    const said = await writeFact(db, { ...base, fact: "Acme wants the website delivered by 1 December.", stance: "firm", speakerId: neha, saidAt: at(2), messageIds: [randomUUID()] });
    if (said.outcome !== "added") throw new Error("expected a new fact");
    const changed = await writeFact(db, { ...base, fact: "Acme wants the website delivered by 15 December.", stance: "firm", speakerId: asha.personId, saidAt: at(3), messageIds: [randomUUID()], replaces: [said.id] });
    expect(changed).toMatchObject({ outcome: "added", disputed: true });
    expect(await current("delivery_due")).toHaveLength(2);

    // Asha repeating herself settles nothing; the client restating theirs does.
    await writeFact(db, { ...base, fact: "Acme wants the website delivered by 15 December.", stance: "firm", speakerId: asha.personId, saidAt: at(4), messageIds: [randomUUID()] });
    expect(await current("delivery_due")).toHaveLength(2);
    const restated = await writeFact(db, { ...base, fact: "Acme wants the website delivered by 1 December.", stance: "confirmed", speakerId: neha, saidAt: at(5), messageIds: [randomUUID()] });
    expect(restated).toEqual({ outcome: "confirmed", id: said.id });
    expect(await current("delivery_due")).toEqual([expect.objectContaining({ id: said.id, disputeGroup: null })]);
  });

  it("lets the client's firm word replace a colleague's claim outright", async () => {
    const slot = { ...base, relation: "contact_is" };
    const guess = await writeFact(db, { ...slot, fact: "Acme's contact for the website project is Ravi.", stance: "firm", speakerId: asha.personId, saidAt: at(2), messageIds: [randomUUID()] });
    if (guess.outcome !== "added") throw new Error("expected a new fact");
    const corrected = await writeFact(db, { ...slot, fact: "Acme's contact for the website project is Meera.", stance: "firm", speakerId: neha, saidAt: at(3), messageIds: [randomUUID()], conflicts: [guess.id] });
    expect(corrected).toMatchObject({ outcome: "added", disputed: false });
    expect((await current("contact_is")).map((f) => f.fact)).toEqual(["Acme's contact for the website project is Meera."]);
  });

  it("never writes a question, and keeps a guess as uncertain", async () => {
    const slot = { ...base, relation: "hosting_on" };
    expect(await writeFact(db, { ...slot, fact: "Acme's website project is hosted on Vercel.", stance: "question", speakerId: asha.personId, saidAt: at(2), messageIds: [randomUUID()] })).toEqual({ outcome: "skipped" });
    await writeFact(db, { ...slot, fact: "Acme's website project is hosted on Vercel.", stance: "tentative", speakerId: asha.personId, saidAt: at(3), messageIds: [randomUUID()] });
    const [guess] = await current("hosting_on");
    expect(confidenceWord(guess.confidence)).toBe("uncertain");
    const toCheck = await scoped(sumedh, (tx) => factsToCheck(tx, at(10)));
    expect(toCheck.map((f) => f.id)).toContain(guess.id);
  });
});

describe("people checking facts", () => {
  let sideA: string;
  let sideB: string;
  const row = async (id: string) => (await db.select().from(edges).where(eq(edges.id, id)))[0];

  beforeAll(async () => {
    const [acme] = await db.select().from(entities).where(eq(entities.name, "Acme"));
    const [project] = await db.select().from(entities).where(eq(entities.name, "Website project"));
    // Two colleagues disagree in the client chat, which Olu and Bob can't read.
    const slot = { orgId, sourceEntityId: acme.id, targetEntityId: project.id, relation: "pages_in_scope", acl: [`t:${clientChat.id}`], replaces: [], conflicts: [] };
    const a = await writeFact(db, { ...slot, fact: "The website project for Acme covers 5 pages.", stance: "firm", speakerId: asha.personId, saidAt: new Date("2026-11-02T10:00:00Z"), messageIds: [randomUUID()] });
    const b = await writeFact(db, { ...slot, fact: "The website project for Acme covers 8 pages.", stance: "firm", speakerId: sumedh.personId, saidAt: new Date("2026-11-03T10:00:00Z"), messageIds: [randomUUID()], conflicts: a.outcome === "added" ? [a.id] : [] });
    if (a.outcome !== "added" || b.outcome !== "added") throw new Error("expected two facts");
    [sideA, sideB] = [a.id, b.id];
  });

  it("refuses someone who can't see the fact", async () => {
    for (const outsider of [olu, bob]) {
      await expect(verifyFact(db, outsider, sideA)).rejects.toThrow("Not found");
      await expect(markFactWrong(db, outsider, sideA)).rejects.toThrow("Not found");
      await expect(resolveDispute(db, outsider, sideB)).rejects.toThrow("Not found");
    }
    await expect(verifyFact(db, sumedh, "not-an-id")).rejects.toThrow("Bad request");
    expect(await row(sideA)).toMatchObject({ expiredAt: null, verifiedBy: null });
    expect((await row(sideA)).disputeGroup).toBe((await row(sideB)).disputeGroup);
    expect(await db.$count(auditLog, like(auditLog.action, "fact.%"))).toBe(0);
  });

  it("settles a dispute for the side a person picks, and records who did it", async () => {
    await resolveDispute(db, asha, sideB);
    expect(await row(sideB)).toMatchObject({ verifiedBy: asha.personId, confidence: 1, disputeGroup: null, expiredAt: null });
    const loser = await row(sideA);
    expect(loser.expiredAt).not.toBeNull();
    expect(loser.invalidatedBy).toBe(sideB);
    await expect(resolveDispute(db, asha, sideB)).rejects.toThrow("already settled");
    await expect(verifyFact(db, asha, sideA)).rejects.toThrow("already history");
    expect(await db.select({ action: auditLog.action, personId: auditLog.personId, target: auditLog.target }).from(auditLog).where(like(auditLog.action, "fact.%"))).toEqual([
      { action: "fact.resolve_dispute", personId: asha.personId, target: sideB },
    ]);
    const [card] = await scoped(sumedh, (tx) => factCards(tx, eq(edges.id, sideB), new Date()));
    expect(card).toMatchObject({ confidence: "confirmed", verified: true, disputedWith: [] });
  });

  it("keeps what a person checked against something said before they checked", async () => {
    const checked = await row(sideB);
    const late = await writeFact(db, {
      orgId,
      sourceEntityId: checked.sourceEntityId,
      targetEntityId: checked.targetEntityId,
      relation: checked.relation,
      acl: checked.acl,
      fact: "The website project for Acme covers 12 pages.",
      stance: "firm",
      speakerId: neha,
      saidAt: new Date("2026-11-04T10:00:00Z"),
      messageIds: [randomUUID()],
      replaces: [sideB],
      conflicts: [],
    });
    expect(late).toEqual({ outcome: "skipped" });
    expect((await row(sideB)).expiredAt).toBeNull();
  });

  it("marks a fact wrong: it becomes history and the same words don't bring it back", async () => {
    const [guess] = await db.select().from(edges).where(and(eq(edges.relation, "hosting_on"), isNull(edges.expiredAt)));
    await verifyFact(db, sumedh, guess.id);
    expect(await row(guess.id)).toMatchObject({ confidence: 1, verifiedBy: sumedh.personId });
    expect((await scoped(sumedh, (tx) => factsToCheck(tx, new Date("2026-11-12T00:00:00Z")))).map((f) => f.id)).not.toContain(guess.id);

    await markFactWrong(db, sumedh, guess.id);
    const wrong = await row(guess.id);
    expect(wrong.expiredAt).not.toBeNull();
    expect(wrong.invalidatedBy).toBeNull();
    const again = await writeFact(db, {
      orgId,
      sourceEntityId: wrong.sourceEntityId,
      targetEntityId: wrong.targetEntityId,
      relation: wrong.relation,
      acl: wrong.acl,
      fact: "Acme's website project is hosted on Vercel",
      stance: "firm",
      speakerId: asha.personId,
      saidAt: new Date("2026-11-13T10:00:00Z"),
      messageIds: [randomUUID()],
      replaces: [],
      conflicts: [],
    });
    expect(again).toEqual({ outcome: "skipped" });
    expect((await db.select({ action: auditLog.action }).from(auditLog).where(like(auditLog.action, "fact.%"))).map((a) => a.action).sort()).toEqual(["fact.resolve_dispute", "fact.verify", "fact.wrong"]);
  });
});

describe("staleness", () => {
  it("reports an old fact nobody repeated as possibly out of date, without hiding it", async () => {
    const [acme] = await db.select().from(entities).where(eq(entities.name, "Acme"));
    const [project] = await db.select().from(entities).where(eq(entities.name, "Website project"));
    const [old] = await db
      .insert(edges)
      .values({ orgId, sourceEntityId: acme.id, targetEntityId: project.id, relation: "priced_at", fact: "Acme pays ₹40k a month for upkeep of the website project.", validFrom: new Date("2025-01-10T00:00:00Z"), confidence: 0.85, sourceMessageIds: [], acl: acme.acl })
      .returning();

    const seen = await run(sumedh, "lookupEntity", { name: "Acme" });
    const fact = seen.facts.find((f: { fact: string }) => f.fact.includes("₹40k"));
    expect(fact).toMatchObject({ current: true, confidence: "likely", mayBeOutdated: true });
    expect(seen.facts.find((f: { fact: string }) => f.fact === budget("6L")).mayBeOutdated).toBeUndefined();
    expect((await scoped(sumedh, (tx) => factsToCheck(tx, new Date("2026-11-16T00:00:00Z")))).map((f) => f.id)).toContain(old.id);

    // Said again: no longer stale.
    await writeFact(db, { orgId, sourceEntityId: acme.id, targetEntityId: project.id, relation: "priced_at", acl: acme.acl, fact: old.fact, stance: "firm", speakerId: neha, saidAt: new Date("2026-11-10T00:00:00Z"), messageIds: [randomUUID()], replaces: [], conflicts: [] });
    const [card] = await scoped(sumedh, (tx) => factCards(tx, eq(edges.id, old.id), new Date("2026-11-16T00:00:00Z")));
    expect(card.mayBeOutdated).toBe(false);
  });
});

describe("duplicates", () => {
  it("finds likely duplicates by name, email and description, only among what the viewer can see", async () => {
    const acl = [`t:${clientChat.id}`];
    const embedded = (e: { name: string; type: "company" | "person" | "project"; summary: string | null }) => ({ orgId, acl, ...e, nameEmbedding: wordVector(entityText(e)) });
    const [corp, corpDupe, nehaA, nehaB, launch, launchDupe] = await db
      .insert(entities)
      .values([
        embedded({ name: "Brightdesk", type: "company", summary: "A helpdesk company evaluating the pilot." }),
        embedded({ name: "Bright Desk Inc", type: "company", summary: "Signed the order form in March." }),
        { ...embedded({ name: "Neha Kapoor", type: "person", summary: "Buyer at Acme." }), personId: neha },
        { ...embedded({ name: "N. Kapoor (Acme)", type: "person", summary: "Approves budgets." }), personId: neha },
        embedded({ name: "Spring launch", type: "project", summary: "The relaunch of the marketing site planned for March with new pricing." }),
        embedded({ name: "March relaunch", type: "project", summary: "The relaunch of the marketing site planned for March with new pricing." }),
      ])
      .returning();
    await db.insert(entityAliases).values({ orgId, entityId: corp.id, alias: "BrightDesk Inc." });
    await db.insert(edges).values({ orgId, sourceEntityId: corpDupe.id, targetEntityId: launch.id, relation: "sponsors", fact: "Bright Desk Inc sponsors the spring launch.", sourceMessageIds: [], acl });

    const pairs = await scoped(sumedh, (tx) => findDuplicates(tx));
    const pair = (a: string, b: string) => pairs.find((p) => [p.keep.id, p.dupe.id].sort().join() === [a, b].sort().join());
    expect(pair(corp.id, corpDupe.id)?.reason).toBe("shares a name");
    expect(pair(nehaA.id, nehaB.id)?.reason).toBe("same email");
    expect(pair(launch.id, launchDupe.id)?.reason).toBe("similar description");
    expect(pairs).toHaveLength(3);
    // The one with a fact behind it is the one to keep.
    expect(pair(corp.id, corpDupe.id)?.keep.id).toBe(corpDupe.id);
    expect(await scoped(olu, (tx) => findDuplicates(tx))).toEqual([]);

    await mergeEntities(db, orgId, corpDupe.id, [corp.id]);
    const [merged] = await db.select().from(entities).where(inArray(entities.id, [corp.id, corpDupe.id]));
    expect(merged.id).toBe(corpDupe.id);
    expect(merged.summary).toBe("A helpdesk company evaluating the pilot. Signed the order form in March.");
    const aliases = (await db.select().from(entityAliases).where(eq(entityAliases.entityId, corpDupe.id))).map((a) => a.alias).sort();
    expect(aliases).toEqual(["BrightDesk Inc.", "Brightdesk"]);
    expect(await db.$count(edges, eq(edges.sourceEntityId, corpDupe.id))).toBe(1);
    expect((await scoped(sumedh, (tx) => findDuplicates(tx))).map((p) => p.reason).sort()).toEqual(["same email", "similar description"]);
  });
});

describe("re-ranking", () => {
  const now = new Date("2026-11-16T00:00:00Z");

  it("weighs the match most, then entities, recency and where it was said", () => {
    expect(RANKING.fused + RANKING.meaning + RANKING.entities + RANKING.recency + RANKING.source).toBeCloseTo(1);
    const chat = { fused: 0.0328, similarity: 0.7, entities: 0, threadKind: "whatsapp", endAt: new Date("2026-08-01T00:00:00Z") };
    const email = { fused: 0.0323, similarity: 0.6, entities: 1, threadKind: "email", endAt: new Date("2026-11-10T00:00:00Z") };
    const weak = { fused: 0.0164, similarity: 0.1, entities: 0, threadKind: "doc", endAt: now };
    const [a, b, c] = rerankScores([chat, email, weak], { now });
    expect(b).toBeGreaterThan(a);
    // Being a recent document doesn't rescue something that barely matched.
    expect(c).toBeLessThan(a);
    // Inside a time window, recency is measured against the window, not today.
    const [early, late] = rerankScores(
      [
        { ...chat, endAt: new Date("2026-03-02T00:00:00Z") },
        { ...chat, endAt: new Date("2026-03-30T00:00:00Z") },
      ],
      { now, since: new Date("2026-03-01T00:00:00Z"), until: new Date("2026-03-31T00:00:00Z") },
    );
    expect(late - early).toBeGreaterThan(RANKING.recency / 2);
  });

  it("puts the decision in an email above chat banter that is the nearer vector, and still filters access in the query", async () => {
    const [mail] = await db.insert(connections).values({ orgId, provider: "upload:email", scope: "org" }).returning();
    const [inbox, banter] = await db
      .insert(threads)
      .values([
        { orgId, connectionId: mail.id, kind: "email", externalId: "mail:zephyr", title: "Zephyr go-live", visibility: "members" },
        { orgId, connectionId: clientChat.connectionId, kind: "whatsapp", externalId: "wa:banter", title: "Friday banter", visibility: "members" },
      ])
      .returning();
    await db.insert(threadMembers).values([
      { orgId, threadId: inbox.id, personId: sumedh.personId },
      { orgId, threadId: banter.id, personId: sumedh.personId },
      { orgId, threadId: banter.id, personId: bob.personId },
    ]);
    await say({ id: banter.id, connectionId: clientChat.connectionId }, bob.personId, "2026-09-01T10:00:00Z", "anyone know the zephyr launch date? zephyr launch date pls lol");
    await say({ id: inbox.id, connectionId: mail.id }, sumedh.personId, "2026-11-12T10:00:00Z", "Decision from the board call: the Zephyr launch date is 14 January, and marketing starts two weeks before.", "email");
    await chunkPending(db, orgId, models);

    const question = "zephyr launch date";
    const vector = `[${(await embedQuery(models, question)).join(",")}]`;
    const nearest = await db.execute(sql`select t.title from chunks c join threads t on t.id = c.thread_id order by c.embedding <=> ${vector}::halfvec limit 1`);
    expect((nearest as unknown as { rows: { title: string }[] }).rows[0].title).toBe("Friday banter");

    const hits = await scoped(sumedh, (tx) => search(tx, models, question, { limit: 2, now }));
    expect(hits.map((h) => h.threadTitle)).toEqual(["Zephyr go-live", "Friday banter"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    // Bob isn't on the email: it never reaches the ranking, whatever its score would have been.
    const forBob = await scoped(bob, (tx) => search(tx, models, question, { limit: 5, now }));
    expect(forBob[0].threadTitle).toBe("Friday banter");
    expect(forBob.some((h) => h.threadTitle === "Zephyr go-live")).toBe(false);
    expect(await scoped(olu, (tx) => search(tx, models, question, { limit: 5, now }))).toEqual([]);
  });
});
