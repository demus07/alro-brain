import { generateKeyPairSync, createSign } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promptText, scriptedModel, testModels } from "@/ai/test-models";
import { decide, decideFromReply, pendingFor, proposalTools, retry } from "@/approvals/approvals";
import { handleInbound } from "@/channels/handle";
import { checkServiceUrl, verifyTeamsRequest } from "@/channels/teams-bot";
import { rfc822 } from "@/connectors/email-actions";
import type { StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, channelLinks, commitmentEvents, commitments, connections, messages, notifications, orgs, people, procedures, routineRuns, routines, teamAgents, threadMembers, threads, trackers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { saveSecret } from "@/lib/secrets";
import { buildBrief } from "@/notify/brief";
import { notePending } from "@/pipeline/meeting-notes";
import { runDueRoutines } from "@/routines/run";
import { runDepartment, toolsFor } from "@/team/team";
import { automationScore, writeProcedures } from "@/work/procedures";
import { createTracker, scanTracker, TRACKER_PRESETS } from "@/work/trackers";
import { workTools } from "@/work/tools";

const NOW = new Date("2026-11-05T04:00:00Z");
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: string;
let jash: string;
let gmailId: string;
const sumedhViewer = () => ({ orgId, personId: sumedh });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
const calls = (...c: { name: string; input: unknown }[]) => ({
  content: c.map((x, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: x.name, input: JSON.stringify(x.input) })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const stub = () => tool({ description: "stub", inputSchema: z.object({}), execute: async () => ({}) });
const exec = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: "t", messages: [] });

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: sumedh }, { id: jash }] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com" },
      { orgId, displayName: "Jash Doshi", isMember: true, primaryEmail: "jash@example.com" },
    ])
    .returning();
  const [gmail] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: sumedh, externalAccountId: "sumedh@example.com" }).returning();
  gmailId = gmail.id;
  await saveSecret(db, orgId, "connection", gmail.id, { kind: "oauth", app: "google", accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 86_400_000 } satisfies StoredCredential);

  // A dispatch group both are in, and one private note of Sumedh's.
  const [wa] = await db.insert(connections).values({ orgId, provider: "upload:whatsapp", scope: "personal", ownerPersonId: sumedh }).returning();
  const [group] = await db.insert(threads).values({ orgId, connectionId: wa.id, kind: "whatsapp", externalId: "wa:dispatch", title: "Dispatch", visibility: "members" }).returning();
  const [mine] = await db.insert(threads).values({ orgId, connectionId: wa.id, kind: "whatsapp", externalId: "wa:private", title: "Sumedh only", visibility: "members" }).returning();
  await db.insert(threadMembers).values([
    { orgId, threadId: group.id, personId: sumedh },
    { orgId, threadId: group.id, personId: jash },
    { orgId, threadId: mine.id, personId: sumedh },
  ]);
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  await db.insert(messages).values([
    { orgId, threadId: group.id, connectionId: wa.id, externalId: "d1", kind: "chat", authorPersonId: jash, sentAt: at(30), text: "Truck MH12AB1234 in at gate 9:10, weighed 32,400 gross" },
    { orgId, threadId: group.id, connectionId: wa.id, externalId: "d2", kind: "chat", authorPersonId: jash, sentAt: at(29), text: "MH12AB1234 unloaded and out at 10:40, net 12,000 kg HR coil grade 2" },
    { orgId, threadId: mine.id, connectionId: wa.id, externalId: "p1", kind: "chat", authorPersonId: sumedh, sentAt: at(28), text: "secret margin on the Tata deal is 14%" },
  ]);
}, 60_000);

afterAll(() => close());
afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    return handler(url, init);
  });
  return seen;
}

describe("approvals", () => {
  it("queues an email instead of sending it, then sends the approved (edited) text once", async () => {
    const { tools } = await proposalTools(db, sumedhViewer(), { origin: "chat", now: NOW });
    expect(Object.keys(tools)).toContain("gmail_send_email");
    const seen = stubFetch(() => Response.json({ id: "sent1" }));
    const queued = await exec(tools.gmail_send_email, { to: ["priya@acme.com"], subject: "Revised quote", body: "Hi Priya, 52,000 a tonne.", why_for_approver: "She asked for the revised quote" });
    expect(queued).toMatchObject({ status: "waiting for approval", summary: "Email to priya@acme.com: Revised quote" });
    expect(seen).toHaveLength(0);

    const [row] = await pendingFor(db, sumedhViewer());
    expect(row).toMatchObject({ audience: "external", origin: "chat", reason: "She asked for the revised quote", body: "Hi Priya, 52,000 a tonne." });
    // Someone else can't approve it.
    await expect(decide(db, { orgId, personId: jash }, row.id, "approve")).rejects.toThrow("already decided or isn't yours");

    const done = await decide(db, sumedhViewer(), row.id, "approve", { body: "Hi Priya, 51,500 a tonne, valid till Friday." });
    expect(done.status).toBe("done");
    expect(done.result?.url).toContain("sent1");
    expect(seen).toHaveLength(1);
    expect(seen[0].url.pathname).toBe("/gmail/v1/users/me/messages/send");
    const raw = Buffer.from(JSON.parse(String(seen[0].init.body)).raw, "base64url").toString("utf8");
    const body = Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toBe("Hi Priya, 51,500 a tonne, valid till Friday.");
    expect(raw).toContain("To: priya@acme.com");
    // A second click does nothing.
    await expect(decide(db, sumedhViewer(), row.id, "approve")).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("never offers someone else's personal mailbox", async () => {
    const { tools } = await proposalTools(db, { orgId, personId: jash }, { origin: "chat" });
    expect(Object.keys(tools)).not.toContain("gmail_send_email");
  });

  it("is decided by a reply in a messaging app", async () => {
    const { tools } = await proposalTools(db, sumedhViewer(), { origin: "messaging" });
    stubFetch(() => Response.json({ id: "sent2" }));
    const a = await exec(tools.gmail_send_email, { to: ["a@acme.com"], subject: "One", body: "x", why_for_approver: "r" });
    expect(await decideFromReply(db, sumedhViewer(), "what's overdue?")).toBeUndefined();
    // A bare "yes" to something else (the agent asked "want me to…?") approves nothing.
    expect(await decideFromReply(db, sumedhViewer(), "yes", NOW, "Want me to look at last month too?")).toBeUndefined();
    expect(await decideFromReply(db, sumedhViewer(), "yes", NOW, `Waiting for your OK (${a.code}): Email to a@acme.com`)).toMatch(/^Done: Email to a@acme.com/);
    const b = await exec(tools.gmail_send_email, { to: ["b@acme.com"], subject: "Two", body: "x", why_for_approver: "r" });
    await exec(tools.gmail_send_email, { to: ["c@acme.com"], subject: "Three", body: "x", why_for_approver: "r" });
    expect(await decideFromReply(db, sumedhViewer(), "yes")).toBeUndefined();
    expect(await decideFromReply(db, sumedhViewer(), `no ${String(b.code).toLowerCase()}`)).toBe("Dropped: Email to b@acme.com: Two.");
    expect(await decideFromReply(db, sumedhViewer(), "yes ZZZZ")).toBe("Nothing is waiting with the code ZZZZ.");
    expect(await decideFromReply(db, sumedhViewer(), "ok cool")).toBeUndefined();
    expect(a.code).not.toBe(b.code);
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
  });

  it("runs internal actions at once for a scheduled task its owner trusts, but never mail to clients", async () => {
    const [slackConn] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", ownerPersonId: jash, externalAccountId: "T1" }).returning();
    await saveSecret(db, orgId, "connection", slackConn.id, { kind: "token", values: { token: "xoxb-test" } } satisfies StoredCredential);
    const seen = stubFetch((url) =>
      url.host === "slack.com"
        ? Response.json(url.pathname.endsWith("conversations.list") ? { ok: true, channels: [{ id: "C7", name: "dispatch" }] } : url.pathname.endsWith("chat.postMessage") ? { ok: true, channel: "C7", ts: "1.1" } : { ok: true, permalink: "https://x.slack.com/p1" })
        : Response.json({ id: "sent3" }),
    );
    const [r] = await db.insert(routines).values({ orgId, ownerPersonId: sumedh, title: "Chase", instruction: "chase", schedule: { kind: "daily", time: "10:00" }, trusted: true }).returning();
    const { tools: trusted } = await proposalTools(db, sumedhViewer(), { origin: "routine", routine: { id: r.id, trusted: true } });
    const posted = await exec(trusted.slack_post_message, { to: "#dispatch", text: "Truck out", why_for_approver: "daily update" });
    expect(posted).toMatchObject({ status: "done", note: expect.stringContaining("trusts") });
    const [row] = await db.select().from(approvals).where(and(eq(approvals.routineId, r.id), eq(approvals.tool, "slack_post_message")));
    expect(row).toMatchObject({ status: "done", approvedBy: "trusted task", origin: "routine", reason: "daily update" });

    const mailed = await exec(trusted.gmail_send_email, { to: ["d@acme.com"], subject: "Chaser", body: "x", why_for_approver: "r" });
    expect(mailed).toMatchObject({ status: "waiting for approval" });
    expect(seen.filter((c) => c.url.host === "gmail.googleapis.com")).toHaveLength(0);
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
  });

  it("keeps a failure visible and lets it be retried", async () => {
    stubFetch(() => new Response("backend down", { status: 500 }));
    const { tools } = await proposalTools(db, sumedhViewer(), { origin: "chat" });
    await exec(tools.gmail_send_email, { to: ["e@acme.com"], subject: "Fails", body: "x", why_for_approver: "r" });
    const target = (await pendingFor(db, sumedhViewer())).find((a) => a.summary.includes("Fails"))!;
    const failed = await decide(db, sumedhViewer(), target.id, "approve");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("500");
    await retry(db, sumedhViewer(), target.id);
    expect((await pendingFor(db, sumedhViewer())).some((a) => a.id === target.id)).toBe(true);
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
  });

  it("shows up in the morning brief with what slipped", async () => {
    const { tools } = await proposalTools(db, sumedhViewer(), { origin: "chat" });
    const q = await exec(tools.gmail_send_email, { to: ["f@acme.com"], subject: "Brief me", body: "x", why_for_approver: "r" });
    const [source] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, "d2"));
    const [c] = await db
      .insert(commitments)
      .values({ orgId, title: "Send the mill certificate", ownerPersonId: jash, status: "overdue", quote: "will send", confidence: 0.9, sourceMessageId: source.id, extractor: "test", acl: ["org"] })
      .returning();
    await db.insert(commitmentEvents).values({ orgId, commitmentId: c.id, type: "status_changed", toStatus: "overdue", actor: "system", createdAt: new Date(NOW.getTime() - 3_600_000) });
    const brief = await buildBrief(db, sumedhViewer(), "Asia/Kolkata", NOW);
    expect(brief.approvals).toEqual([{ summary: "Email to f@acme.com: Brief me", code: q.code }]);
    expect(brief.slipped.map((s) => [s.title, s.person])).toEqual([["Send the mill certificate", "Jash Doshi"]]);
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
  });
});

describe("messaging", () => {
  beforeAll(async () => {
    await db.insert(channelLinks).values({ orgId, personId: sumedh, channel: "telegram", externalUserId: "777" });
  });

  it("treats 'yes CODE' as a decision without asking the model", async () => {
    stubFetch(() => Response.json({ id: "sent4" }));
    const { tools } = await proposalTools(db, sumedhViewer(), { origin: "chat" });
    const q = await exec(tools.gmail_send_email, { to: ["g@acme.com"], subject: "Via Telegram", body: "x", why_for_approver: "r" });
    const sent: string[] = [];
    const outcome = await handleInbound(db, { channel: "telegram", from: "777", id: "tg1", text: `Yes ${q.code}` }, { models: testModels(), transcribe: async () => "", send: async (t) => void sent.push(t) });
    expect(outcome).toBe("answered");
    expect(sent[0]).toMatch(/^Done: Email to g@acme.com: Via Telegram/);
  });

  it("reads a photo, saves it to notes and acknowledges it", async () => {
    const answer = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        expect(promptText(prompt)).toContain("Net weight: 12000 kg");
        return text("Weighment slip for MH12AB1234: 12,000 kg net. Saved.");
      },
    });
    const sent: string[] = [];
    const outcome = await handleInbound(
      db,
      { channel: "telegram", from: "777", id: "tg2", file: { mediaType: "image/jpeg", download: async () => new Uint8Array([1, 2, 3]) } },
      {
        models: testModels({ answer }),
        transcribe: async () => "",
        readFile: async ({ mediaType }) => (mediaType === "image/jpeg" ? "Vehicle: MH12AB1234\nNet weight: 12000 kg\nAbout: Weighment slip" : ""),
        send: async (t) => void sent.push(t),
        now: NOW,
      },
    );
    expect(outcome).toBe("answered");
    expect(sent[0]).toContain("12,000 kg");
    const notes = await db.select({ text: messages.text }).from(messages).innerJoin(threads, eq(threads.id, messages.threadId)).where(eq(threads.externalId, `notes:${sumedh}`));
    expect(notes.map((n) => n.text).join()).toContain("Net weight: 12000 kg");
  });
});

describe("the agent team", () => {
  it("gives each specialist only its tools", () => {
    const all = { searchMemory: {}, stripe_balance: {}, stripe_invoices: {}, xero_cash: {}, gmail_send_email: {}, askTeam: {}, scheduleTask: {} } as never;
    expect(Object.keys(toolsFor(all, ["stripe_", "searchMemory"]))).toEqual(["searchMemory", "stripe_balance", "stripe_invoices"]);
    expect(Object.keys(toolsFor(all, []))).toEqual(["searchMemory"]);
  });

  it("has the lead hand out work, runs specialists at the same time and combines their reports", async () => {
    let active = 0;
    let most = 0;
    const seenTools: Record<string, string[]> = {};
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt, tools }) => {
        const p = promptText(prompt);
        if (p.includes("You are Collections") || p.includes("You are Cash report")) {
          const who = p.includes("You are Collections") ? "Collections" : "Cash report";
          seenTools[who] = (tools ?? []).map((t) => t.name);
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
          return text(who === "Collections" ? "Acme owes 4.2L, 38 days late [S1]. Chaser waiting (K7QM)." : "Cash 18.4L across two accounts.");
        }
        const all = JSON.stringify(prompt);
        if (all.includes("Acme owes 4.2L") && all.includes("Cash 18.4L")) return text("Cash: 18.4L. Biggest overdue: Acme 4.2L [S1]. Waiting for your OK: K7QM.");
        return calls({ name: "delegate", input: { specialist: "Collections", task: "Overdue invoices, biggest first, draft chasers" } }, { name: "delegate", input: { specialist: "Cash report", task: "Cash position now" } });
      },
    });
    const run = await runDepartment({
      department: "finance",
      specialists: [
        { name: "Collections", job: "Chase overdue payments", tools: ["stripe_", "gmail_send_email"] },
        { name: "Cash report", job: "Cash position", tools: ["stripe_balance"] },
        { name: "Reconciliation", job: "Match payments", tools: [] },
      ],
      task: "Monday cash report",
      tools: { stripe_balance: stub(), stripe_invoices: stub(), gmail_send_email: stub(), searchMemory: stub() },
      model,
      instructions: "You are ALRO.",
    });
    expect(most).toBe(2);
    expect(run.reports.map((r) => r.specialist).sort()).toEqual(["Cash report", "Collections"]);
    expect(run.answer).toContain("K7QM");
    expect(seenTools.Collections.sort()).toEqual(["gmail_send_email", "stripe_balance", "stripe_invoices"]);
    expect(seenTools["Cash report"]).toEqual(["stripe_balance"]);
  });
});

describe("trackers and procedures", () => {
  it("fills a tracker from what its owner can see, with the source message, and never reads the same message twice", async () => {
    const preset = TRACKER_PRESETS.find((p) => p.name === "Truck turnaround")!;
    const t = await createTracker(db, sumedhViewer(), preset);
    const prompts: string[] = [];
    const extract = scriptedModel((p) => {
      prompts.push(p);
      return { rows: [{ line: 2, values: { Truck: "MH12AB1234", Site: "Gate", Arrived: "2026-11-03T09:10", Left: "2026-11-03T10:40", "Net weight": 12000 } }] };
    });
    expect(await scanTracker(db, t, testModels({ extract }), NOW)).toBe(1);
    const [again] = await db.select().from(trackers).where(eq(trackers.id, t.id));
    expect(again.scannedUntil).not.toBeNull();
    expect(await scanTracker(db, again, testModels({ extract }), NOW)).toBe(0);
    expect(prompts).toHaveLength(1);

    const rows = await exec(workTools(db, sumedhViewer(), "Asia/Kolkata").readTracker, { name: "truck" });
    expect(rows).toMatchObject({ tracker: "Truck turnaround", rows: 1, totals: { "Net weight": 12000 } });
  });

  it("only reads messages the tracker's owner could open", async () => {
    const t = await createTracker(db, { orgId, personId: jash }, TRACKER_PRESETS[0]);
    const prompts: string[] = [];
    await scanTracker(db, t, testModels({ extract: scriptedModel((p) => (prompts.push(p), { rows: [] })) }), NOW);
    expect(prompts.join()).toContain("MH12AB1234");
    expect(prompts.join()).not.toContain("secret margin");
  });

  it("scores what to hand over first: daily, long and rule-bound", () => {
    expect(automationScore({ frequency: "daily", minutes: 30, judgment: "low" })).toBe(100);
    expect(automationScore({ frequency: "occasional", minutes: 3, judgment: "high" })).toBe(10);
  });

  it("writes procedures with their sources and updates them by title", async () => {
    const extract = scriptedModel(() => ({
      procedures: [
        { title: "Unloading a truck", summary: "Every truck at the gate", steps: ["Weigh in at the gate", "Unload", "Weigh out and note net weight"], owners: "Jash", frequency: "daily", minutes: 90, judgment: "low", lines: [1, 2] },
        { title: "Made up", summary: "x", steps: ["y"], owners: null, frequency: "weekly", minutes: null, judgment: "high", lines: [99] },
      ],
    }));
    expect(await writeProcedures(db, sumedhViewer(), testModels({ extract }), NOW)).toBe(1);
    expect(await writeProcedures(db, sumedhViewer(), testModels({ extract }), NOW)).toBe(1);
    const saved = await db.select().from(procedures).where(eq(procedures.personId, sumedh));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "Unloading a truck", automationScore: 100 });
    expect(saved[0].messageIds).toHaveLength(2);
    const found = await exec(workTools(db, sumedhViewer(), "Asia/Kolkata").findProcedure, { query: "truck unloading" });
    expect(found).toMatchObject({ procedures: [{ title: "Unloading a truck", steps: ["Weigh in at the gate", "Unload", "Weigh out and note net weight"] }] });
    expect(await exec(workTools(db, { orgId, personId: jash }, "Asia/Kolkata").findProcedure, {})).toMatchObject({ procedures: [] });
  });
});

describe("after a call", () => {
  it("proposes the follow-up email from the organiser's own mailbox to the other attendees", async () => {
    const [meet] = await db.insert(connections).values({ orgId, provider: "google-meet", scope: "personal", ownerPersonId: sumedh, externalAccountId: "sumedh@example.com" }).returning();
    const [t] = await db.insert(threads).values({ orgId, connectionId: meet.id, kind: "meeting", externalId: "meet:1", title: "Pricing review", visibility: "members" }).returning();
    await db.insert(threadMembers).values([
      { orgId, threadId: t.id, personId: sumedh },
      { orgId, threadId: t.id, personId: jash },
    ]);
    await db.insert(messages).values({ orgId, threadId: t.id, connectionId: meet.id, externalId: "t1", kind: "transcript", authorPersonId: sumedh, sentAt: NOW, text: "We agreed 52,000 a tonne for HR coil. Jash sends the mill certificate by Friday. ".repeat(5) });
    const extract = scriptedModel(() => ({ summary: "Priced HR coil.", decisions: ["52,000 a tonne"], actions: [{ owner: "Jash", task: "Send the mill certificate", due: "Friday" }], followUp: "Thanks all. We agreed 52,000 a tonne. Jash sends the mill certificate by Friday." }));
    expect(await notePending(db, orgId, testModels({ extract }))).toBe(1);
    const [a] = await db.select().from(approvals).where(and(eq(approvals.personId, sumedh), eq(approvals.origin, "meeting")));
    expect(a).toMatchObject({ tool: "gmail_send_email", connectionId: gmailId, summary: "Email to jash@example.com: Notes and next steps: Pricing review", status: "pending" });
  });
});

describe("Teams bot requests", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const fetcher = (async (url: string | URL) =>
    String(url).includes("openidconfiguration") ? Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" }) : Response.json({ keys: [jwk] })) as typeof fetch;
  const token = (claims: Record<string, unknown>, alg = "RS256") => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg, kid: "k1", typ: "JWT" })}.${enc(claims)}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url")}`;
  };
  const now = Date.parse("2026-11-05T04:00:00Z");
  const good = { iss: "https://api.botframework.com", aud: "bot-app-id", exp: now / 1000 + 600, nbf: now / 1000 - 60, serviceurl: "https://smba.trafficmanager.net/in/" };
  const activity = { type: "message", serviceUrl: "https://smba.trafficmanager.net/in/" };

  beforeAll(() => {
    process.env.MICROSOFT_BOT_APP_ID = "bot-app-id";
  });
  afterAll(() => {
    delete process.env.MICROSOFT_BOT_APP_ID;
  });

  it("accepts a token Microsoft signed for this bot and this service URL", async () => {
    expect(await verifyTeamsRequest(`Bearer ${token(good)}`, activity, { now, fetcher })).toBe(true);
  });

  it("refuses anything else", async () => {
    const noServiceUrl = Object.fromEntries(Object.entries(good).filter(([k]) => k !== "serviceurl"));
    for (const bad of [{ ...good, aud: "other-bot" }, { ...good, exp: now / 1000 - 3600 }, { ...good, iss: "https://evil.example" }, { ...good, iss: "https://sts.windows.net/tenant/" }, { ...good, serviceurl: "https://evil.example/" }, noServiceUrl]) {
      expect(await verifyTeamsRequest(`Bearer ${token(bad)}`, activity, { now, fetcher }), JSON.stringify(bad)).toBe(false);
    }
    const forged = token(good).replace(/\.[^.]+$/, ".AAAA");
    expect(await verifyTeamsRequest(`Bearer ${forged}`, activity, { now, fetcher })).toBe(false);
    expect(await verifyTeamsRequest(null, activity, { now, fetcher })).toBe(false);
  });

  it("only sends the bot's token to Microsoft's bot service hosts", () => {
    expect(checkServiceUrl("https://smba.trafficmanager.net/in/").host).toBe("smba.trafficmanager.net");
    for (const bad of ["https://attacker.trafficmanager.net/", "http://smba.trafficmanager.net/", "https://evil.example/", "https://botframework.com.evil.example/"]) {
      expect(() => checkServiceUrl(bad), bad).toThrow();
    }
  });
});

describe("email actions", () => {
  it("writes RFC 822 that keeps non-English subjects and bodies intact", () => {
    const raw = rfc822({ to: ["priya@acme.com"], cc: ["ops@acme.com"], subject: "भाव / Rate: ₹52,000", body: "नमस्ते Priya,\nRate is ₹52,000." }, NOW);
    expect(raw).toContain("Cc: ops@acme.com");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    const body = Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toBe("नमस्ते Priya,\nRate is ₹52,000.");
  });

  it("can't be tricked into extra headers through the subject", () => {
    const raw = rfc822({ to: ["a@acme.com"], subject: "Hi\r\nBcc: spy@evil.com", body: "x" }, NOW);
    expect(raw).not.toMatch(/^Bcc:/m);
  });
});

describe("scheduled work", () => {
  it("a watch that finds nothing new stays quiet", async () => {
    const [r] = await db
      .insert(routines)
      .values({ orgId, ownerPersonId: sumedh, title: "Inquiries", instruction: "Draft quotes for new inquiries", schedule: { kind: "every", minutes: 15 }, nextRunAt: new Date(NOW.getTime() - 1000), lastRunAt: new Date(NOW.getTime() - 15 * 60_000) })
      .returning();
    const prompts: string[] = [];
    const answer = scriptedModel((p) => (prompts.push(p), "NOTHING_NEW"));
    expect(await runDueRoutines(db, orgId, testModels({ answer }), NOW)).toEqual({ ran: 1, failed: 0 });
    expect(prompts[0]).toContain("only handle what arrived or changed since then");
    const sent = await db.select().from(notifications).where(eq(notifications.personId, sumedh));
    expect(sent.filter((n) => n.kind.startsWith("routine:"))).toHaveLength(0);
    const [again] = await db.select().from(routines).where(eq(routines.id, r.id));
    expect(again.nextRunAt?.toISOString()).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());
    await db.delete(routines).where(eq(routines.id, r.id));
  });

  it("a task given to a department is planned by its lead and done by its specialists", async () => {
    await db.insert(teamAgents).values({ orgId, department: "operations", name: "What slipped", job: "Find what slipped", tools: ["listCommitments"] });
    await db.insert(routines).values({ orgId, ownerPersonId: sumedh, title: "Slipped", instruction: "What slipped yesterday", schedule: { kind: "weekdays", time: "07:30" }, nextRunAt: new Date(NOW.getTime() - 1000), team: "operations" });
    const seen: string[] = [];
    const answer = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const p = promptText(prompt);
        if (p.includes("You are What slipped")) return (seen.push("specialist"), text("The mill certificate to Acme slipped (Jash)."));
        if (JSON.stringify(prompt).includes("mill certificate to Acme slipped")) return (seen.push("lead:combine"), text("One thing slipped: the mill certificate (Jash)."));
        seen.push("lead:plan");
        return calls({ name: "delegate", input: { specialist: "What slipped", task: "What went overdue yesterday" } });
      },
    });
    expect(await runDueRoutines(db, orgId, testModels({ answer }), NOW)).toEqual({ ran: 1, failed: 0 });
    expect(seen).toEqual(["lead:plan", "specialist", "lead:combine"]);
    const [run] = await db.select().from(routineRuns).orderBy(desc(routineRuns.startedAt)).limit(1);
    expect(run.output).toBe("One thing slipped: the mill certificate (Jash).");
  });
});
