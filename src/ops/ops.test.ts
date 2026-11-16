import { MockLanguageModelV4 } from "ai/test";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promptText, scriptedModel, testModels } from "@/ai/test-models";
import { httpApi, outcomeUnknown, ProviderError, withRetries } from "@/connectors/api";
import type { Db } from "@/db/client";
import { approvals, channelLinks, channelMessages, chunks, commitmentEvents, commitments, connections, deadLetters, edges, jobRuns, meetingNotes, messages, notifications, orgs, people, pipelineLeases, routineRuns, routines, threadMembers, threads, trackerRows, webhookEvents } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { Extraction } from "@/pipeline/extract";
import { runPipeline } from "@/pipeline/run";
import { createTracker } from "@/work/trackers";
import { deliverOrQueue, queueFailedRoutines, retryHandlers } from "./handlers";
import { ALERT_AFTER, runForEachOrg, runJob, tidyJobRuns } from "./jobs";
import { logLine } from "./log";
import { embedMissing } from "./repair";
import { BACKOFF_MS, deadLetter, GiveUp, retryDue, retryNow, type RetryHandlers } from "./retry";
import { syncAndWatch } from "./sources";
import { processWebhook, pruneWebhooks, storeWebhook, sweepStuckWebhooks, type WebhookDeps } from "./webhooks";

const T0 = new Date("2026-11-05T04:00:00Z");
const MIN = 60_000;
const later = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

let db: Db;
let close: () => Promise<void>;
let orgA: string;
let orgB: string;
let owner: string;
let member: string;

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgA }, { id: orgB }] = await db
    .insert(orgs)
    .values([
      { name: "Metals Co", timezone: "Asia/Kolkata" },
      { name: "Other Co", timezone: "UTC" },
    ])
    .returning();
  [{ id: owner }, { id: member }] = await db
    .insert(people)
    .values([
      { orgId: orgA, displayName: "Olga Owner", isMember: true, role: "owner", primaryEmail: "olga@example.com" },
      { orgId: orgA, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com" },
    ])
    .returning();
  await db.insert(channelLinks).values({ orgId: orgA, personId: member, channel: "telegram", externalUserId: "555" });
}, 60_000);

afterAll(() => close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Counts what is posted to the alert webhook. */
function alertWebhook() {
  vi.stubEnv("ALRO_ALERT_WEBHOOK_URL", "https://hooks.example.com/alerts");
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)).text);
    return new Response("ok");
  });
  return posts;
}
const alertNotes = (key: string) => db.select().from(notifications).where(eq(notifications.kind, `alert:${key}`));

describe("job history", () => {
  it("records every run, and one company's failure doesn't stop the others", async () => {
    const results = await runForEachOrg(db, "demo", async (org) => {
      if (org.id === orgA) throw new Error("A is broken");
      return { done: 3 };
    });
    // A comes first and fails; B still runs.
    expect(results[orgA]).toEqual({ error: "A is broken" });
    expect(results[orgB]).toEqual({ done: 3 });
    const rows = await db.select().from(jobRuns).where(eq(jobRuns.job, "demo"));
    expect(rows.find((r) => r.orgId === orgA)).toMatchObject({ status: "error", error: "A is broken" });
    expect(rows.find((r) => r.orgId === orgB)).toMatchObject({ status: "ok", stats: { done: 3 }, error: null });
    expect(rows.every((r) => r.finishedAt && r.finishedAt >= r.startedAt)).toBe(true);
  });

  it("tells the admins once when a job keeps failing, and again only after it has recovered", async () => {
    const posts = alertWebhook();
    const fail = (minute: number) => runJob(db, { job: "flaky", orgId: orgA, now: later(minute) }, async () => Promise.reject(new Error("provider down")));
    for (let i = 0; i < ALERT_AFTER - 1; i++) await fail(i);
    expect(posts).toHaveLength(0);
    await fail(10);
    expect(posts).toEqual([expect.stringContaining("[Metals Co] The flaky job has failed 3 times in a row")]);
    // Only admins get the in-app note.
    expect((await alertNotes("job:flaky")).map((n) => n.personId)).toEqual([owner]);
    await fail(11);
    await fail(12);
    expect(posts).toHaveLength(1);

    expect(await runJob(db, { job: "flaky", orgId: orgA, now: later(20) }, async () => "fine")).toEqual({ ok: true, result: "fine" });
    expect(await alertNotes("job:flaky")).toHaveLength(0);
    for (let i = 0; i < ALERT_AFTER; i++) await fail(30 + i);
    expect(posts).toHaveLength(2);
    // Another company's failures are counted on their own.
    await runJob(db, { job: "flaky", orgId: orgB, now: later(40) }, async () => Promise.reject(new Error("x")));
    expect(posts).toHaveLength(2);
  });

  it("closes runs that died and forgets history after two weeks", async () => {
    await db.insert(jobRuns).values([
      { job: "old", orgId: orgA, status: "ok", startedAt: new Date(T0.getTime() - 15 * 24 * 60 * MIN) },
      { job: "died", orgId: orgA, status: "running", startedAt: new Date(T0.getTime() - 30 * MIN) },
      { job: "busy", orgId: orgA, status: "running", startedAt: new Date(T0.getTime() - 2 * MIN) },
    ]);
    expect(await tidyJobRuns(db, T0)).toMatchObject({ closed: 1, pruned: 1 });
    const left = await db.select().from(jobRuns).where(inArray(jobRuns.job, ["old", "died", "busy"]));
    expect(left.map((r) => [r.job, r.status]).sort()).toEqual([
      ["busy", "running"],
      ["died", "error"],
    ]);
  });
});

describe("a source that stops working", () => {
  it("is reported once when it breaks, and again only after it has worked in between", async () => {
    const posts = alertWebhook();
    const [c] = await db.insert(connections).values({ orgId: orgA, provider: "slack", scope: "org", label: "Metals workspace" }).returning();
    const syncLeaving = (status: "active" | "error") => syncAndWatch(db, orgA, async () => void (await db.update(connections).set({ status }).where(eq(connections.id, c.id))));
    await syncLeaving("active");
    expect(posts).toHaveLength(0);
    await syncLeaving("error");
    await syncLeaving("error");
    expect(posts).toEqual([expect.stringContaining("Slack (Metals workspace) stopped syncing")]);
    expect(await alertNotes(`source:${c.id}`)).toHaveLength(1);
    await syncLeaving("active");
    expect(await alertNotes(`source:${c.id}`)).toHaveLength(0);
    await syncLeaving("error");
    expect(posts).toHaveLength(2);
    await db.delete(connections).where(eq(connections.id, c.id));
  });
});

describe("failed work", () => {
  it("waits longer after each failure, then gives up and leaves it to a person", async () => {
    const posts = alertWebhook();
    const waits: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await deadLetter(db, { orgId: orgA, kind: "demo", ref: "r1", error: `failure ${i + 1}`, now: later(i) });
      waits.push(row.nextRetryAt ? row.nextRetryAt.getTime() - later(i).getTime() : null);
      expect(row.attempts).toBe(i + 1);
    }
    expect(waits).toEqual([5 * MIN, 30 * MIN, 120 * MIN, 720 * MIN, null]);
    expect(BACKOFF_MS).toHaveLength(4);
    expect(posts).toEqual([expect.stringContaining("failed 5 times and has been given up on")]);

    // Nothing retries it automatically any more, however long we wait.
    const calls: boolean[] = [];
    const handlers: RetryHandlers = { demo: async (_l, ctx) => void calls.push(ctx.manual) };
    expect(await retryDue(db, handlers, later(100_000))).toMatchObject({ retried: 0 });
    // Another failure report doesn't alert again.
    await deadLetter(db, { orgId: orgA, kind: "demo", ref: "r1", error: "again", now: later(6) });
    expect(posts).toHaveLength(1);

    // Another company's admin can't touch it; this one's can, and it resolves when it works.
    const [letter] = await db.select().from(deadLetters).where(eq(deadLetters.ref, "r1"));
    await expect(retryNow(db, orgB, letter.id, handlers)).rejects.toThrow("already retried or cleared");
    expect(await retryNow(db, orgA, letter.id, handlers, later(7))).toEqual({ ok: true });
    expect(calls).toEqual([true]);
    const [after] = await db.select().from(deadLetters).where(eq(deadLetters.ref, "r1"));
    expect(after.resolvedAt).not.toBeNull();
    expect(await alertNotes("retry:demo:r1")).toHaveLength(0);
  });

  it("retries what has come due, once, and stops at once when retrying can't help", async () => {
    let works = false;
    const seen: string[] = [];
    const handlers: RetryHandlers = {
      demo: async (l) => {
        seen.push(l.ref);
        if (l.ref === "hopeless") throw new GiveUp("no point");
        if (!works) throw new Error("still down");
      },
    };
    await deadLetter(db, { orgId: orgA, kind: "demo", ref: "r2", error: "down", now: T0 });
    await deadLetter(db, { orgId: orgA, kind: "demo", ref: "hopeless", error: "down", now: T0 });
    expect(await retryDue(db, handlers, later(1))).toMatchObject({ retried: 0 });
    expect(await retryDue(db, handlers, later(6))).toEqual({ retried: 2, resolved: 0, failed: 2 });
    const rows = await db.select().from(deadLetters).where(inArray(deadLetters.ref, ["r2", "hopeless"]));
    expect(rows.find((r) => r.ref === "r2")).toMatchObject({ attempts: 2, error: "still down", nextRetryAt: later(36) });
    expect(rows.find((r) => r.ref === "hopeless")).toMatchObject({ nextRetryAt: null, resolvedAt: null, error: "no point" });

    works = true;
    expect(await retryDue(db, handlers, later(37))).toEqual({ retried: 1, resolved: 1, failed: 0 });
    expect(await retryDue(db, handlers, later(10_000))).toMatchObject({ retried: 0 });
    expect(seen).toEqual(["r2", "hopeless", "r2"]);
  });
});

describe("messages to the bot", () => {
  const sent: string[] = [];
  let modelDown = false;
  const answer = scriptedModel(() => {
    if (modelDown) throw new Error("model is down");
    return "You owe Jash the deck.";
  });
  const models = testModels({ answer });
  const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
    models,
    transcribe: async () => "",
    readFile: async () => "A weighment slip: net 12,000 kg",
    send: async (_channel, _to, text) => void sent.push(text),
    media: async () => new Uint8Array([1]),
    now: T0,
    ...over,
  });
  const eventOf = async (id: string) => (await db.select().from(webhookEvents).where(eq(webhookEvents.id, id)))[0];
  const letterOf = async (id: string) => (await db.select().from(deadLetters).where(and(eq(deadLetters.kind, "webhook"), eq(deadLetters.ref, id))))[0];

  it("stores an event once: a redelivery is acknowledged and ignored", async () => {
    const event = await storeWebhook(db, "telegram", "555:10", { from: "555", text: "what do I owe Jash?" }, T0);
    expect(event).toMatchObject({ status: "received", attempts: 0 });
    expect(await storeWebhook(db, "telegram", "555:10", { from: "555", text: "what do I owe Jash?" }, T0)).toBeUndefined();
    // The same id in another app is a different event.
    expect(await storeWebhook(db, "slack", "555:10", { from: "U1", text: "hi" }, T0)).toBeDefined();

    expect(await processWebhook(db, event!, deps())).toBe("answered");
    expect(sent).toEqual(["You owe Jash the deck."]);
    // Handled: the text is no longer kept on the event.
    expect(await eventOf(event!.id)).toMatchObject({ status: "done", attempts: 1, payload: {} });
  });

  it("replays a failed event once, and answers it once", async () => {
    sent.length = 0;
    modelDown = true;
    const event = (await storeWebhook(db, "telegram", "555:11", { from: "555", text: "and what does Jash owe me?" }, T0))!;
    expect(await processWebhook(db, event, deps())).toBe("error");
    expect(await eventOf(event.id)).toMatchObject({ status: "failed", attempts: 1, error: "model is down" });
    expect(await letterOf(event.id)).toMatchObject({ orgId: orgA, attempts: 1, nextRetryAt: later(5), payload: { channel: "telegram" } });
    expect(sent).toEqual([expect.stringContaining("I'll try again in a few minutes")]);

    const handlers = retryHandlers(db, models, deps());
    // Still down at the first retry: it stays queued, with a longer wait.
    expect(await retryDue(db, handlers, later(6))).toMatchObject({ retried: 1, failed: 1 });
    expect(sent).toHaveLength(1);
    modelDown = false;
    expect(await retryDue(db, handlers, later(40))).toMatchObject({ retried: 1, resolved: 1 });
    expect(sent.at(-1)).toBe("You owe Jash the deck.");
    expect(await eventOf(event.id)).toMatchObject({ status: "done", payload: {} });
    expect((await letterOf(event.id)).resolvedAt).not.toBeNull();

    // Nothing left to replay, and the question was recorded and answered exactly once.
    expect(await retryDue(db, handlers, later(10_000))).toMatchObject({ retried: 0 });
    const turns = await db.select().from(channelMessages).where(and(eq(channelMessages.personId, member), like(channelMessages.text, "%Jash owe me%")));
    expect(turns).toHaveLength(1);
    expect(sent.filter((s) => s === "You owe Jash the deck.")).toHaveLength(1);
  });

  it("asks once for a file whose link has expired, instead of trying forever", async () => {
    sent.length = 0;
    const gone = deps({ media: async () => Promise.reject(new Error("410 Gone")) });
    const event = (await storeWebhook(db, "telegram", "555:12", { from: "555", file: { ref: "file-9", mediaType: "image/jpeg" } }, T0))!;
    expect(await processWebhook(db, event, gone)).toBe("error");
    expect(await retryDue(db, retryHandlers(db, models, gone), later(6))).toMatchObject({ retried: 1, resolved: 1 });
    expect(sent.filter((s) => s.includes("link has expired"))).toHaveLength(1);
    expect(await eventOf(event.id)).toMatchObject({ status: "failed" });
    expect(await retryDue(db, retryHandlers(db, models, gone), later(10_000))).toMatchObject({ retried: 0 });
  });

  it("doesn't run the agent again when the first attempt had already put something under Approvals", async () => {
    sent.length = 0;
    modelDown = true;
    const event = (await storeWebhook(db, "telegram", "555:13", { from: "555", text: "email Priya the quote" }, T0))!;
    await processWebhook(db, event, deps());
    await db.insert(approvals).values({ orgId: orgA, personId: member, tool: "gmail_send_email", input: {}, summary: "Email to priya@acme.com", audience: "external", origin: "messaging", code: "W1ZZ", createdAt: later(1) });
    modelDown = false;
    expect(await retryDue(db, retryHandlers(db, models, deps()), later(6))).toMatchObject({ retried: 1, resolved: 1 });
    expect(sent.at(-1)).toContain("check Approvals");
    expect(sent).not.toContain("You owe Jash the deck.");
    await db.delete(approvals).where(eq(approvals.code, "W1ZZ"));
  });

  it("queues events the server dropped mid-way, and deletes handled ones after a week", async () => {
    const dropped = (await storeWebhook(db, "telegram", "555:14", { from: "555", text: "hello?" }, new Date(T0.getTime() - 20 * MIN)))!;
    const fresh = (await storeWebhook(db, "telegram", "555:15", { from: "555", text: "just now" }, T0))!;
    expect(await sweepStuckWebhooks(db, T0)).toBe(1);
    expect(await eventOf(dropped.id)).toMatchObject({ status: "failed" });
    expect(await letterOf(dropped.id)).toMatchObject({ attempts: 1 });
    expect(await eventOf(fresh.id)).toMatchObject({ status: "received" });

    const before = await db.$count(webhookEvents, eq(webhookEvents.status, "done"));
    expect(before).toBeGreaterThan(0);
    expect(await pruneWebhooks(db, later(6 * 24 * 60))).toBe(0);
    expect(await pruneWebhooks(db, later(8 * 24 * 60))).toBe(before);
    expect(await eventOf(dropped.id)).toBeDefined();
    await db.delete(deadLetters).where(eq(deadLetters.kind, "webhook"));
  });
});

describe("scheduled tasks that failed", () => {
  it("runs one again only if it hadn't proposed or done anything, and never a watch", async () => {
    const task = (title: string, schedule: (typeof routines.$inferInsert)["schedule"] = { kind: "daily", time: "10:00" }) =>
      db.insert(routines).values({ orgId: orgA, ownerPersonId: member, title, instruction: "do it", schedule }).returning().then((r) => r[0]);
    const failed = (routineId: string, error: string) => db.insert(routineRuns).values({ orgId: orgA, routineId, personId: member, status: "error", error, startedAt: T0, finishedAt: T0 });
    const [clean, acted, broken, watch] = [await task("Clean"), await task("Acted"), await task("Broken"), await task("Watch", { kind: "every", minutes: 15 })];
    await failed(clean.id, "fetch failed");
    await failed(acted.id, "fetch failed");
    await failed(broken.id, "The owner is no longer a member");
    await failed(watch.id, "fetch failed");
    // "Acted" had queued an email before it fell over.
    await db.insert(approvals).values({ orgId: orgA, personId: member, tool: "gmail_send_email", input: {}, summary: "Chaser", audience: "external", origin: "routine", routineId: acted.id, code: "R1ZZ", createdAt: later(1) });

    expect(await queueFailedRoutines(db, orgA, T0, T0)).toEqual({ queued: 1, leftForAPerson: 2 });
    const letters = await db.select().from(deadLetters).where(eq(deadLetters.kind, "routine"));
    expect(letters.find((l) => l.ref === clean.id)).toMatchObject({ nextRetryAt: later(5) });
    expect(letters.find((l) => l.ref === acted.id)).toMatchObject({ nextRetryAt: null, error: expect.stringContaining("already proposed or done something") });
    expect(letters.find((l) => l.ref === broken.id)).toMatchObject({ nextRetryAt: null, error: expect.stringContaining("doesn't look temporary") });
    expect(letters.find((l) => l.ref === watch.id)).toBeUndefined();

    const models = testModels({ answer: scriptedModel(() => "All chased.") });
    const handlers = retryHandlers(db, models, {} as WebhookDeps);
    expect(await retryDue(db, handlers, later(6))).toEqual({ retried: 1, resolved: 1, failed: 0 });
    const runs = await db.select().from(routineRuns).where(inArray(routineRuns.routineId, [clean.id, acted.id, broken.id]));
    expect(runs.filter((r) => r.routineId === clean.id).map((r) => r.status).sort()).toEqual(["error", "ok"]);
    expect(runs.filter((r) => r.routineId !== clean.id)).toHaveLength(2);
    await db.delete(approvals).where(eq(approvals.code, "R1ZZ"));
  });

  it("gives up after two re-runs", async () => {
    const [r] = await db.insert(routines).values({ orgId: orgA, ownerPersonId: member, title: "Unlucky", instruction: "do it", schedule: { kind: "daily", time: "10:00" } }).returning();
    const waits = [];
    for (let i = 0; i < 3; i++) waits.push((await deadLetter(db, { orgId: orgA, kind: "routine", ref: r.id, error: "fetch failed", now: later(i) })).nextRetryAt);
    expect(waits).toEqual([later(5), later(31), null]);
  });
});

describe("reminders that couldn't be delivered", () => {
  it("are queued and sent on a later try", async () => {
    const [c] = await db.insert(connections).values({ orgId: orgA, provider: "upload:whatsapp", scope: "personal", ownerPersonId: member }).returning();
    const [t] = await db.insert(threads).values({ orgId: orgA, connectionId: c.id, kind: "whatsapp", externalId: "wa:r", title: "Dispatch", visibility: "members" }).returning();
    const [m] = await db.insert(messages).values({ orgId: orgA, threadId: t.id, connectionId: c.id, externalId: "r1", kind: "chat", authorPersonId: member, sentAt: T0, text: "I'll send the deck by Friday" }).returning();
    const [promise] = await db.insert(commitments).values({ orgId: orgA, title: "Send the deck", ownerPersonId: member, status: "overdue", quote: "I'll send the deck", confidence: 0.9, sourceMessageId: m.id, extractor: "test" }).returning();
    const reminders = [{ personId: member, commitmentId: promise.id, kind: "overdue" }];
    await db.insert(notifications).values({ orgId: orgA, personId: member, commitmentId: promise.id, kind: "overdue", channel: "in_app" });

    vi.stubEnv("RESEND_API_KEY", "re_test");
    let up = false;
    const mails: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (!up) return new Response("down", { status: 503 });
      mails.push(JSON.parse(String(init.body)).subject);
      return Response.json({ id: "e1" });
    });
    expect(await deliverOrQueue(db, orgA, reminders, T0)).toEqual({ emailed: 0, messaged: 0, failed: 1 });
    const [letter] = await db.select().from(deadLetters).where(eq(deadLetters.kind, "notify"));
    // Ids and kinds only: no text is kept.
    expect(letter).toMatchObject({ orgId: orgA, payload: { reminders }, nextRetryAt: later(5) });

    up = true;
    const handlers = retryHandlers(db, testModels(), {} as WebhookDeps);
    expect(await retryDue(db, handlers, later(6))).toEqual({ retried: 1, resolved: 1, failed: 0 });
    expect(mails).toEqual(["Overdue: Send the deck"]);
    expect(await retryDue(db, handlers, later(10_000))).toMatchObject({ retried: 0 });
  });
});

describe("a processing run that dies part-way", () => {
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
  const never = new Promise<never>(() => {});
  /** Which stage a call to the extraction model belongs to: they share one model. */
  const stageOf = (prompt: string) => (prompt.includes("You write the notes for a meeting") ? "notes" : prompt.includes("You keep a running table") ? "trackers" : "extract");
  const labelOf = (prompt: string, text: string) => prompt.match(new RegExp(`\\*(M\\d+) [^\\n]*${text}`))?.[1];

  let crash: { stage: string; call: number; reached: () => void } | undefined;
  let calls: Record<string, number> = {};

  function reply(stage: string, prompt: string): unknown {
    if (stage === "notes") return { summary: "They agreed the price.", decisions: ["52,000 a tonne"], actions: [], followUp: "" };
    if (stage === "trackers") {
      return { rows: [...prompt.matchAll(/^\[(\d+)\] .*?: Sold (\d+) tonnes to (Buyer\d+)/gm)].map(([, line, tonnes, buyer]) => ({ line: Number(line), values: { Buyer: buyer, Tonnes: Number(tonnes) } })) };
    }
    const out: Extraction = { commitments: [], updates: [], entities: [], facts: [] };
    const promise = (text: string, owner: string, title: string) => {
      const message = labelOf(prompt, text);
      if (message) out.commitments.push({ ref: `N${out.commitments.length + 1}`, message, quote: text, owner, counterparty: null, title, details: null, dueText: null, dueAt: null, dueKind: "none", confidence: 0.9 });
      return message;
    };
    const quote = promise("I'll send the revised quote by Friday", "Asha Rao", "Send the revised quote");
    if (quote) {
      out.entities.push({ name: "Tata Steel", type: "company", aliases: [] }, { name: "HR coil", type: "product", aliases: [] });
      out.facts.push({ source: "Tata Steel", relation: "buys", target: "HR coil", fact: "Tata Steel buys HR coil at 52,000 a tonne", message: quote, validFrom: null, invalidates: [] });
    }
    promise("I'll book the truck for Monday", "Ravi Shah", "Book the truck");
    return out;
  }

  /** Answers like the real model, except that at the chosen call it never answers: the process "died" there. */
  const extract = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const text = promptText(prompt);
      const stage = stageOf(text);
      calls[stage] = (calls[stage] ?? 0) + 1;
      if (crash?.stage === stage && crash.call === calls[stage]) {
        crash.reached();
        await never;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(reply(stage, text)) }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
    },
  });
  const screen = scriptedModel((prompt) => ({ flagged: [...prompt.matchAll(/^(\d+)\. .*?: (.*)$/gm)].filter(([, , text]) => text.includes("I'll")).map(([, n]) => Number(n)) }));
  const models = testModels({ screen, extract });

  /** A company with two promises in two chats, two meetings, and a sales chat long enough to be read in two batches. */
  async function company(name: string) {
    const [org] = await db.insert(orgs).values({ name, timezone: "Asia/Kolkata" }).returning();
    const [asha, ravi] = await db
      .insert(people)
      .values([
        { orgId: org.id, displayName: "Asha Rao", isMember: true },
        { orgId: org.id, displayName: "Ravi Shah", isMember: true },
      ])
      .returning();
    const [c] = await db.insert(connections).values({ orgId: org.id, provider: "slack", scope: "org" }).returning();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const thread = async (externalId: string, kind: "channel" | "meeting", said: { by: string; text: string; h: number }[]) => {
      const [t] = await db.insert(threads).values({ orgId: org.id, connectionId: c.id, kind, externalId, title: externalId, visibility: "members" }).returning();
      await db.insert(threadMembers).values([asha, ravi].map((p) => ({ orgId: org.id, threadId: t.id, personId: p.id })));
      await db.insert(messages).values(said.map((s, i) => ({ orgId: org.id, threadId: t.id, connectionId: c.id, externalId: `${externalId}:${i}`, kind: kind === "meeting" ? ("transcript" as const) : ("chat" as const), authorPersonId: s.by, sentAt: hoursAgo(s.h), text: s.text })));
    };
    await thread("quotes", "channel", [{ by: asha.id, h: 50, text: "I'll send the revised quote by Friday. Tata Steel buys HR coil at 52,000 a tonne." }]);
    await thread("trucks", "channel", [{ by: ravi.id, h: 20, text: "I'll book the truck for Monday" }]);
    const talk = "We went through the order book line by line and agreed the price stays where it is for this quarter, then looked at dispatch dates. ".repeat(3);
    await thread("call-1", "meeting", [{ by: asha.id, h: 12, text: talk }]);
    await thread("call-2", "meeting", [{ by: ravi.id, h: 11, text: talk }]);
    await thread(
      "sales",
      "channel",
      Array.from({ length: 16 }, (_, i) => ({ by: ravi.id, h: 10 - i * 0.1, text: `Sold ${i + 1} tonnes to Buyer${i + 1}. ${"Paperwork and gate pass are with the weighbridge. ".repeat(22)}` })),
    );
    await createTracker(db, { orgId: org.id, personId: asha.id }, { name: "Sales", description: "Each sale: who bought how much.", columns: [{ name: "Buyer", type: "text" }, { name: "Tonnes", type: "number" }] });
    return org.id;
  }

  /** Everything the pipeline derives, as "what → how many times". Exactly once means every count is 1. */
  async function derived(orgId: string) {
    const count = (keys: (string | null)[]) => keys.reduce<Record<string, number>>((n, k) => ({ ...n, [String(k)]: (n[String(k)] ?? 0) + 1 }), {});
    return {
      promises: count((await db.select({ k: commitments.quote }).from(commitments).where(eq(commitments.orgId, orgId))).map((r) => r.k)),
      created: (await db.select().from(commitmentEvents).where(and(eq(commitmentEvents.orgId, orgId), eq(commitmentEvents.type, "created")))).length,
      facts: count((await db.select({ k: edges.fact }).from(edges).where(eq(edges.orgId, orgId))).map((r) => r.k)),
      notes: count((await db.select({ k: meetingNotes.threadId }).from(meetingNotes).where(eq(meetingNotes.orgId, orgId))).map((r) => r.k)),
      trackerRows: count((await db.select({ k: trackerRows.messageId }).from(trackerRows).where(eq(trackerRows.orgId, orgId))).map((r) => r.k)),
      searchable: count((await db.select({ ids: chunks.messageIds }).from(chunks).where(eq(chunks.orgId, orgId))).flatMap((r) => r.ids)),
    };
  }

  it.each([
    { stage: "extract", call: 2, what: "after the first chat's promise and fact were saved" },
    { stage: "notes", call: 2, what: "after the first meeting's notes were saved" },
    { stage: "trackers", call: 2, what: "after the first batch of tracker rows was saved" },
  ])("in $stage ($what): the next run finishes the work and nothing is derived twice", async ({ stage, call }) => {
    const orgId = await company(`Crash in ${stage}`);
    calls = {};
    const reached = new Promise<void>((resolve) => (crash = { stage, call, reached: resolve }));
    void runPipeline(db, orgId, models);
    await reached;
    const partial = await derived(orgId);
    // The dead run's lease runs out by itself after 15 minutes; here, at once.
    await db.delete(pipelineLeases).where(eq(pipelineLeases.orgId, orgId));
    crash = undefined;

    await runPipeline(db, orgId, models);
    const done = await derived(orgId);
    expect(Object.keys(done.promises).sort()).toEqual(["I'll book the truck for Monday", "I'll send the revised quote by Friday"]);
    expect(done.created).toBe(2);
    expect(done.facts).toEqual({ "Tata Steel buys HR coil at 52,000 a tonne": 1 });
    expect(Object.keys(done.notes)).toHaveLength(2);
    expect(Object.keys(done.trackerRows)).toHaveLength(16);
    expect(Object.keys(done.searchable)).toHaveLength(20);
    for (const counts of [done.promises, done.notes, done.trackerRows, done.searchable]) expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    // The crash really did land part-way: some of this stage's work existed before the clean run.
    const key = stage === "extract" ? "promises" : stage === "notes" ? "notes" : "trackerRows";
    expect(Object.keys(partial[key as "promises"]).length).toBeGreaterThan(0);
    expect(Object.keys(partial[key as "promises"]).length).toBeLessThan(Object.keys(done[key as "promises"]).length);

    // And a third run finds nothing left to do.
    await runPipeline(db, orgId, models);
    expect(await derived(orgId)).toEqual(done);
  }, 60_000);

  it("embeds facts a dead run saved but never embedded", async () => {
    const orgId = await company("Embedding lost");
    crash = undefined;
    await runPipeline(db, orgId, models);
    await db.update(edges).set({ factEmbedding: null }).where(eq(edges.orgId, orgId));
    expect((await embedMissing(db, orgId, models)).facts).toBe(1);
    const [fact] = await db.select().from(edges).where(eq(edges.orgId, orgId));
    expect(fact.factEmbedding).not.toBeNull();
    expect(await embedMissing(db, orgId, models)).toEqual({ facts: 0, entities: 0 });
  }, 60_000);
});

describe("calls to other apps", () => {
  it("gives up on an app that doesn't answer and says the outcome is unknown", async () => {
    vi.stubGlobal("fetch", (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const api = httpApi({ baseUrl: "https://api.example.com/", headers: () => ({ authorization: "Bearer x" }), timeoutMs: 20 });
    const sending = await api("POST", "messages", { body: {} }).catch((e) => e);
    expect(sending).toBeInstanceOf(ProviderError);
    expect(sending).toMatchObject({ timeout: true, status: 0, message: expect.stringContaining("no answer") });
    expect(outcomeUnknown(sending)).toBe(true);
    // A read that timed out changed nothing; a refusal is a definite no.
    expect(outcomeUnknown(await api("GET", "messages", { timeoutMs: 5 }).catch((e) => e))).toBe(false);
    expect(outcomeUnknown(new ProviderError("POST x: 500", 500))).toBe(false);
    // The connection dropped after the request went out: unknown. The name never resolved: nothing was sent.
    expect(outcomeUnknown(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(outcomeUnknown(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(false);
  });

  it("waits as long as the app asks before retrying a read, up to a minute", async () => {
    const answers = [new Response("slow down", { status: 429, headers: { "retry-after": "7" } }), new Response("busy", { status: 503, headers: { "retry-after": "600" } }), new Response("oops", { status: 500 }), Response.json({ ok: true })];
    vi.stubGlobal("fetch", async () => answers.shift()!);
    const waits: number[] = [];
    const api = withRetries(httpApi({ baseUrl: "https://api.example.com/", headers: () => ({}) }), [1000, 4000, 16000], async (ms) => void waits.push(ms));
    expect(await api("GET", "things")).toEqual({ ok: true });
    expect(waits).toEqual([7000, 60_000, 16000]);
  });
});

describe("logs", () => {
  it("are one JSON line each, without credentials or anyone's words", () => {
    const line = JSON.parse(logLine("error", "sync.failed", { orgId: "o1", error: new Error("401 from Slack"), token: "xoxb-secret", body: "Hi Priya", count: 3 }, T0));
    expect(line).toEqual({ ts: "2026-11-05T04:00:00.000Z", level: "error", event: "sync.failed", orgId: "o1", error: "401 from Slack", token: "[left out]", body: "[left out]", count: 3 });
  });
});
