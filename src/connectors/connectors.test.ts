import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { messages, orgs } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { writeBatch } from "@/ingest/writer";
import { fetchGmail } from "./gmail";
import { ProviderError, type Api } from "./nango";
import { fetchNotion } from "./notion";
import { fetchSlack } from "./slack";
import { retireOldVersions } from "./sync";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ts = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);

describe("Slack", () => {
  const routes = {
    "auth.test": () => ({ ok: true, team_id: "T1", url: "https://alro.slack.com/" }),
    "users.list": () => ({ ok: true, members: [{ id: "U1", name: "sumedh", real_name: "Sumedh Kudav" }, { id: "U2", name: "jash", real_name: "Jash Doshi" }] }),
    "conversations.list": () => ({ ok: true, channels: [{ id: "C1", name: "general", is_channel: true }, { id: "D1", is_im: true, user: "U2" }, { id: "C2", name: "secret", is_channel: true, is_private: true }] }),
    "conversations.history": (q: Record<string, unknown>) =>
      q.channel === "C1"
        ? { ok: true, messages: [{ type: "message", user: "U1", text: "Pricing call at 5", ts: ts("2026-11-01T10:00:00Z"), reply_count: 1 }] }
        : q.channel === "D1"
          ? { ok: true, messages: [{ type: "message", user: "U2", text: "sending the deck tonight", ts: ts("2026-11-01T11:00:00Z") }] }
          : { ok: false, error: "not_in_channel" },
    "conversations.replies": () => ({
      ok: true,
      messages: [
        { type: "message", user: "U1", text: "Pricing call at 5", ts: ts("2026-11-01T10:00:00Z") },
        { type: "message", user: "U2", text: "works for me", ts: ts("2026-11-01T10:05:00Z"), thread_ts: ts("2026-11-01T10:00:00Z") },
      ],
    }),
    "conversations.members": () => ({ ok: true, members: ["U1", "U2"] }),
  };

  it("reads channels, DMs and thread replies; skips channels it can't read", async () => {
    const { api } = fakeApi(routes);
    const { batch, cursor } = await fetchSlack(api, {}, NOW);
    expect(batch.connection).toMatchObject({ provider: "slack", scope: "org", externalAccountId: "T1" });
    expect(batch.threads.map((t) => [t.title, t.visibility])).toEqual([
      ["#general", "org"],
      ["Jash Doshi", "members"],
    ]);
    expect(batch.messages.map((m) => m.text)).toEqual(["Pricing call at 5", "works for me", "sending the deck tonight"]);
    expect(batch.messages[1].replyToExternalId).toBe(`C1:${ts("2026-11-01T10:00:00Z")}`);
    expect(cursor.latest).toEqual({ C1: ts("2026-11-01T10:05:00Z"), D1: ts("2026-11-01T11:00:00Z") });
  });

  it("asks only for what's new, with a week's overlap for late replies", async () => {
    const { api, calls } = fakeApi(routes);
    await fetchSlack(api, { latest: { C1: ts("2026-11-01T10:05:00Z") } }, NOW);
    const oldest = Number(calls.find((c) => c.path === "conversations.history" && c.query.channel === "C1")!.query.oldest);
    expect(oldest).toBeCloseTo(Number(ts("2026-10-25T10:05:00Z")), 0);
  });
});

describe("Gmail", () => {
  const raw = (id: string, subject: string) =>
    Buffer.from(
      `From: Jash Doshi <jash@example.com>\r\nTo: sumedh@example.com\r\nSubject: ${subject}\r\nDate: Sun, 01 Nov 2026 18:30:00 +0530\r\nMessage-ID: <${id}@example.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDetails for ${subject}.\r\n`,
    ).toString("base64url");

  it("backfills by date on the first sync and keeps Gmail's history id", async () => {
    const { api, calls } = fakeApi({
      "gmail/v1/users/me/profile": () => ({ emailAddress: "Sumedh@example.com", historyId: "900" }),
      "gmail/v1/users/me/messages": () => ({ messages: [{ id: "m1" }] }),
      "gmail/v1/users/me/messages/*": () => ({ raw: raw("m1", "Nango plan") }),
    });
    const { batch, cursor, mailbox } = await fetchGmail(api);
    expect(mailbox).toBe("sumedh@example.com");
    expect(batch.messages.map((m) => m.subject)).toEqual(["Nango plan"]);
    expect(cursor).toEqual({ historyId: "900" });
    expect(String(calls.find((c) => c.path === "gmail/v1/users/me/messages")!.query.q)).toContain("newer_than:90d");
  });

  it("reads only new mail from history, and falls back to a date search when history expired", async () => {
    const fresh = fakeApi({
      "gmail/v1/users/me/profile": () => ({ emailAddress: "s@example.com", historyId: "950" }),
      "gmail/v1/users/me/history": () => ({ history: [{ messagesAdded: [{ message: { id: "m2" } }, { message: { id: "spam", labelIds: ["SPAM"] } }] }] }),
      "gmail/v1/users/me/messages/*": () => ({ raw: raw("m2", "Follow-up") }),
    });
    expect((await fetchGmail(fresh.api, { historyId: "900" })).batch.messages.map((m) => m.subject)).toEqual(["Follow-up"]);

    const expired = fakeApi({
      "gmail/v1/users/me/profile": () => ({ emailAddress: "s@example.com", historyId: "999" }),
      "gmail/v1/users/me/messages": () => ({ messages: [] }),
    });
    await fetchGmail(expired.api, { historyId: "1" });
    expect(String(expired.calls.find((c) => c.path === "gmail/v1/users/me/messages")!.query.q)).toContain("newer_than:8d");
  });
});

describe("Notion", () => {
  const page = (id: string, edited: string, title: string) => ({
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: edited,
    last_edited_by: { id: "u1" },
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  });
  const routes = {
    "v1/search": () => ({ results: [page("p2", "2026-11-01T10:00:00.000Z", "Pricing"), page("p1", "2026-10-01T10:00:00.000Z", "Old notes")], has_more: false, next_cursor: null }),
    "v1/blocks/*": () => ({
      results: [
        { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Plans" }] } },
        { id: "b2", type: "to_do", to_do: { rich_text: [{ plain_text: "Send the deck" }], checked: true } },
      ],
      has_more: false,
      next_cursor: null,
    }),
    "v1/users/*": () => ({ type: "person", name: "Sumedh Kudav", person: { email: "sumedh@example.com" } }),
  };

  it("reads pages edited since the last sync as versioned documents", async () => {
    const { api } = fakeApi(routes);
    const { batch, cursor, versions } = await fetchNotion(api, "conn1", { since: "2026-10-15T00:00:00.000Z" });
    expect(batch.threads.map((t) => [t.title, t.kind, t.visibility])).toEqual([["Pricing", "doc", "org"]]);
    expect(batch.messages[0].text).toBe("## Plans\n- [x] Send the deck");
    expect(batch.messages[0].externalId).toBe("p2@2026-11-01T10:00:00.000Z");
    expect(versions.get("p2")).toBe("p2@2026-11-01T10:00:00.000Z");
    expect(cursor.since).toBe("2026-11-01T10:00:00.000Z");
    expect(batch.people[0]).toMatchObject({ displayName: "Sumedh Kudav", email: "sumedh@example.com" });
  });
});

describe("document versions", () => {
  let db: Db;
  let close: () => Promise<void>;
  let orgId: string;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    [{ id: orgId }] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();
  }, 60_000);
  afterAll(() => close());

  it("keeps only the latest version of an edited page", async () => {
    const doc = (version: string, text: string) => ({
      connection: { provider: "notion", scope: "org" as const, externalAccountId: "notion:c1" },
      people: [],
      threads: [{ externalId: "p1", kind: "doc" as const, title: "Pricing", visibility: "org" as const, memberKeys: [] }],
      messages: [{ threadExternalId: "p1", externalId: `p1@${version}`, kind: "note" as const, sentAt: new Date(version), text }],
    });
    await writeBatch(db, orgId, doc("2026-10-01T00:00:00Z", "₹40k per site"));
    const { connectionId } = await writeBatch(db, orgId, doc("2026-11-01T00:00:00Z", "₹55k per site"));
    await retireOldVersions(db, connectionId, new Map([["p1", "p1@2026-11-01T00:00:00Z"]]));
    const live = await db.select({ text: messages.text }).from(messages).where(and(eq(messages.connectionId, connectionId), isNull(messages.deletedAt)));
    expect(live.map((m) => m.text)).toEqual(["₹55k per site"]);
  });
});
