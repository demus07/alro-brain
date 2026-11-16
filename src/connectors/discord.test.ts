import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { discord, fetchDiscord, honourRetryAfter, snowflakeAt } from "./discord";

function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { method: string; path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query });
    // Exact routes win over wildcards.
    const route = path in routes ? path : Object.keys(routes).find((r) => r.endsWith("*") && path.startsWith(r.slice(0, -1)));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const G = "100000000000000000";
const at = (iso: string) => snowflakeAt(Date.parse(iso));
const VIEW = String(1 << 10);
const user = (id: string, username: string, global_name?: string) => ({ id, username, global_name });
const msg = (id: string, author: ReturnType<typeof user>, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 0,
  content,
  timestamp: new Date(Number((BigInt(id) >> BigInt(22)) + BigInt(1420070400000))).toISOString(),
  author,
  ...extra,
});

const SUMEDH = user("201", "sumedh", "Sumedh Kudav");
const JASH = user("202", "jash", "Jash Doshi");
const M1 = at("2026-11-01T10:00:00Z");
const M2 = at("2026-11-01T10:05:00Z");
const T1 = at("2026-11-01T11:00:00Z");
const T1M = at("2026-11-01T11:01:00Z");
const S1 = at("2026-11-01T12:00:00Z");

const base = (memberIntent: boolean) => ({
  [`guilds/${G}`]: () => ({ id: G, name: "ALRO", owner_id: "201", roles: [{ id: G, name: "@everyone", permissions: VIEW }, { id: "900", name: "founders", permissions: "0" }] }),
  [`guilds/${G}/channels`]: () => [
    { id: "300", type: 4, name: "Text" },
    { id: "301", type: 0, name: "general", parent_id: "300", last_message_id: M2, permission_overwrites: [] },
    { id: "302", type: 0, name: "founders", last_message_id: S1, permission_overwrites: [{ id: G, type: 0, allow: "0", deny: VIEW }, { id: "900", type: 0, allow: VIEW, deny: "0" }] },
    { id: "303", type: 2, name: "Voice" },
  ],
  [`guilds/${G}/threads/active`]: () => ({ threads: [{ id: T1, type: 11, name: "pricing", parent_id: "301", last_message_id: T1M }] }),
  "channels/*": (q: Record<string, unknown>) => ({ threads: [], q }),
  [`guilds/${G}/members`]: () => {
    if (!memberIntent) throw new ProviderError("403 Missing Access", 403);
    return [
      { user: SUMEDH, roles: [] },
      { user: JASH, roles: ["900"] },
      { user: user("203", "rohan"), roles: [] },
      { user: { ...user("299", "alro-bot"), bot: true }, roles: ["900"] },
    ];
  },
  [`channels/301/messages`]: (q: Record<string, unknown>) =>
    q.after === M1 ? [msg(M2, JASH, "works for me <@201>", { mentions: [SUMEDH], message_reference: { type: 0, message_id: M1, channel_id: "301" } })] : [msg(M2, JASH, "works for me <@201>", { mentions: [SUMEDH], message_reference: { type: 0, message_id: M1, channel_id: "301" } }), msg(M1, SUMEDH, "Pricing call at 5")],
  [`channels/${T1}/messages`]: () => [msg(T1M, SUMEDH, "Deck goes out tonight", { attachments: [{ filename: "deck.pdf", content_type: "application/pdf", url: "https://cdn.discordapp.com/x", size: 10 }] }), { ...msg(T1, SUMEDH, ""), type: 21 }],
  [`channels/302/messages`]: () => [msg(S1, JASH, "Raise closes Friday")],
});

const api = (memberIntent = true) => fakeApi(base(memberIntent));

describe("Discord", () => {
  it("maps channels, threads, people and replies on the first sync, and returns a cursor", async () => {
    const { api: a, calls } = api();
    const r = await fetchDiscord(a, G, {}, NOW);
    expect(r.threads.map((t) => [t.title, t.visibility])).toEqual([
      ["#general", "org"],
      ["#founders", "members"],
      ["#general › pricing", "org"],
    ]);
    // Owner (Sumedh) and the founders role (Jash) can see #founders; Rohan and the bot can't.
    expect(r.threads[1].memberKeys.sort()).toEqual(["discord:201", "discord:202"]);
    expect(r.messages.map((m) => m.text)).toEqual(["Pricing call at 5", "works for me @Sumedh Kudav", "Raise closes Friday", "Deck goes out tonight"]);
    expect(r.messages[1]).toMatchObject({ replyToExternalId: `301:${M1}`, authorKey: "discord:202", recipientKeys: ["discord:201"], url: `https://discord.com/channels/${G}/301/${M2}` });
    expect(r.messages[3].attachments).toEqual([{ name: "deck.pdf", mimeType: "application/pdf", url: "https://cdn.discordapp.com/x", size: 10 }]);
    expect(r.people.find((p) => p.key === "discord:202")).toMatchObject({ displayName: "Jash Doshi", provider: "discord", externalId: "202" });
    expect(r.cursor.after).toEqual({ "301": M2, "302": S1, [T1]: T1M });
    expect(r.cursor.archivedAt).toBe(NOW.toISOString());
    // 90-day backfill expressed as a snowflake; voice channels and categories untouched.
    expect(calls.find((c) => c.path === "channels/301/messages")!.query).toEqual({ after: at("2026-08-04T12:00:00Z"), limit: 100 });
    expect(calls.some((c) => c.path.startsWith("channels/303") || c.path.startsWith("channels/300/messages"))).toBe(false);
  });

  it("asks only for what's new, and skips channels with nothing newer", async () => {
    const { api: a, calls } = api();
    const r = await fetchDiscord(a, G, { after: { "301": M1, "302": S1, [T1]: T1M }, archivedAt: NOW.toISOString(), rereadAt: NOW.toISOString() }, NOW);
    expect(calls.find((c) => c.path === "channels/301/messages")!.query.after).toBe(M1);
    expect(calls.some((c) => c.path === "channels/302/messages" || c.path === `channels/${T1}/messages`)).toBe(false);
    expect(calls.some((c) => c.path.includes("archived"))).toBe(false);
    // The channel with something new is also read back from its cursor, which re-sends what is still there.
    expect(r.messages.map((m) => m.text)).toEqual(["Pricing call at 5", "works for me @Sumedh Kudav"]);
    expect(r.cursor.after!["301"]).toBe(M2);
  });

  it("reports every channel read before with its audience now, and the stretch it re-read to the end", async () => {
    const { api: a, calls } = api();
    const r = await fetchDiscord(a, G, { after: { "301": M2, "302": S1, [T1]: T1M }, archivedAt: NOW.toISOString() }, NOW);
    // Nothing new anywhere, yet every channel comes back: #founders with its whole member list.
    expect(r.threads.map((t) => [t.title, t.visibility, t.membersComplete, [...t.memberKeys].sort()])).toEqual([
      ["#general", "org", undefined, []],
      ["#founders", "members", true, ["discord:201", "discord:202"]],
      ["#general › pricing", "org", undefined, []],
    ]);
    expect(calls.find((c) => c.path === "channels/301/messages")!.query).toEqual({ before: (BigInt(M2) + BigInt(1)).toString(), limit: 100 });
    // A short page reaches the start of the channel: the week before the cursor was read whole.
    expect(r.threads[0].complete).toEqual({ from: new Date(Date.parse("2026-11-01T10:05:00Z") - 7 * 86_400_000), to: new Date("2026-11-01T10:05:00Z") });
    expect(r.messages.filter((m) => m.threadExternalId === "301").map((m) => m.text)).toEqual(["Pricing call at 5", "works for me @Sumedh Kudav"]);
    expect(r.cursor.rereadAt).toBe(NOW.toISOString());
  });

  it("claims nothing was deleted when a re-read comes back empty or stops at the page cap", async () => {
    // Without Read Message History Discord answers with an empty list rather than an error.
    const empty = fakeApi({ ...base(true), "channels/301/messages": () => [] });
    const none = await fetchDiscord(empty.api, G, { after: { "301": M2 }, archivedAt: NOW.toISOString() }, NOW);
    expect(none.threads.find((t) => t.externalId === "301")).toMatchObject({ title: "#general", complete: undefined });

    // A busy channel: two full pages don't reach a week back, so only the part actually read is vouched for.
    const start = Date.parse("2026-11-01T10:05:00Z");
    const busy = fakeApi({
      ...base(true),
      "channels/301/messages": (q: Record<string, unknown>) => {
        const before = Number((BigInt(String(q.before)) >> BigInt(22)) + BigInt(1420070400000));
        return Array.from({ length: 100 }, (_, i) => msg(snowflakeAt(before - (i + 1) * 60_000), JASH, `line ${i}`));
      },
    });
    const part = await fetchDiscord(busy.api, G, { after: { "301": M2 }, archivedAt: NOW.toISOString() }, NOW);
    // 200 messages a minute apart were read; the stretch starts a second after the oldest of them.
    expect(part.threads[0].complete).toEqual({ from: new Date(start - 200 * 60_000 + 1000), to: new Date(start) });
    expect(part.messages.filter((m) => m.threadExternalId === "301")).toHaveLength(200);
  });

  it("hides a channel read before once its audience can't be worked out", async () => {
    const { api: a } = api(false);
    const r = await fetchDiscord(a, G, { after: { "302": at("2026-10-01T00:00:00Z") }, archivedAt: NOW.toISOString(), rereadAt: NOW.toISOString() }, NOW);
    expect(r.threads.find((t) => t.externalId === "302")).toMatchObject({ visibility: "members", memberKeys: [], membersComplete: true });
    expect(r.messages.some((m) => m.threadExternalId === "302")).toBe(false);
  });

  it("skips restricted channels when the member list can't be read, rather than guessing", async () => {
    const { api: a } = api(false);
    const r = await fetchDiscord(a, G, {}, NOW);
    expect(r.threads.map((t) => t.title)).toEqual(["#general", "#general › pricing"]);
    expect(r.skipped).toEqual([expect.objectContaining({ id: "302", name: "founders" })]);
    expect(r.cursor.after!["302"]).toBeUndefined();
  });

  it("gives a private thread to its members and those who manage threads", async () => {
    const P = at("2026-11-01T13:00:00Z");
    const routes = base(true);
    const { api: a } = fakeApi({
      ...routes,
      [`guilds/${G}/threads/active`]: () => ({ threads: [{ id: P, type: 12, name: "hiring", parent_id: "301", last_message_id: P }] }),
      [`channels/${P}/thread-members`]: () => [{ user_id: "203" }],
      [`channels/${P}/messages`]: () => [msg(P, user("203", "rohan"), "Offer sent")],
      "channels/*": () => ({ threads: [] }),
    });
    const r = await fetchDiscord(a, G, { archivedAt: NOW.toISOString() }, NOW);
    const t = r.threads.find((x) => x.externalId === P)!;
    // Rohan joined; Sumedh owns the server (all permissions). Jash is neither.
    expect([t.visibility, t.memberKeys.sort()]).toEqual(["members", ["discord:201", "discord:203"]]);
  });

  it("identify names the server and checks the bot is in it", async () => {
    const { api: a, calls } = fakeApi({ "users/@me": () => ({ id: "299" }), [`guilds/${G}`]: () => ({ id: G, name: "ALRO" }) });
    expect(await discord.identify(a, { token: "x", guildId: ` ${G} ` })).toEqual({ accountId: G, label: "ALRO" });
    expect(calls.map((c) => c.path)).toEqual(["users/@me", `guilds/${G}`]);

    const notIn = fakeApi({ "users/@me": () => ({ id: "299" }) });
    await expect(discord.identify(notIn.api, { token: "x", guildId: G })).rejects.toThrow(/isn't in that server/);
    const badToken = fakeApi({
      "users/@me": () => {
        throw new ProviderError("401", 401);
      },
    });
    await expect(discord.identify(badToken.api, { token: "x", guildId: G })).rejects.toThrow(/didn't accept that bot token/);
    await expect(discord.identify(a, { token: "x", guildId: "my server" })).rejects.toThrow(/server ID/);
  });

  it("waits as long as a 429 asks before trying again", async () => {
    const waits: number[] = [];
    let n = 0;
    const flaky: Api = async () => {
      if (n++ === 0) throw new ProviderError('GET discord.com/api/v10/x: 429 {"message": "You are being rate limited.", "retry_after": 2.5, "global": false}', 429);
      return { ok: true } as never;
    };
    expect(await honourRetryAfter(flaky, 3, async (ms) => void waits.push(ms))("GET", "x")).toEqual({ ok: true });
    expect(waits).toEqual([2600]);
  });

  it("computes snowflakes from timestamps", () => {
    expect(snowflakeAt(1420070400000)).toBe("0");
    expect(BigInt(snowflakeAt(Date.parse("2026-11-01T00:00:00Z"))) >> BigInt(22)).toBe(BigInt(Date.parse("2026-11-01T00:00:00Z") - 1420070400000));
  });
});
