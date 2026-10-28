import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedModel, testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, connections, edges, entities, llmRuns, messages, orgs, people, pipelineLeases, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { containsQuote, exactQuote, normalizeConfidence, resolveName, type Extraction } from "./extract";
import { runPipeline } from "./run";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let rohan: string;
let ananya: string;
let outsider: string;
let threadId: string;
let connectionId: string;

const at = (iso: string) => new Date(iso);
const say = (externalId: string, author: string, sentAt: string, text: string) =>
  db
    .insert(messages)
    .values({ orgId, threadId, connectionId, externalId, kind: "chat", authorPersonId: author, sentAt: at(sentAt), text })
    .returning()
    .then((r) => r[0]);

/** Screens by keyword: flags anything that sounds like a promise, a report or a price. */
const screen = scriptedModel((prompt) => {
  const listed = [...prompt.matchAll(/^(\d+)\. .*?: (.*)$/gm)];
  return { flagged: listed.filter(([, , text]) => /I'll|live|\$|sometime|done|merged|renew/i.test(text)).map(([, n]) => Number(n)) };
});

const empty: Extraction = { commitments: [], updates: [], entities: [], facts: [] };
/** Finds the label the prompt gave a message, e.g. "M3" for the line containing `text`. */
const labelOf = (prompt: string, text: string) => prompt.match(new RegExp(`\\*(M\\d+) [^\\n]*${text.replace(/[$.]/g, "\\$&")}`))?.[1];

let extractCalls = 0;
const extract = scriptedModel((prompt): Extraction => {
  extractCalls++;
  const out: Extraction = { ...empty, commitments: [], updates: [], entities: [], facts: [] };
  const promise = labelOf(prompt, "preview envs tomorrow");
  if (promise) {
    out.commitments.push(
      {
        ref: "N1",
        message: promise,
        quote: "I’ll set up Neon + Vercel preview envs tomorrow", // curly apostrophe: must still match
        owner: "Ananya",
        counterparty: "Rohan Kulkarni",
        title: "Set up Neon + Vercel preview environments",
        details: null,
        dueText: "tomorrow",
        dueAt: "2026-09-04T23:59:00+05:30",
        dueKind: "hard",
        confidence: 0.95,
      },
      // Invented quote: must be rejected.
      { ref: "N2", message: promise, quote: "I promise to buy everyone lunch", owner: "Ananya Desai", counterparty: null, title: "Lunch", details: null, dueText: null, dueAt: null, dueKind: "none", confidence: 0.9 },
      // Not in the directory: must be rejected.
      { ref: "N3", message: promise, quote: "preview envs", owner: "Neha", counterparty: null, title: "Data", details: null, dueText: null, dueAt: null, dueKind: "none", confidence: 0.9 },
    );
  }
  const live = labelOf(prompt, "Preview envs are live");
  if (live) out.updates.push({ commitment: promise ? "N1" : "C1", message: live, kind: "done", quote: "Preview envs are live", newDueAt: null, newDueText: null, confidence: 0.9 });

  // Cites M1 (old context) instead of the new message, as small models do; the quote still pins it down.
  if (labelOf(prompt, "renew the domain")) {
    out.commitments.push({ ref: "N7", message: "M1", quote: "I'll renew the domain by Sunday", owner: "Rohan Kulkarni", counterparty: null, title: "Renew the domain", details: null, dueText: "by Sunday", dueAt: null, dueKind: "none", confidence: 90 });
  }
  const gmailPromise = labelOf(prompt, "Gmail importer by Thursday");
  if (gmailPromise) {
    out.commitments.push({ ref: "N9", message: gmailPromise, quote: "I'll ship the Gmail importer by Thursday", owner: "Ananya Desai", counterparty: "Rohan Kulkarni", title: "Ship the Gmail importer", details: null, dueText: "by Thursday", dueAt: "2026-10-08T23:59:00+05:30", dueKind: "hard", confidence: 0.9 });
  }
  const merged = labelOf(prompt, "Gmail importer is merged");
  const open = prompt.match(/^(C\d+)\. .*Ship the Gmail importer/m)?.[1];
  if (merged && open) out.updates.push({ commitment: open, message: merged, kind: "done", quote: "Gmail importer is merged", newDueAt: null, newDueText: null, confidence: 0.9 });

  const price49 = labelOf(prompt, "$49");
  if (price49) {
    out.entities.push({ name: "ALRO", type: "company", aliases: [] }, { name: "Team plan", type: "product", aliases: ["team tier"] });
    out.facts.push({ source: "ALRO", relation: "prices at", target: "Team plan", fact: "ALRO's team plan costs $49/user/month", message: price49, validFrom: null, invalidates: [] });
  }
  const price39 = labelOf(prompt, "$39");
  if (price39) {
    const old = prompt.match(/^(F\d+)\. ALRO's team plan costs \$49/m)?.[1];
    out.facts.push({ source: "ALRO", relation: "prices_at", target: "team tier", fact: "ALRO's team plan costs $39/user/month", message: price39, validFrom: null, invalidates: old ? [old] : [] });
  }
  return out;
});

const models = testModels({ screen, extract });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [org] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  orgId = org.id;
  const ps = await db
    .insert(people)
    .values([
      { orgId, displayName: "Rohan Kulkarni", isMember: true },
      { orgId, displayName: "Ananya Desai", isMember: true },
      { orgId, displayName: "Olu Outsider", isMember: true },
    ])
    .returning();
  [rohan, ananya, outsider] = ps.map((p) => p.id);
  const [conn] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org" }).returning();
  connectionId = conn.id;
  const [t] = await db
    .insert(threads)
    .values({ orgId, connectionId, kind: "group_dm", externalId: "G1", title: "founders", visibility: "members" })
    .returning();
  threadId = t.id;
  await db.insert((await import("@/db/schema")).threadMembers).values([
    { orgId, threadId, personId: rohan },
    { orgId, threadId, personId: ananya },
  ]);

  await say("1", ananya, "2026-09-03T05:50:40Z", "I'll set up Neon + Vercel preview envs tomorrow");
  await say("2", rohan, "2026-09-03T06:00:00Z", "nice");
  await say("3", rohan, "2026-09-03T06:05:00Z", "Pricing: we agreed $49/user/month for the team plan");
  await say("4", rohan, "2026-09-03T06:10:00Z", "we should grab coffee with the Finlo folks sometime");
  await say("5", ananya, "2026-09-04T13:15:56Z", "Preview envs are live. Links in the README");
}, 60_000);

afterAll(() => close());

describe("screen, extract and fulfil", () => {
  it("runs the whole pipeline over new messages", async () => {
    const result = await runPipeline(db, orgId, models);
    expect(result).toMatchObject({ screened: 5, extraction: { commitments: 1, updates: 1, facts: 1, rejected: 2 } });
    expect((result as { chunks: number }).chunks).toBeGreaterThan(0);

    const byId = Object.fromEntries(
      (await db.select({ externalId: messages.externalId, screen: messages.screenResult, done: messages.extractedAt }).from(messages)).map((m) => [m.externalId, m]),
    );
    expect(byId["2"].screen).toBe("skip");
    expect(byId["1"].screen).toBe("extract");
    expect(Object.values(byId).every((m) => m.done)).toBe(true);
  });

  it("stores the commitment with an exact quote and closes it on evidence", async () => {
    const [c] = await db.select().from(commitments);
    const [made, done] = await db.select({ id: messages.id }).from(messages).orderBy(asc(messages.externalId)).then((r) => [r[0], r[4]]);
    expect(c).toMatchObject({
      ownerPersonId: ananya,
      counterpartyPersonId: rohan,
      quote: "I'll set up Neon + Vercel preview envs tomorrow",
      status: "done",
      dueKind: "hard",
      sourceMessageId: made.id,
      fulfilledByMessageId: done.id,
    });
    expect(c.dueAt?.toISOString()).toBe("2026-09-04T18:29:00.000Z");
    expect(c.acl).toEqual(expect.arrayContaining([`t:${threadId}`, `p:${ananya}`, `p:${rohan}`]));

    const events = await db.select().from(commitmentEvents).where(eq(commitmentEvents.commitmentId, c.id)).orderBy(asc(commitmentEvents.createdAt));
    expect(events.map((e) => [e.type, e.toStatus])).toEqual([
      ["created", "open"],
      ["status_changed", "done"],
    ]);
    expect(events[1].messageId).toBe(done.id);
  });

  it("keeps commitments private to the people who could see the source", async () => {
    const visible = (personId: string) => withScope(db, { orgId, personId }, (tx) => tx.select({ id: commitments.id }).from(commitments));
    expect(await visible(rohan)).toHaveLength(1);
    expect(await visible(outsider)).toHaveLength(0);
  });

  it("does nothing on a rerun", async () => {
    const before = extractCalls;
    const result = await runPipeline(db, orgId, models);
    expect(result).toMatchObject({ chunks: 0, screened: 0, extraction: { calls: 0 } });
    expect(extractCalls).toBe(before);
  });

  it("invalidates a fact when a newer one replaces it, keeping both", async () => {
    await say("6", rohan, "2026-09-29T06:00:00Z", "Pricing update: dropping to $39/user/month");
    await runPipeline(db, orgId, models);

    const facts = await db.select().from(edges).orderBy(asc(edges.validFrom));
    expect(facts.map((f) => f.fact)).toEqual(["ALRO's team plan costs $49/user/month", "ALRO's team plan costs $39/user/month"]);
    const [old, current] = facts;
    expect(old.expiredAt).not.toBeNull();
    expect(old.validTo?.toISOString()).toBe("2026-09-29T06:00:00.000Z");
    expect(old.invalidatedBy).toBe(current.id);
    expect(current.expiredAt).toBeNull();
    // "team tier" is an alias, so both facts point at the same entity.
    expect(current.targetEntityId).toBe(old.targetEntityId);
    expect(old.relation).toBe("prices_at");

    const named = await db.select({ name: entities.name, embedded: entities.nameEmbedding }).from(entities);
    expect(named.map((e) => e.name).sort()).toEqual(["ALRO", "Team plan"]);
    expect(named.every((e) => e.embedded)).toBe(true);
  });

  it("closes a promise from another thread even when weeks of history arrive at once", async () => {
    // #eng is older and busier, so per-thread processing would read the "merged" message before the promise exists.
    const [eng] = await db
      .insert(threads)
      .values({ orgId, connectionId, kind: "channel", externalId: "C-eng", title: "#eng", visibility: "org" })
      .returning();
    const post = (externalId: string, thread: string, sentAt: string, text: string) =>
      db.insert(messages).values({ orgId, threadId: thread, connectionId, externalId, kind: "chat", authorPersonId: ananya, sentAt: at(sentAt), text });
    await post("e1", eng.id, "2026-10-01T05:00:00Z", "done with the importer spike");
    await post("f1", threadId, "2026-10-06T05:00:00Z", "I'll ship the Gmail importer by Thursday");
    await post("e2", eng.id, "2026-10-08T09:00:00Z", "Gmail importer is merged, CASA still pending");

    await runPipeline(db, orgId, models);
    const [c] = await db.select().from(commitments).where(eq(commitments.title, "Ship the Gmail importer"));
    expect(c.status).toBe("done");
    // Closed by a public message, so the promise is now visible org-wide.
    expect(c.acl).toContain("org");
  });

  it("survives a bad model answer: the window stays pending and is retried", async () => {
    await say("7", ananya, "2026-10-10T05:00:00Z", "I'll send the done checklist tonight");
    const broken = testModels({ screen, extract: scriptedModel(() => "not json at all") });
    const first = await runPipeline(db, orgId, broken);
    expect(first).toMatchObject({ screened: 1, extraction: { failed: 1, calls: 0 } });
    const [pending] = await db.select().from(messages).where(eq(messages.externalId, "7"));
    expect(pending).toMatchObject({ screenResult: "extract", extractedAt: null });

    await runPipeline(db, orgId, models);
    const [done] = await db.select().from(messages).where(eq(messages.externalId, "7"));
    expect(done.extractedAt).not.toBeNull();
  });

  it("finds the right message by its quote when the model cites the wrong label, and reads 90 as 0.9", async () => {
    await say("8", rohan, "2026-10-12T05:00:00Z", "ok I'll renew the domain by Sunday");
    await runPipeline(db, orgId, models);
    const [c] = await db.select().from(commitments).where(eq(commitments.title, "Renew the domain"));
    const [m] = await db.select().from(messages).where(eq(messages.externalId, "8"));
    expect(c).toMatchObject({ sourceMessageId: m.id, confidence: 0.9 });
  });

  it("runs one pipeline per org at a time, and takes over an expired lease", async () => {
    await db.insert(pipelineLeases).values({ orgId, holder: "other", expiresAt: new Date(Date.now() + 60_000) });
    expect(await runPipeline(db, orgId, models)).toEqual({ skipped: "already running" });
    await db.update(pipelineLeases).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await runPipeline(db, orgId, models)).toMatchObject({ screened: 0 });
    expect(await db.select().from(pipelineLeases)).toEqual([]);
  });

  it("logs every model call for cost tracking", async () => {
    const stages = await db.select({ stage: llmRuns.stage }).from(llmRuns);
    expect(new Set(stages.map((s) => s.stage))).toEqual(new Set(["embed", "screen", "extract"]));
  });
});

describe("quote and name helpers", () => {
  it("matches quotes despite curly apostrophes and spacing, and returns the original span", () => {
    const text = "ok so  I'll send it\ntonight, promise";
    expect(containsQuote(text, "I’ll send it tonight")).toBe(true);
    expect(exactQuote(text, "I’ll send it tonight")).toBe("I'll send it\ntonight");
    expect(containsQuote(text, "I'll send it tomorrow")).toBe(false);
  });

  it("reads 95 as 0.95 and clamps confidence into 0..1", () => {
    expect([normalizeConfidence(0.8), normalizeConfidence(95), normalizeConfidence(400), normalizeConfidence(-1)]).toEqual([0.8, 0.95, 1, 0]);
  });

  it("resolves full names and unambiguous first names only", () => {
    const dir = [
      { id: "1", displayName: "Rohan Kulkarni", isMember: true },
      { id: "2", displayName: "Ananya Desai", isMember: true },
      { id: "3", displayName: "Ananya Rao", isMember: false },
    ];
    expect(resolveName("rohan", dir)?.id).toBe("1");
    expect(resolveName("Ananya Desai", dir)?.id).toBe("2");
    expect(resolveName("Ananya", dir)).toBeUndefined();
    expect(resolveName("Neha", dir)).toBeUndefined();
  });
});
