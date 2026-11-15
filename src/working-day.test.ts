import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { plainAnswer } from "@/agent/plain";
import { learnStyle, loadProfile, profileInstructions, rememberNote } from "@/agent/profile";
import { scriptedModel, testModels } from "@/ai/test-models";
import { splitMessage, validSlackSignature, validWhatsAppSignature } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { createLinkCode, notifyPerson } from "@/channels/links";
import { httpApi } from "@/connectors/api";
import { providerOf } from "@/connectors/registry";
import { connectAccount, syncConnection, type StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { channelMessages, commitments, connections, events, meetingNotes, messages, notifications, orgs, people, profileNotes, routineRuns, routines, secrets, threadMembers, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { readSecret } from "@/lib/secrets";
import { saveNote } from "@/memory/notes";
import { buildBrief } from "@/notify/brief";
import { meetingsBetween, prepareMeeting, renderPrep, sendMeetingBriefs } from "@/notify/meetings";
import { notePending } from "@/pipeline/meeting-notes";
import { runDueRoutines } from "@/routines/run";
import { createHmac } from "node:crypto";

// Thursday 5 Nov 2026, 09:30 IST.
const NOW = new Date("2026-11-05T04:00:00Z");
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: string;
let jash: string;
let outsider: string;

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  [{ id: sumedh }, { id: jash }, { id: outsider }] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com" },
      { orgId, displayName: "Jash Doshi", isMember: true, primaryEmail: "jash@example.com" },
      { orgId, displayName: "Olu Outsider", isMember: true, primaryEmail: "olu@example.com" },
    ])
    .returning();
  const [c] = await db.insert(connections).values({ orgId, provider: "upload:whatsapp", scope: "personal", ownerPersonId: sumedh }).returning();
  const [t] = await db.insert(threads).values({ orgId, connectionId: c.id, kind: "whatsapp", externalId: "wa:1", title: "Alro", visibility: "members" }).returning();
  await db.insert(threadMembers).values([
    { orgId, threadId: t.id, personId: sumedh },
    { orgId, threadId: t.id, personId: jash },
  ]);
  const said = (i: number, authorPersonId: string, text: string) => ({ orgId, threadId: t.id, connectionId: c.id, externalId: `m${i}`, kind: "chat" as const, authorPersonId, sentAt: new Date(NOW.getTime() - (20 - i) * 3_600_000), text });
  const rows = await db
    .insert(messages)
    .values([
      said(1, sumedh, "I'll send the deck to you by Friday, promise this time"),
      ...Array.from({ length: 9 }, (_, i) => said(i + 2, sumedh, `ok so the plan for week ${i + 1} is simple, we ship the brain and then talk pricing`)),
      said(12, jash, "pricing page is live, crimson and cream like we said"),
    ])
    .returning();
  await db.insert(commitments).values({ orgId, title: "Send the deck", ownerPersonId: sumedh, counterpartyPersonId: jash, status: "open", quote: "I'll send the deck", confidence: 0.9, sourceMessageId: rows[0].id, extractor: "test", acl: [`t:${t.id}`] });
}, 60_000);

afterAll(() => close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("direct connections", () => {
  const meeting = {
    id: "ev1",
    summary: "Pricing review",
    start: { dateTime: new Date(NOW.getTime() + 20 * 60_000).toISOString() },
    end: { dateTime: new Date(NOW.getTime() + 50 * 60_000).toISOString() },
    hangoutLink: "https://meet.example.com/abc",
    attendees: [{ email: "sumedh@example.com", self: true }, { email: "Jash@example.com", displayName: "Jash" }, { email: "priya@acme.com", displayName: "Priya" }, { email: "room@example.com", resource: true }],
  };
  const google = (calls: string[], status = 200) =>
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.host}${url.pathname} ${new Headers(init?.headers).get("authorization") ?? ""}`.trim());
      if (url.host === "oauth2.googleapis.com") return json({ access_token: "fresh-token", expires_in: 3600 });
      if (status !== 200) return json({ error: "revoked" }, status);
      if (url.pathname.endsWith("/calendars/primary")) return json({ id: "Sumedh@example.com" });
      return json({ items: [meeting, { id: "ev2", status: "cancelled", summary: "Old sync", start: { date: "2026-11-06" }, end: { date: "2026-11-07" } }] });
    });

  it("checks a sign-in, stores it encrypted, refreshes it, and syncs the calendar", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const calls: string[] = [];
    vi.stubGlobal("fetch", google(calls));
    const provider = providerOf("google-calendar")!;
    const expired: StoredCredential = { kind: "oauth", app: "google", accessToken: "stale-token", refreshToken: "refresh-me", expiresAt: 0 };
    const id = await connectAccount(db, { orgId, personId: sumedh }, provider, expired);

    const [row] = await db.select().from(connections).where(eq(connections.id, id));
    expect(row).toMatchObject({ provider: "google-calendar", scope: "personal", ownerPersonId: sumedh, externalAccountId: "sumedh@example.com" });
    const [stored] = await db.select().from(secrets).where(eq(secrets.refId, id));
    expect(stored.data).not.toMatch(/fresh-token|stale-token|refresh-me/);
    expect(await readSecret<StoredCredential>(db, "connection", id)).toMatchObject({ accessToken: "fresh-token", refreshToken: "refresh-me" });
    expect(calls).toEqual(["oauth2.googleapis.com/token", "www.googleapis.com/calendar/v3/calendars/primary Bearer fresh-token"]);

    expect(await syncConnection(db, row, NOW)).toMatchObject({ events: 2, messages: 0 });
    const saved = await db.select().from(events).where(eq(events.connectionId, id));
    const review = saved.find((e) => e.externalId === "ev1")!;
    expect(review).toMatchObject({ title: "Pricing review", ownerPersonId: sumedh, cancelled: false, url: "https://meet.example.com/abc", acl: [`p:${sumedh}`] });
    expect(review.attendees).toEqual([
      { email: "jash@example.com", name: "Jash", personId: jash },
      { email: "priya@acme.com", name: "Priya" },
    ]);
    expect(saved.find((e) => e.externalId === "ev2")).toMatchObject({ cancelled: true, allDay: true });
    // Connecting the same account again repairs it rather than adding a second one.
    expect(await connectAccount(db, { orgId, personId: sumedh }, provider, { ...expired, expiresAt: Date.now() + 3_600_000 })).toBe(id);
  });

  it("marks a connection broken when the app refuses its credential", async () => {
    vi.stubGlobal("fetch", google([], 401));
    const [row] = await db.select().from(connections).where(eq(connections.provider, "google-calendar"));
    expect((await syncConnection(db, row, NOW)).error).toContain("401");
    const [after] = await db.select().from(connections).where(eq(connections.id, row.id));
    expect(after.status).toBe("error");
    await db.update(connections).set({ status: "active", lastError: null }).where(eq(connections.id, row.id));
  });

  it("checks a pasted token against the app before saving it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: false, error: "invalid_auth" })));
    await expect(connectAccount(db, { orgId, personId: sumedh }, providerOf("slack")!, { kind: "token", values: { token: "xoxb-bad" } })).rejects.toThrow("invalid_auth");
    expect(await db.select().from(connections).where(eq(connections.provider, "slack"))).toHaveLength(0);
  });

  it("never sends an account's token to another host", async () => {
    const send = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", send);
    const api = httpApi({ baseUrl: "https://api.example.com/v1/", headers: () => ({ authorization: "Bearer t" }), hosts: ["files.example.com"] });
    await api("GET", "items");
    await api("GET", "https://files.example.com/next?page=2");
    await expect(api("GET", "https://evil.example.net/steal")).rejects.toThrow("not one of this provider's hosts");
    await expect(api("GET", "http://api.example.com/v1/items")).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("hides credentials, calendars and personal notes from everyone else", async () => {
    await rememberNote(db, { orgId, personId: sumedh }, { category: "goal", text: "Close two pilots this quarter" });
    const as = (personId: string) => ({ orgId, personId });
    await expect(withScope(db, as(sumedh), (tx) => tx.select().from(secrets))).rejects.toThrow();
    expect(await withScope(db, as(outsider), (tx) => tx.select().from(events))).toHaveLength(0);
    expect(await withScope(db, as(sumedh), (tx) => tx.select().from(events))).toHaveLength(2);
    expect(await withScope(db, as(outsider), (tx) => tx.select().from(profileNotes))).toHaveLength(0);
    expect(await withScope(db, as(sumedh), (tx) => tx.select().from(profileNotes))).toHaveLength(1);
  });
});

describe("meetings", () => {
  it("prepares a meeting from what's in memory about the people in it", async () => {
    const viewer = { orgId, personId: sumedh };
    const [next] = await meetingsBetween(db, viewer, NOW, new Date(NOW.getTime() + 3_600_000));
    const prep = await prepareMeeting(db, viewer, next, "Asia/Kolkata");
    expect(prep.attendees).toEqual([
      { name: "Jash", known: true },
      { name: "Priya", known: false },
    ]);
    expect(prep.youOwe).toEqual([{ title: "Send the deck", to: "Jash Doshi", due: null }]);
    expect(prep.lastSaid).toMatchObject([{ who: "Jash Doshi", where: "Alro", text: "pricing page is live, crimson and cream like we said" }]);
    const mail = renderPrep(prep, "Asia/Kolkata");
    expect(mail.subject).toBe("Before Pricing review");
    expect(mail.text).toContain("You owe them\n- Send the deck (to Jash Doshi)");
    expect((await buildBrief(db, viewer, "Asia/Kolkata", NOW)).meetings).toEqual([{ title: "Pricing review", at: "09:50", with: ["Jash", "Priya"] }]);
    // Someone else's calendar is theirs alone.
    expect(await meetingsBetween(db, { orgId, personId: jash }, NOW, new Date(NOW.getTime() + 3_600_000))).toHaveLength(0);
  });

  it("briefs a member once, shortly before the meeting", async () => {
    expect(await sendMeetingBriefs(db, orgId, NOW)).toEqual({ briefed: 1 });
    expect(await sendMeetingBriefs(db, orgId, NOW)).toEqual({ briefed: 0 });
    expect(await sendMeetingBriefs(db, orgId, new Date(NOW.getTime() - 3 * 3_600_000))).toEqual({ briefed: 0 });
  });

  it("writes notes for a meeting transcript, visible to whoever can see the meeting", async () => {
    const [c] = await db.select().from(connections).where(eq(connections.provider, "upload:whatsapp"));
    const [t] = await db.insert(threads).values({ orgId, connectionId: c.id, kind: "meeting", externalId: "meet:1", title: "Pricing review", visibility: "members" }).returning();
    await db.insert(threadMembers).values({ orgId, threadId: t.id, personId: sumedh });
    await db.insert(messages).values(
      Array.from({ length: 6 }, (_, i) => ({ orgId, threadId: t.id, connectionId: c.id, externalId: `t${i}`, kind: "transcript" as const, authorPersonId: i % 2 ? jash : sumedh, sentAt: new Date(NOW.getTime() + i * 60_000), text: "We agreed the price is fifty five thousand per site and Jash sends the revised proposal by Friday." })),
    );
    const extract = scriptedModel(() => ({ summary: "Pricing was settled.", decisions: ["Price is ₹55k per site."], actions: [{ owner: "Jash", task: "Send the revised proposal", due: "by Friday" }], followUp: "Thanks all. Price is ₹55k per site." }));
    expect(await notePending(db, orgId, testModels({ extract }))).toBe(1);
    expect(await notePending(db, orgId, testModels({ extract }))).toBe(0);
    const [notes] = await db.select().from(meetingNotes).where(eq(meetingNotes.threadId, t.id));
    expect(notes.summary).toBe("Pricing was settled.\n**Decisions**\n- Price is ₹55k per site.\n**Actions**\n- Jash: Send the revised proposal (by Friday)");
    expect(notes.acl).toEqual([`t:${t.id}`]);
    expect(await withScope(db, { orgId, personId: outsider }, (tx) => tx.select().from(meetingNotes))).toHaveLength(0);
    expect(await withScope(db, { orgId, personId: sumedh }, (tx) => tx.select().from(meetingNotes))).toHaveLength(1);
  });
});

describe("personal brain", () => {
  it("puts what it knows about a member into their agent's instructions only", async () => {
    const mine = await loadProfile(db, { orgId, personId: sumedh });
    expect(profileInstructions(mine, "Sumedh")).toContain("Goals:\n- Close two pilots this quarter");
    expect(profileInstructions(await loadProfile(db, { orgId, personId: jash }), "Jash")).toBe("");
  });

  it("learns a member's writing style from their own messages, when there are enough", async () => {
    const extract = scriptedModel((prompt) => (prompt.includes("ship the brain") && !prompt.includes("pricing page is live") ? "- Lowercase, short, direct." : "wrong samples"));
    expect(await learnStyle(db, { orgId, personId: jash }, testModels({ extract }))).toBe(false);
    expect(await learnStyle(db, { orgId, personId: sumedh }, testModels({ extract }), NOW)).toBe(true);
    expect((await loadProfile(db, { orgId, personId: sumedh })).style).toBe("- Lowercase, short, direct.");
  });

  it("saves a dictated note privately, as the member's own message", async () => {
    await saveNote(db, { orgId, personId: sumedh }, "Decided: we charge ₹55k per site from December.", { now: NOW });
    const note = await withScope(db, { orgId, personId: sumedh }, (tx) => tx.select().from(messages).where(eq(messages.kind, "note")));
    expect(note).toMatchObject([{ authorPersonId: sumedh, text: "Decided: we charge ₹55k per site from December." }]);
    expect(await withScope(db, { orgId, personId: jash }, (tx) => tx.select().from(messages).where(eq(messages.kind, "note")))).toHaveLength(0);
  });
});

describe("scheduled tasks", () => {
  it("runs a due task once as its owner and keeps the result", async () => {
    const [routine] = await db
      .insert(routines)
      .values({ orgId, ownerPersonId: sumedh, title: "Morning cash report", instruction: "List overdue payments.", schedule: { kind: "daily", time: "09:00" }, nextRunAt: new Date(NOW.getTime() - 60_000) })
      .returning();
    const answer = scriptedModel((prompt) => (prompt.includes('titled "Morning cash report"') && prompt.includes("List overdue payments.") ? "**Nothing overdue.**" : "unexpected prompt"));
    expect(await runDueRoutines(db, orgId, testModels({ answer }), NOW)).toEqual({ ran: 1, failed: 0 });
    expect(await runDueRoutines(db, orgId, testModels({ answer }), NOW)).toEqual({ ran: 0, failed: 0 });
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(run).toMatchObject({ status: "ok", output: "*Nothing overdue.*", personId: sumedh });
    const [after] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(after.nextRunAt?.toISOString()).toBe("2026-11-06T03:30:00.000Z");
    expect(await db.select().from(notifications).where(and(eq(notifications.personId, sumedh), eq(notifications.kind, `routine:${run.id}`)))).toHaveLength(1);
    expect(await withScope(db, { orgId, personId: jash }, (tx) => tx.select().from(routines))).toHaveLength(0);
  });

  it("records a failed run instead of losing it", async () => {
    await db.insert(routines).values({ orgId, ownerPersonId: sumedh, title: "Broken", instruction: "x", schedule: { kind: "once", at: "2026-11-05T09:00" }, nextRunAt: new Date(NOW.getTime() - 60_000) });
    const answer = scriptedModel(() => {
      throw new Error("model is down");
    });
    expect(await runDueRoutines(db, orgId, testModels({ answer }), NOW)).toEqual({ ran: 0, failed: 1 });
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.status, "error"));
    expect(run.error).toContain("model is down");
  });
});

describe("messaging", () => {
  const sent: string[] = [];
  const deps = (answer = scriptedModel(() => "You owe Jash the deck [S9].")) => ({
    models: testModels({ answer }),
    transcribe: vi.fn(async () => "what do I owe Jash"),
    send: async (text: string) => void sent.push(text),
    now: NOW,
  });

  it("tells a stranger how to link and nothing else", async () => {
    expect(await handleInbound(db, { channel: "telegram", from: "555", text: "what's our pricing?" }, deps())).toBe("unlinked");
    expect(await handleInbound(db, { channel: "telegram", from: "555", text: "00000000" }, deps())).toBe("unlinked");
    expect(sent.every((s) => s.includes("Settings → Messaging"))).toBe(true);
    expect(await db.select().from(channelMessages)).toHaveLength(0);
  });

  it("links with a one-time code, then answers as that member", async () => {
    const code = await createLinkCode(db, { orgId, personId: sumedh }, NOW);
    expect(code).toMatch(/^\d{8}$/);
    expect(await handleInbound(db, { channel: "telegram", from: "555", text: `my code is ${code}` }, deps())).toBe("linked");
    expect(sent.at(-1)).toContain("Hi Sumedh");
    // The code is used up.
    expect(await handleInbound(db, { channel: "telegram", from: "777", text: code }, deps())).toBe("unlinked");

    expect(await handleInbound(db, { channel: "telegram", from: "555", id: "555:1", text: "what do I owe Jash?" }, deps())).toBe("answered");
    expect(sent.at(-1)).toBe("You owe Jash the deck [S9].");
    expect(await handleInbound(db, { channel: "telegram", from: "555", id: "555:1", text: "what do I owe Jash?" }, deps())).toBe("duplicate");
  });

  it("transcribes a voice note and keeps the conversation for follow-ups", async () => {
    const d = deps(scriptedModel((prompt) => (prompt.includes("(voice note) what do I owe Jash") && prompt.includes("You owe Jash the deck") ? "Still the deck." : "no context")));
    expect(await handleInbound(db, { channel: "telegram", from: "555", id: "555:2", audio: async () => new Uint8Array([1, 2, 3]) }, d)).toBe("answered");
    expect(d.transcribe).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toBe("Still the deck.");
    const log = await db.select().from(channelMessages).where(eq(channelMessages.personId, sumedh));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("sends briefs only to channels that are set up", async () => {
    expect(await notifyPerson(db, orgId, sumedh, "Morning.", NOW)).toEqual([]);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "t");
    const send = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", send);
    expect(await notifyPerson(db, orgId, sumedh, "Morning.", NOW)).toEqual(["telegram"]);
    expect(JSON.parse((send.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ chat_id: "555", text: "Morning." });
  });

  it("checks webhook signatures", () => {
    const body = '{"entry":[]}';
    const meta = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(validWhatsAppSignature(body, meta, "app-secret")).toBe(true);
    expect(validWhatsAppSignature(`${body} `, meta, "app-secret")).toBe(false);
    expect(validWhatsAppSignature(body, null, "app-secret")).toBe(false);
    expect(validWhatsAppSignature(body, meta, undefined)).toBe(false);
    const ts = "1000";
    const slack = `v0=${createHmac("sha256", "signing").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(validSlackSignature(body, ts, slack, 1000_000, "signing")).toBe(true);
    expect(validSlackSignature(body, ts, slack, 2000_000, "signing")).toBe(false);
    expect(validSlackSignature(body, ts, "v0=00", 1000_000, "signing")).toBe(false);
  });

  it("formats answers for a messaging app", () => {
    const results = [{ results: [{ ref: "S1", thread: "Alro", at: "Wed 4 Nov, 18:00", author: "Jash Doshi", text: "…" }, { ref: "S2", thread: "Pricing", at: "Tue", text: "…" }] }];
    expect(plainAnswer("**Price** is ₹55k [S1].\n```draft\nTo: Jash\n\nSending it now.\n```", results)).toBe(
      "*Price* is ₹55k [S1].\n— Draft —\nTo: Jash\n\nSending it now.\n— end —\n\nSources\n[S1] Alro, Wed 4 Nov, 18:00 (Jash Doshi)",
    );
    expect(plainAnswer("No refs here.", results)).toBe("No refs here.");
    const parts = splitMessage(`${"a".repeat(30)}\n\n${"b".repeat(30)}`, 40);
    expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
  });
});
