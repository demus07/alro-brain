import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { connections, orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { derivedToken, saveSecret } from "@/lib/secrets";
import { gmailPushUrl, pushUrl, receiveGmailPush, receivePush, registerPush, renewPushes, runPushSync } from "./push";
import type { StoredCredential } from "./sync";

const NOW = new Date("2026-11-05T04:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let gmailId: string;
let outlookId: string;
let slackId: string;

const token = (id: string) => derivedToken("push", id);
const row = async (id: string) => (await db.select().from(connections).where(eq(connections.id, id)))[0];
const noWait = async () => undefined;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const seen: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    return handler(url, init);
  });
  return seen;
}
const json = (body: unknown) => Response.json(body);
const gmailApi: Handler = (url) => {
  if (url.pathname.endsWith("/profile")) return json({ emailAddress: "owner@acme.com", historyId: "20" });
  if (url.pathname.endsWith("/history")) return json({ history: [] });
  return json({});
};

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Acme", timezone: "Asia/Kolkata" }).returning();
  const [owner] = await db.insert(people).values({ orgId, displayName: "Owner", isMember: true, primaryEmail: "owner@acme.com", role: "owner" }).returning();
  const oauth = { kind: "oauth", app: "google", accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 30 * DAY } satisfies StoredCredential;
  const [g] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: owner.id, externalAccountId: "owner@acme.com", cursor: { historyId: "10" } }).returning();
  const [o] = await db.insert(connections).values({ orgId, provider: "outlook", scope: "personal", ownerPersonId: owner.id, externalAccountId: "owner@acme.com" }).returning();
  const [s] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", ownerPersonId: owner.id, externalAccountId: "T1" }).returning();
  [gmailId, outlookId, slackId] = [g.id, o.id, s.id];
  await saveSecret(db, orgId, "connection", gmailId, oauth);
  await saveSecret(db, orgId, "connection", outlookId, { ...oauth, app: "microsoft" } satisfies StoredCredential);
}, 60_000);

afterAll(() => close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("receiving a push", () => {
  it("only accepts the connection's own secret address", async () => {
    expect(await receivePush(db, slackId, "wrong", NOW)).toBe("forbidden");
    expect(await receivePush(db, slackId, token(gmailId), NOW)).toBe("forbidden");
    expect(await receivePush(db, "not-an-id", "x", NOW)).toBe("unknown");
    expect((await row(slackId)).lastPushAt).toBeNull();
    expect(await receivePush(db, slackId, token(slackId), NOW)).toBe("accepted");
    expect((await row(slackId)).lastPushAt).toEqual(NOW);
  });

  it("ignores a connection that was removed", async () => {
    const [gone] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", externalAccountId: "T2", status: "revoked" }).returning();
    expect(await receivePush(db, gone.id, token(gone.id), NOW)).toBe("unknown");
  });

  it("limits a source that floods the address", async () => {
    const [c] = await db.insert(connections).values({ orgId, provider: "slack", scope: "org", externalAccountId: "T3" }).returning();
    const results = [];
    for (let i = 0; i < 602; i++) results.push(await receivePush(db, c.id, token(c.id), NOW));
    expect(results.slice(0, 600).every((r) => r === "accepted")).toBe(true);
    expect(results[601]).toBe("limited");
  }, 60_000);

  it("finds a Gmail mailbox from Google's Pub/Sub message", async () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "Owner@Acme.com", historyId: "99" })).toString("base64");
    expect((await receiveGmailPush(db, "wrong", { message: { data } }, NOW)).result).toBe("forbidden");
    const ok = await receiveGmailPush(db, token("gmail"), { message: { data } }, NOW);
    expect(ok).toEqual({ result: "accepted", connectionIds: [gmailId] });
    // A message that names nobody (or is garbage) is acknowledged and does nothing.
    expect(await receiveGmailPush(db, token("gmail"), { message: { data: "###" } }, NOW)).toEqual({ result: "accepted", connectionIds: [] });
    expect(await receiveGmailPush(db, token("gmail"), undefined, NOW)).toEqual({ result: "accepted", connectionIds: [] });
  });
});

describe("syncing because a source said so", () => {
  it("syncs the connection and doesn't repeat for a push it already covered", async () => {
    stubFetch(gmailApi);
    await db.update(connections).set({ lastPushAt: new Date(NOW.getTime() + 1000), lastSyncedAt: new Date(NOW.getTime() - HOUR) }).where(eq(connections.id, gmailId));
    const first = await runPushSync(db, gmailId, { now: () => new Date(NOW.getTime() + 2000), wait: noWait });
    expect(first.rounds).toBe(1);
    const synced = await row(gmailId);
    expect(synced.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(synced.lastPushAt!.getTime());
    expect(synced.cursor).toEqual({ historyId: "20" });
    // Nothing new was announced since: no second sync.
    expect(await runPushSync(db, gmailId, { now: () => new Date(NOW.getTime() + 3000), wait: noWait })).toEqual({ rounds: 0, messages: 0, skipped: "up to date" });
  });

  it("syncs again when another change arrives while it runs", async () => {
    let t = NOW.getTime();
    const clock = () => new Date((t += 1000));
    let calls = 0;
    stubFetch((url, init) => {
      // A second change is announced in the middle of the first sync: stamped after that sync started.
      if (url.pathname.endsWith("/history") && ++calls === 1) {
        return db
          .update(connections)
          .set({ lastPushAt: new Date(t + 500) })
          .where(eq(connections.id, gmailId))
          .then(() => gmailApi(url, init));
      }
      return gmailApi(url, init);
    });
    await db.update(connections).set({ lastPushAt: NOW, lastSyncedAt: new Date(NOW.getTime() - HOUR), pushState: null }).where(eq(connections.id, gmailId));
    expect((await runPushSync(db, gmailId, { wait: noWait, now: clock })).rounds).toBe(2);
  });

  it("lets only one run sync a connection at a time", async () => {
    stubFetch(gmailApi);
    await db.update(connections).set({ lastPushAt: new Date(), lastSyncedAt: new Date(Date.now() - HOUR), pushState: { syncingSince: new Date().toISOString() } }).where(eq(connections.id, gmailId));
    expect(await runPushSync(db, gmailId, { wait: noWait })).toEqual({ rounds: 0, messages: 0, skipped: "busy" });
    // A run that died long ago doesn't block it for ever.
    await db.update(connections).set({ pushState: { syncingSince: new Date(Date.now() - HOUR).toISOString() } }).where(eq(connections.id, gmailId));
    expect((await runPushSync(db, gmailId, { wait: noWait, now: () => new Date(Date.now() + 1000) })).rounds).toBe(1);
    expect((await row(gmailId)).pushState).not.toHaveProperty("syncingSince");
  });

  it("waits for a burst to settle before syncing", async () => {
    stubFetch(gmailApi);
    const waits: number[] = [];
    await db.update(connections).set({ lastPushAt: new Date(NOW.getTime() + 2000), lastSyncedAt: new Date(NOW.getTime() + 1000), pushState: null }).where(eq(connections.id, gmailId));
    await runPushSync(db, gmailId, { now: () => new Date(NOW.getTime() + 3000), wait: async (ms) => void waits.push(ms) });
    expect(waits[0]).toBe(3000);
  });
});

describe("asking a source to send changes", () => {
  it("does nothing without a public address", async () => {
    vi.stubEnv("ALRO_APP_URL", "");
    expect(await registerPush(db, await row(outlookId), NOW)).toEqual({ status: "unavailable" });
  });

  it("subscribes Outlook to the inbox at the connection's own address, then renews that subscription", async () => {
    vi.stubEnv("ALRO_APP_URL", "https://alro.example.com/");
    const seen = stubFetch((url) => (url.pathname.endsWith("/subscriptions") ? json({ id: "sub-1" }) : json({})));
    const first = await registerPush(db, await row(outlookId), NOW);
    expect(first).toEqual({ status: "registered", expiresAt: new Date(NOW.getTime() + 2.5 * DAY) });
    const create = seen.find((s) => s.url.pathname.endsWith("/subscriptions"))!;
    const body = JSON.parse(String(create.init.body));
    expect(body.notificationUrl).toBe(pushUrl("https://alro.example.com", outlookId));
    expect(body.resource).toBe("me/mailFolders('inbox')/messages");
    expect((await row(outlookId)).pushState).toMatchObject({ subscriptionId: "sub-1" });

    const later = new Date(NOW.getTime() + 2 * DAY);
    const renewed = stubFetch(() => json({}));
    await registerPush(db, await row(outlookId), later);
    expect(renewed.map((s) => `${s.init.method} ${s.url.pathname.split("/").slice(-2).join("/")}`)).toEqual(["PATCH subscriptions/sub-1"]);
  });

  it("makes a new Outlook subscription when Microsoft no longer has the old one", async () => {
    vi.stubEnv("ALRO_APP_URL", "https://alro.example.com");
    await db.update(connections).set({ pushState: { subscriptionId: "gone" } }).where(eq(connections.id, outlookId));
    stubFetch((url, init) => (init.method === "PATCH" ? new Response("{}", { status: 404 }) : json({ id: "sub-2" })));
    expect((await registerPush(db, await row(outlookId), NOW)).status).toBe("registered");
    expect((await row(outlookId)).pushState).toMatchObject({ subscriptionId: "sub-2" });
  });

  it("watches a Gmail mailbox only when a Pub/Sub topic is set up", async () => {
    vi.stubEnv("ALRO_APP_URL", "https://alro.example.com");
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "");
    expect((await registerPush(db, await row(gmailId), NOW)).status).toBe("manual");
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/acme/topics/gmail");
    const expiry = NOW.getTime() + 7 * DAY;
    const seen = stubFetch(() => json({ historyId: "1", expiration: String(expiry) }));
    expect(await registerPush(db, await row(gmailId), NOW)).toEqual({ status: "registered", expiresAt: new Date(expiry) });
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ topicName: "projects/acme/topics/gmail", labelIds: ["INBOX"] });
    expect(gmailPushUrl("https://alro.example.com")).toContain("/api/hooks/gmail/");
  });

  it("renews what is about to lapse, and leaves a source that just failed alone", async () => {
    vi.stubEnv("ALRO_APP_URL", "https://alro.example.com");
    await db.update(connections).set({ pushExpiresAt: new Date(NOW.getTime() + HOUR), pushState: { subscriptionId: "sub-2" } }).where(eq(connections.id, outlookId));
    await db.update(connections).set({ pushExpiresAt: new Date(NOW.getTime() + 5 * DAY) }).where(eq(connections.id, gmailId));
    const seen = stubFetch(() => json({}));
    expect(await renewPushes(db, NOW)).toEqual({ registered: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect((await row(outlookId)).pushExpiresAt!.getTime()).toBeGreaterThan(NOW.getTime() + 2 * DAY);

    // A failing source is recorded, then not retried for hours.
    await db.update(connections).set({ pushExpiresAt: new Date(NOW.getTime() + HOUR) }).where(eq(connections.id, outlookId));
    stubFetch(() => new Response("nope", { status: 500 }));
    expect((await renewPushes(db, NOW)).failed).toBe(1);
    const again = stubFetch(() => json({}));
    expect(await renewPushes(db, new Date(NOW.getTime() + HOUR))).toEqual({ registered: 0, failed: 0 });
    expect(again).toHaveLength(0);
  }, 30_000);
});
