import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { syncConnection, type StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import {
  chunks,
  commitmentEvents,
  commitments,
  connections,
  edges,
  entities,
  entityMentions,
  identities,
  insights,
  meetingNotes,
  messages,
  orgs,
  people,
  procedures,
  rollups,
  threadMembers,
  threads,
  trackerRows,
  trackers,
} from "@/db/schema";
import { unionAcl, withScope, type Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import type { NormalizedBatch, NormalizedMessage, NormalizedThread } from "@/ingest/types";
import { writeBatch } from "@/ingest/writer";
import { saveSecret } from "@/lib/secrets";
import { forgetConnection } from "@/memory/forget";
import { departedMembers, purgeRevoked, recomputeDerivedAcls } from "@/memory/revoke";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(() => close());
afterEach(() => vi.unstubAllGlobals());

const T0 = Date.parse("2026-11-10T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const SLACK = { provider: "slack", scope: "org" as const, externalAccountId: "T1" };
const PEOPLE = [
  { key: "slack:UA", provider: "slack", externalId: "UA", displayName: "Asha" },
  { key: "slack:UB", provider: "slack", externalId: "UB", displayName: "Ben" },
  { key: "slack:UC", provider: "slack", externalId: "UC", displayName: "Chitra" },
];

/** A fresh company with three members, so each test's rows are its own. */
async function company() {
  const [org] = await db.insert(orgs).values({ name: "Metals Co" }).returning();
  const [a, b, c] = await db
    .insert(people)
    .values(["Asha", "Ben", "Chitra"].map((displayName) => ({ orgId: org.id, displayName, isMember: true })))
    .returning();
  const viewer = (personId: string): Viewer => ({ orgId: org.id, personId });
  return { orgId: org.id, asha: viewer(a.id), ben: viewer(b.id), chitra: viewer(c.id) };
}

const channel = (externalId: string, over: Partial<NormalizedThread> = {}): NormalizedThread => ({ externalId, kind: "channel", title: `#${externalId}`, visibility: "members", memberKeys: [], ...over });
const said = (thread: string, id: string, minutes: number, text: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  threadExternalId: thread,
  externalId: `${thread}:${id}`,
  kind: "chat",
  authorKey: "slack:UA",
  sentAt: at(minutes),
  text,
  ...over,
});
const slackBatch = (batch: Partial<NormalizedBatch>): NormalizedBatch => ({ connection: SLACK, people: PEOPLE, threads: [], messages: [], ...batch });

const stored = async (orgId: string, externalId: string) => (await db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.externalId, externalId))))[0];
const threadOf = async (orgId: string, externalId: string) => (await db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.externalId, externalId))))[0];

/** What one person can read, through row-level security, the way the app reads it. */
async function sees(viewer: Viewer) {
  return withScope(db, viewer, async (tx) => ({
    messages: (await tx.select({ text: messages.text }).from(messages).where(isNull(messages.deletedAt)).orderBy(messages.sentAt)).map((m) => m.text),
    chunks: (await tx.select({ text: chunks.text }).from(chunks)).map((c) => c.text).sort(),
    facts: (await tx.select({ fact: edges.fact }).from(edges)).map((e) => e.fact).sort(),
    promises: (await tx.select({ title: commitments.title }).from(commitments)).map((c) => c.title).sort(),
    entities: (await tx.select({ name: entities.name }).from(entities)).map((e) => e.name).sort(),
    summaries: (await tx.select({ summary: rollups.summary }).from(rollups)).map((r) => r.summary).sort(),
    insights: (await tx.select({ title: insights.title }).from(insights)).map((i) => i.title).sort(),
    notes: (await tx.select({ summary: meetingNotes.summary }).from(meetingNotes)).map((n) => n.summary).sort(),
  }));
}

/** What the pipeline would derive from one message: a chunk, two entities, a fact, a promise, a summary, an insight and meeting notes. */
async function derive(orgId: string, externalId: string, label: string, owner: Viewer) {
  const m = await stored(orgId, externalId);
  const [chunk] = await db.insert(chunks).values({ orgId, threadId: m.threadId, messageIds: [m.id], startAt: m.sentAt, endAt: m.sentAt, text: `chunk: ${label}` }).returning();
  const [x, y] = await db
    .insert(entities)
    .values([
      { orgId, type: "company", name: `${label} buyer`, acl: m.acl },
      { orgId, type: "deal", name: `${label} deal`, acl: m.acl },
    ])
    .returning();
  await db.insert(entityMentions).values({ orgId, entityId: x.id, chunkId: chunk.id });
  const [fact] = await db.insert(edges).values({ orgId, sourceEntityId: x.id, targetEntityId: y.id, relation: "owns_deal", fact: `fact: ${label}`, sourceMessageIds: [m.id], acl: m.acl }).returning();
  const [promise] = await db
    .insert(commitments)
    .values({ orgId, ownerPersonId: owner.personId, title: `promise: ${label}`, quote: m.text, confidence: 0.9, sourceMessageId: m.id, acl: unionAcl(m.acl, [`p:${owner.personId}`]) })
    .returning();
  await db.insert(rollups).values({ orgId, scopeType: "thread", scopeId: m.threadId, periodStart: at(-600), periodEnd: at(600), summary: `summary: ${label}`, sourceMessageIds: [m.id], acl: m.acl });
  await db.insert(insights).values({ orgId, kind: "gone_quiet", key: `quiet:${label}`, title: `insight: ${label}`, detail: "No reply in a week", evidenceMessageIds: [m.id], acl: m.acl });
  await db.insert(meetingNotes).values({ orgId, threadId: m.threadId, summary: `notes: ${label}` });
  return { message: m, chunk, fact, promise };
}

describe("someone removed from a private channel", () => {
  it("loses its messages, chunks and everything derived only from it on the next sync; the others keep them", async () => {
    const { orgId, asha, ben, chitra } = await company();
    const deals = channel("deals", { memberKeys: ["slack:UA", "slack:UB"], membersComplete: true });
    const messagesIn = [said("deals", "1", 0, "Tata will pay 42 a kilo"), said("deals", "2", 1, "I'll send the contract by Friday")];
    await writeBatch(db, orgId, slackBatch({ threads: [deals], messages: messagesIn }), "backfill");
    // Asha's promise, so Ben only ever saw it through the channel.
    await derive(orgId, "deals:2", "tata", asha);

    const before = await sees(ben);
    expect(before.messages).toEqual(["Tata will pay 42 a kilo", "I'll send the contract by Friday"]);
    expect([before.chunks, before.facts, before.promises, before.summaries, before.insights, before.notes]).toEqual([["chunk: tata"], ["fact: tata"], ["promise: tata"], ["summary: tata"], ["insight: tata"], ["notes: tata"]]);
    expect(before.entities).toEqual(["tata buyer", "tata deal"]);
    expect((await sees(chitra)).messages).toEqual([]);

    // Slack's member list no longer has Ben.
    const result = await writeBatch(db, orgId, slackBatch({ threads: [{ ...deals, memberKeys: ["slack:UA"] }], messages: messagesIn }), "incremental");
    expect(result.revoked).toEqual({ members: 1, threads: 0, messages: 0 });

    expect(await sees(ben)).toEqual({ messages: [], chunks: [], facts: [], promises: [], entities: [], summaries: [], insights: [], notes: [] });
    const after = await sees(asha);
    expect(after.messages).toHaveLength(2);
    expect([after.chunks, after.facts, after.promises, after.entities]).toEqual([["chunk: tata"], ["fact: tata"], ["promise: tata"], ["tata buyer", "tata deal"]]);
  });

  it("never shrinks a partial list, and keeps the owner of a personal source on a complete one", async () => {
    const { orgId, asha, ben, chitra } = await company();
    const mail = (to: string[], over: Partial<NormalizedThread> = {}): NormalizedBatch => ({
      connection: { provider: "gmail", scope: "personal", externalAccountId: "asha@example.com" },
      people: PEOPLE,
      threads: [{ externalId: "<root@example.com>", kind: "email", title: "Quote", visibility: "members", memberKeys: to, ...over }],
      messages: [{ threadExternalId: "<root@example.com>", externalId: `<${to.join("+")}@example.com>`, kind: "email", authorKey: to[0], sentAt: at(0), text: `to ${to.join(", ")}` }],
    });
    const members = async () => {
      const t = await threadOf(orgId, "<root@example.com>");
      return (await db.select({ personId: threadMembers.personId }).from(threadMembers).where(eq(threadMembers.threadId, t.id))).map((m) => m.personId).sort();
    };

    await writeBatch(db, orgId, mail(["slack:UB", "slack:UC"]), "backfill", asha.personId);
    // The next email in the thread is only to Chitra: its participants are not the thread's whole audience.
    const later = await writeBatch(db, orgId, mail(["slack:UC"]), "incremental", asha.personId);
    expect(later.revoked.members).toBe(0);
    expect(await members()).toEqual([asha.personId, ben.personId, chitra.personId].sort());

    // A source that does vouch for its list drops Ben, but not Asha, whose mailbox it is even though the list doesn't name her.
    const whole = await writeBatch(db, orgId, mail(["slack:UC"], { membersComplete: true }), "incremental", asha.personId);
    expect(whole.revoked.members).toBe(1);
    expect(await members()).toEqual([asha.personId, chitra.personId].sort());
  });

  it("hides a thread from everyone once the connection can no longer read it", async () => {
    const { orgId, asha, chitra } = await company();
    await writeBatch(
      db,
      orgId,
      slackBatch({
        threads: [channel("general", { visibility: "org" }), channel("deals", { memberKeys: ["slack:UA"], membersComplete: true })],
        messages: [said("general", "1", 0, "Office closed Monday"), said("deals", "1", 1, "Margin is 14%")],
      }),
      "backfill",
    );
    await derive(orgId, "general:1", "office", asha);
    expect((await sees(chitra)).facts).toEqual(["fact: office"]);

    // The channel was deleted and the app was taken out of #deals: nobody's access can be checked any more.
    const result = await writeBatch(db, orgId, slackBatch({ lostThreads: ["general", "deals", "never-synced"] }), "incremental");
    expect(result.revoked).toMatchObject({ members: 1, threads: 1 });
    expect((await sees(asha)).messages).toEqual([]);
    const left = await sees(chitra);
    expect([left.messages, left.chunks, left.facts, left.summaries, left.insights]).toEqual([[], [], [], [], []]);
    // Asha still sees her own promise, as its owner; nobody else does.
    expect((await sees(asha)).promises).toEqual(["promise: office"]);
    expect(left.promises).toEqual([]);

    // A later sync that can read it again puts it back.
    await writeBatch(db, orgId, slackBatch({ threads: [channel("general", { visibility: "org" })] }), "incremental");
    expect((await sees(chitra)).messages).toEqual(["Office closed Monday"]);
    expect((await sees(chitra)).facts).toEqual(["fact: office"]);
  });
});

describe("a channel going private", () => {
  it("hides what was derived from it from non-members, and keeps what other public evidence still supports", async () => {
    const { orgId, asha, ben, chitra } = await company();
    await writeBatch(
      db,
      orgId,
      slackBatch({
        threads: [channel("pricing", { visibility: "org" }), channel("general", { visibility: "org" })],
        messages: [said("pricing", "1", 0, "Floor price is 40"), said("general", "1", 1, "We sell HR coil")],
      }),
      "backfill",
    );
    const pricing = await derive(orgId, "pricing:1", "floor", asha);
    const general = await derive(orgId, "general:1", "coil", asha);
    // One fact said in both channels, one promise made in #general and confirmed in #pricing, an entity nothing points to.
    const [both] = await db
      .insert(edges)
      .values({ orgId, sourceEntityId: (await db.select().from(entities).where(eq(entities.name, "floor buyer")))[0].id, targetEntityId: (await db.select().from(entities).where(eq(entities.name, "coil deal")))[0].id, relation: "buys", fact: "fact: said in both", sourceMessageIds: [pricing.message.id, general.message.id], acl: ["org"] })
      .returning();
    await db.update(commitments).set({ evidenceMessageIds: [pricing.message.id] }).where(eq(commitments.id, general.promise.id));
    await db.insert(entities).values({ orgId, type: "topic", name: "untraceable", acl: ["org"] });

    const open = await sees(chitra);
    expect(open.facts).toEqual(["fact: coil", "fact: floor", "fact: said in both"]);
    expect(open.entities).toEqual(["coil buyer", "coil deal", "floor buyer", "floor deal", "untraceable"]);

    // #pricing becomes a private channel with Asha and Ben in it.
    const result = await writeBatch(db, orgId, slackBatch({ threads: [channel("pricing", { memberKeys: ["slack:UA", "slack:UB"], membersComplete: true })] }), "incremental");
    expect(result.revoked.threads).toBe(1);

    const closed = await sees(chitra);
    expect(closed.messages).toEqual(["We sell HR coil"]);
    expect(closed.chunks).toEqual(["chunk: coil"]);
    expect(closed.facts).toEqual(["fact: coil", "fact: said in both"]);
    // "floor buyer" is still the subject of the fact said in both channels; "floor deal" was only ever in #pricing.
    expect(closed.entities).toEqual(["coil buyer", "coil deal", "floor buyer"]);
    expect([closed.promises, closed.summaries, closed.insights, closed.notes]).toEqual([["promise: coil"], ["summary: coil"], ["insight: coil"], ["notes: coil"]]);
    // Ben is in the channel, so nothing changed for him (the promise is Asha's; he sees it through the channel).
    const member = await sees(ben);
    expect(member.facts).toEqual(["fact: coil", "fact: floor", "fact: said in both"]);
    expect([member.promises, member.summaries, member.insights, member.notes]).toEqual([
      ["promise: coil", "promise: floor"],
      ["summary: coil", "summary: floor"],
      ["insight: coil", "insight: floor"],
      ["notes: coil", "notes: floor"],
    ]);
    expect((await db.select({ acl: edges.acl }).from(edges).where(eq(edges.id, both.id)))[0].acl).toEqual(["org", `t:${pricing.message.threadId}`]);

    // Made public again: recomputing from the evidence opens it back up.
    await writeBatch(db, orgId, slackBatch({ threads: [channel("pricing", { visibility: "org" })] }), "incremental");
    expect((await sees(chitra)).facts).toEqual(["fact: coil", "fact: floor", "fact: said in both"]);
    expect((await sees(chitra)).promises).toEqual(["promise: coil", "promise: floor"]);
  });

  it("follows a source being limited to one department", async () => {
    const { orgId, asha, chitra } = await company();
    const { connectionId } = await writeBatch(db, orgId, slackBatch({ threads: [channel("finance", { visibility: "org" })], messages: [said("finance", "1", 0, "Payroll runs on the 28th")] }), "backfill");
    const { message } = await derive(orgId, "finance:1", "payroll", asha);
    await db.update(people).set({ department: "finance" }).where(eq(people.id, asha.personId));
    expect((await sees(chitra)).facts).toEqual(["fact: payroll"]);

    // The trigger moves threads, messages and chunks to 'd:finance'; derived rows wait for the recompute.
    await db.update(connections).set({ department: "finance" }).where(eq(connections.id, connectionId));
    expect((await sees(chitra)).messages).toEqual([]);
    expect((await sees(chitra)).facts).toEqual(["fact: payroll"]);
    expect(await recomputeDerivedAcls(db, orgId, [message.threadId])).toMatchObject({ edges: 1, commitments: 1, rollups: 1, insights: 1, entities: 2 });
    const outside = await sees(chitra);
    expect([outside.facts, outside.promises, outside.entities, outside.summaries, outside.insights]).toEqual([[], [], [], [], []]);
    expect((await sees(asha)).facts).toEqual(["fact: payroll"]);
  });
});

describe("a message deleted at the source", () => {
  const thread = (over: Partial<NormalizedThread> = {}) => channel("ops", { visibility: "org", ...over });
  const all = [said("ops", "1", 0, "Truck left at 9"), said("ops", "2", 10, "Salary sheet attached, oops"), said("ops", "3", 20, "Unloaded by noon")];

  it("disappears from reads and search when the stretch was read to the end; an incomplete read deletes nothing", async () => {
    const { orgId, chitra } = await company();
    await writeBatch(db, orgId, slackBatch({ threads: [thread()], messages: all }), "backfill");
    const ids = await Promise.all(["ops:1", "ops:2", "ops:3"].map(async (id) => (await stored(orgId, id)).id));
    const t = await threadOf(orgId, "ops");
    await db.insert(chunks).values([
      { orgId, threadId: t.id, messageIds: [ids[0], ids[1]], startAt: at(0), endAt: at(10), text: "truck + salary" },
      { orgId, threadId: t.id, messageIds: [ids[2]], startAt: at(20), endAt: at(20), text: "unloaded" },
    ]);

    // A sync that hit its page cap (or failed part-way) vouches for nothing: the second message is simply not in it.
    const capped = await writeBatch(db, orgId, slackBatch({ threads: [thread()], messages: [all[0]] }), "incremental");
    expect(capped.revoked.messages).toBe(0);
    expect((await sees(chitra)).messages).toHaveLength(3);
    // Nor does a stretch that doesn't cover it.
    await writeBatch(db, orgId, slackBatch({ threads: [thread({ complete: { from: at(15), to: at(30) } })], messages: [all[2]] }), "incremental");
    expect((await sees(chitra)).messages).toHaveLength(3);

    // Read to the end from before the first message until now, and the second one is gone.
    const whole = await writeBatch(db, orgId, slackBatch({ threads: [thread({ complete: { from: at(-5), to: at(30) } })], messages: [all[0], all[2]] }), "incremental");
    expect(whole.revoked.messages).toBe(1);
    const left = await sees(chitra);
    expect(left.messages).toEqual(["Truck left at 9", "Unloaded by noon"]);
    // The chunk that quoted it is dropped (the first message is chunked again on the next run); the other stays.
    expect(left.chunks).toEqual(["unloaded"]);
    expect((await stored(orgId, "ops:2")).deletedAt).not.toBeNull();

    // An old export uploaded later doesn't bring it back; the live source sending it again does.
    await writeBatch(db, orgId, slackBatch({ threads: [thread()], messages: all }), "upload");
    expect((await sees(chitra)).messages).toHaveLength(2);
    await writeBatch(db, orgId, slackBatch({ threads: [thread()], messages: all }), "incremental");
    expect((await sees(chitra)).messages).toHaveLength(3);
  });

  it("is retired when the source names it, and replies under an older message are left alone", async () => {
    const { orgId, chitra } = await company();
    const old = said("ops", "0", -600, "Weekly dispatch thread");
    const reply = said("ops", "r", 5, "Gate pass issued", { replyToExternalId: "ops:0" });
    const child = said("ops", "c", 12, "Which sheet?", { replyToExternalId: "ops:2" });
    await writeBatch(db, orgId, slackBatch({ threads: [thread()], messages: [old, reply, child, ...all] }), "backfill");

    // Slack reads replies parent by parent: the reply under the old message wasn't read, so it isn't missing.
    const window = { from: at(-5), to: at(30), repliesUnderParentsOnly: true };
    const result = await writeBatch(db, orgId, slackBatch({ threads: [thread({ complete: window })], messages: [all[0], all[1], all[2]] }), "incremental");
    expect(result.revoked.messages).toBe(1);
    expect((await sees(chitra)).messages).toEqual(["Weekly dispatch thread", "Truck left at 9", "Gate pass issued", "Salary sheet attached, oops", "Unloaded by noon"]);

    // Teams and Gmail name what was deleted; a Slack tombstone arrives flagged.
    const named = await writeBatch(db, orgId, slackBatch({ deletedMessageIds: ["ops:2", "ops:unknown"], threads: [thread()], messages: [{ ...all[2], deleted: true }] }), "incremental");
    expect(named.revoked.messages).toBe(2);
    expect((await sees(chitra)).messages).toEqual(["Weekly dispatch thread", "Truck left at 9", "Gate pass issued"]);
  });
});

describe("copies that outlive access", () => {
  it("purges tracker rows and procedure evidence from messages their owner can no longer open", async () => {
    const { orgId, asha, ben } = await company();
    const deals = channel("deals", { memberKeys: ["slack:UA", "slack:UB"], membersComplete: true });
    const general = channel("general", { visibility: "org" });
    const batch = { threads: [deals, general], messages: [said("deals", "1", 0, "Sold 12 tonnes to Tata at 42"), said("general", "1", 1, "Sold 3 tonnes to Jindal"), said("general", "2", 2, "Sold 1 tonne, wrong chat")] };
    await writeBatch(db, orgId, slackBatch(batch), "backfill");
    const [secret, open, mistake] = await Promise.all(["deals:1", "general:1", "general:2"].map((id) => stored(orgId, id)));

    const log = async (owner: Viewer) => {
      const [tracker] = await db.insert(trackers).values({ orgId, personId: owner.personId, name: "Sales log", description: "Every sale", columns: [{ name: "Customer", type: "text" }] }).returning();
      const sales = [
        { from: secret, customer: "Tata" },
        { from: open, customer: "Jindal" },
        { from: mistake, customer: "Wrong chat" },
      ];
      await db.insert(trackerRows).values(sales.map((s) => ({ orgId, trackerId: tracker.id, personId: owner.personId, values: { Customer: s.customer }, messageId: s.from.id, at: s.from.sentAt })));
      await db.insert(procedures).values([
        { orgId, personId: owner.personId, title: "Logging a sale", summary: "s", steps: ["post it"], frequency: "daily", judgment: "low", automationScore: 80, messageIds: [secret.id, open.id] },
        { orgId, personId: owner.personId, title: "Quoting Tata", summary: "s", steps: ["ask Asha"], frequency: "weekly", judgment: "high", automationScore: 20, messageIds: [secret.id] },
      ]);
    };
    await log(asha);
    await log(ben);
    const rowsOf = async (v: Viewer) => (await db.select({ values: trackerRows.values }).from(trackerRows).where(eq(trackerRows.personId, v.personId))).map((r) => r.values.Customer).sort();
    const proceduresOf = async (v: Viewer) => (await db.select().from(procedures).where(eq(procedures.personId, v.personId))).map((p) => [p.title, p.messageIds.length]).sort();

    // Nothing was revoked yet, so nothing is purged.
    expect(await purgeRevoked(db, orgId)).toEqual({ trackerRows: 0, procedures: 0 });

    // Ben is taken out of #deals, and the mistaken message is deleted in Slack.
    const result = await writeBatch(db, orgId, slackBatch({ threads: [{ ...deals, memberKeys: ["slack:UA"] }, general], deletedMessageIds: ["general:2"] }), "incremental");
    expect(result.revoked).toEqual({ members: 1, threads: 0, messages: 1 });
    expect(await purgeRevoked(db, orgId)).toEqual({ trackerRows: 3, procedures: 1 });

    expect(await rowsOf(ben)).toEqual(["Jindal"]);
    expect(await proceduresOf(ben)).toEqual([["Logging a sale", 1]]);
    // Asha is still in #deals: she only loses the row from the deleted message.
    expect(await rowsOf(asha)).toEqual(["Jindal", "Tata"]);
    expect(await proceduresOf(asha)).toEqual([
      ["Logging a sale", 2],
      ["Quoting Tata", 1],
    ]);
  });

  it("go with a disconnected source, and what also rests on other sources is narrowed to them", async () => {
    const { orgId, asha, chitra } = await company();
    const slack = await writeBatch(db, orgId, slackBatch({ threads: [channel("general", { visibility: "org" })], messages: [said("general", "1", 0, "Contract sent to Tata")] }), "backfill");
    const dm: NormalizedBatch = {
      connection: { provider: "upload:whatsapp", scope: "personal", externalAccountId: "asha" },
      people: PEOPLE,
      threads: [{ externalId: "wa:tata", kind: "whatsapp", title: "Tata", visibility: "members", memberKeys: ["slack:UA"] }],
      messages: [{ threadExternalId: "wa:tata", externalId: "wa:1", kind: "chat", authorKey: "slack:UA", sentAt: at(-60), text: "I'll send the contract today" }],
    };
    await writeBatch(db, orgId, dm, "upload", asha.personId);
    const [pub, priv] = await Promise.all([stored(orgId, "general:1"), stored(orgId, "wa:1")]);

    // A promise made privately and closed by a public message; a fact said in both; an insight, a tracker row and procedures.
    const [promise] = await db
      .insert(commitments)
      .values({ orgId, ownerPersonId: asha.personId, title: "Send Tata the contract", quote: priv.text, confidence: 0.9, sourceMessageId: priv.id, evidenceMessageIds: [pub.id], status: "done", fulfilledByMessageId: pub.id, acl: unionAcl(priv.acl, pub.acl, [`p:${asha.personId}`]) })
      .returning();
    await db.insert(commitmentEvents).values({ orgId, commitmentId: promise.id, type: "status_changed", toStatus: "done", messageId: pub.id, actor: "system", detail: { quote: pub.text, confidence: 0.9 } });
    const [x, y] = await db
      .insert(entities)
      .values([
        { orgId, type: "company", name: "Tata", acl: ["org"] },
        { orgId, type: "deal", name: "Contract", acl: ["org"] },
      ])
      .returning();
    await db.insert(edges).values([
      { orgId, sourceEntityId: x.id, targetEntityId: y.id, relation: "signed", fact: "said in both", sourceMessageIds: [pub.id, priv.id], acl: unionAcl(pub.acl, priv.acl) },
      { orgId, sourceEntityId: x.id, targetEntityId: y.id, relation: "sent", fact: "only in slack", sourceMessageIds: [pub.id], acl: pub.acl },
    ]);
    await db.insert(insights).values([
      { orgId, kind: "waiting_on_us", key: "k1", title: "only in slack", detail: "d", evidenceMessageIds: [pub.id], acl: pub.acl },
      { orgId, kind: "waiting_on_us", key: "k2", title: "in both", detail: "d", evidenceMessageIds: [pub.id, priv.id], acl: unionAcl(pub.acl, priv.acl) },
    ]);
    const [tracker] = await db.insert(trackers).values({ orgId, personId: asha.personId, name: "Contracts", description: "d", columns: [{ name: "Customer", type: "text" }] }).returning();
    await db.insert(trackerRows).values([
      { orgId, trackerId: tracker.id, personId: asha.personId, values: { Customer: "from slack" }, messageId: pub.id, at: pub.sentAt },
      { orgId, trackerId: tracker.id, personId: asha.personId, values: { Customer: "from whatsapp" }, messageId: priv.id, at: priv.sentAt },
    ]);
    await db.insert(procedures).values([
      { orgId, personId: asha.personId, title: "From both", summary: "s", steps: ["x"], frequency: "daily", judgment: "low", automationScore: 80, messageIds: [pub.id, priv.id] },
      { orgId, personId: asha.personId, title: "Only slack", summary: "s", steps: ["x"], frequency: "daily", judgment: "low", automationScore: 80, messageIds: [pub.id] },
    ]);
    expect((await sees(chitra)).promises).toEqual(["Send Tata the contract"]);

    const result = await forgetConnection(db, orgId, slack.connectionId);
    expect(result).toMatchObject({ messages: 1, facts: 1, insights: 1, trackerRows: 1, procedures: 1 });

    // Chitra saw these only because Slack had shown them to everyone; what is left is private to Asha.
    const outside = await sees(chitra);
    expect([outside.promises, outside.facts, outside.insights, outside.entities]).toEqual([[], [], [], []]);
    const owner = await sees(asha);
    expect([owner.promises, owner.facts, owner.insights, owner.entities]).toEqual([["Send Tata the contract"], ["said in both"], ["in both"], ["Contract", "Tata"]]);
    expect((await db.select().from(commitments).where(eq(commitments.id, promise.id)))[0]).toMatchObject({ evidenceMessageIds: [], fulfilledByMessageId: null });
    // The promise's history no longer quotes the forgotten message.
    expect((await db.select().from(commitmentEvents).where(eq(commitmentEvents.commitmentId, promise.id)))[0].detail).toEqual({ confidence: 0.9 });
    expect((await db.select({ values: trackerRows.values }).from(trackerRows).where(eq(trackerRows.orgId, orgId))).map((r) => r.values.Customer)).toEqual(["from whatsapp"]);
    expect((await db.select().from(procedures).where(eq(procedures.orgId, orgId))).map((p) => [p.title, p.messageIds])).toEqual([["From both", [priv.id]]]);
  });
});

describe("people who left", () => {
  it("are flagged for an admin when a source closes their account, and never removed automatically", async () => {
    const { orgId, ben } = await company();
    await writeBatch(db, orgId, slackBatch({}), "backfill");
    expect(await departedMembers(db, orgId)).toEqual([]);

    const left = PEOPLE.map((p) => ({ ...p, deactivated: p.key === "slack:UB" }));
    await writeBatch(db, orgId, slackBatch({ people: left }), "incremental");
    const departed = await departedMembers(db, orgId);
    expect(departed).toMatchObject([{ personId: ben.personId, displayName: "Ben", sources: [{ provider: "slack" }] }]);
    const since = departed[0].sources[0].since;
    // Still a member who can sign in: that is the admin's call.
    expect((await db.select().from(people).where(eq(people.id, ben.personId)))[0]).toMatchObject({ isMember: true, deactivatedAt: null });

    // A source that says nothing about accounts changes nothing, and the date isn't moved by later syncs.
    await writeBatch(db, orgId, slackBatch({}), "incremental");
    await writeBatch(db, orgId, slackBatch({ people: left }), "incremental");
    expect((await departedMembers(db, orgId))[0].sources[0].since).toEqual(since);

    // Once an admin deactivates them in ALRO they drop off the list; a reactivated Slack account clears the flag.
    await db.update(people).set({ deactivatedAt: new Date() }).where(eq(people.id, ben.personId));
    expect(await departedMembers(db, orgId)).toEqual([]);
    await db.update(people).set({ deactivatedAt: null }).where(eq(people.id, ben.personId));
    await writeBatch(db, orgId, slackBatch({ people: PEOPLE.map((p) => ({ ...p, deactivated: false })) }), "incremental");
    expect(await departedMembers(db, orgId)).toEqual([]);
    expect((await db.select().from(identities).where(and(eq(identities.orgId, orgId), eq(identities.externalId, "UB"))))[0].deactivatedAt).toBeNull();
  });
});

describe("a Slack sync, end to end", () => {
  const ts = (minutes: number) => (at(minutes).getTime() / 1000).toFixed(6);

  it("takes away a removed member's access, a deleted message and the copies made from them", async () => {
    const { orgId, asha, ben } = await company();
    const [c] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", externalAccountId: "T1" }).returning();
    await saveSecret(db, orgId, "connection", c.id, { kind: "token", values: { token: "xoxb-test" } } satisfies StoredCredential);

    // The workspace as Slack would answer for it; the test changes it between syncs.
    const workspace = {
      users: [
        { id: "UA", name: "asha", real_name: "Asha", deleted: false },
        { id: "UB", name: "ben", real_name: "Ben", deleted: false },
        { id: "UBOT", name: "alro", real_name: "ALRO", is_bot: true, deleted: false },
      ],
      members: ["UA", "UB", "UBOT"],
      history: [
        { type: "message", user: "UA", text: "Tata will pay 42 a kilo", ts: ts(0) },
        { type: "message", user: "UB", text: "Pasted the wrong price list", ts: ts(5) },
      ],
    };
    const answers: Record<string, (q: URLSearchParams) => unknown> = {
      "auth.test": () => ({ ok: true, team_id: "T1", url: "https://metals.slack.com/" }),
      "users.list": () => ({ ok: true, members: workspace.users }),
      "conversations.list": () => ({ ok: true, channels: [{ id: "G1", name: "deals", is_channel: true, is_private: true }] }),
      "conversations.history": (q) => ({ ok: true, messages: workspace.history.filter((m) => Number(m.ts) > Number(q.get("oldest"))) }),
      "conversations.members": () => ({ ok: true, members: workspace.members }),
    };
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify(answers[url.pathname.replace("/api/", "")]?.(url.searchParams) ?? { ok: false, error: "unknown_method" }));
    });
    const now = at(60);
    const connection = async () => (await db.select().from(connections).where(eq(connections.id, c.id)))[0];

    const first = await syncConnection(db, await connection(), now);
    expect(first).toMatchObject({ messages: 2, revoked: 0 });
    expect((await sees(ben)).messages).toEqual(["Tata will pay 42 a kilo", "Pasted the wrong price list"]);
    // Ben's sales log copied a row out of the channel.
    const [m] = await db.select().from(messages).where(and(eq(messages.orgId, orgId), eq(messages.text, "Tata will pay 42 a kilo")));
    const [tracker] = await db.insert(trackers).values({ orgId, personId: ben.personId, name: "Prices", description: "d", columns: [{ name: "Price", type: "number" }] }).returning();
    await db.insert(trackerRows).values({ orgId, trackerId: tracker.id, personId: ben.personId, values: { Price: 42 }, messageId: m.id, at: m.sentAt });

    // Nothing changed in Slack: nothing is taken away, and the quiet channel is still checked.
    expect(await syncConnection(db, await connection(), at(75))).toMatchObject({ messages: 0, revoked: 0 });

    // Ben is removed from the channel and his account closed; the second message is deleted.
    workspace.members = ["UA", "UBOT"];
    workspace.users[1].deleted = true;
    workspace.history.pop();
    const second = await syncConnection(db, await connection(), at(90));
    expect(second).toMatchObject({ messages: 0, revoked: 2 });
    expect((await sees(ben)).messages).toEqual([]);
    expect((await sees(asha)).messages).toEqual(["Tata will pay 42 a kilo"]);
    expect(await db.$count(trackerRows, eq(trackerRows.trackerId, tracker.id))).toBe(0);
    expect((await departedMembers(db, orgId)).map((d) => d.displayName)).toEqual(["Ben"]);
  });
});
