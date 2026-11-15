import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { htmlToText, teams } from "./teams";

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
const ctx = { credentials: {}, accountId: "sumedh@example.com", now: NOW };

const ONE = "19:u1_u2@unq.gbl.spaces";
const GROUP = "19:group@thread.v2";
const MEETING = "19:meeting_abc@thread.v2";
const LEFT = "19:left@thread.v2";
const messagesOf = (chatId: string) => `me/chats/${encodeURIComponent(chatId)}/messages`;
const NEXT = `https://graph.microsoft.com/v1.0/chats/${GROUP}/messages?$skiptoken=abc`;

const member = (userId: string, displayName: string, email?: string) => ({ "@odata.type": "#microsoft.graph.aadUserConversationMember", userId, displayName, email });
const sumedh = member("u1", "Sumedh Kudav", "Sumedh@example.com");
const jash = member("u2", "Jash Doshi", "jash@example.com");
const priya = member("u3", "Priya Nair");

const message = (id: string, at: string, userId: string | null, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  messageType: "message",
  createdDateTime: at,
  lastModifiedDateTime: at,
  lastEditedDateTime: null,
  deletedDateTime: null,
  from: userId ? { application: null, user: { id: userId, displayName: userId === "u2" ? "Jash Doshi" : "Someone" } } : null,
  body: { contentType: "html", content },
  attachments: [],
  ...extra,
});

const routes = {
  me: () => ({ mail: "Sumedh@example.com", userPrincipalName: "sumedh@example.onmicrosoft.com" }),
  "me/chats": () => ({
    value: [
      { id: ONE, topic: null, chatType: "oneOnOne", webUrl: "https://teams.microsoft.com/l/chat/one", members: [sumedh, jash] },
      { id: GROUP, topic: "Launch crew", chatType: "group", webUrl: "https://teams.microsoft.com/l/chat/group", members: [sumedh, jash, priya] },
      { id: MEETING, topic: "Weekly sync", chatType: "meeting", members: [sumedh, priya, { displayName: "Guest" }] },
      { id: LEFT, topic: "Old project", chatType: "group", members: [sumedh] },
    ],
  }),
  [messagesOf(ONE)]: () => ({
    value: [
      message("1003", "2026-11-01T10:05:00.5Z", "u2", "<p>Deck is <b>ready</b>&nbsp;&amp; sent.</p><attachment id=\"f1\"></attachment>", {
        attachments: [{ id: "f1", contentType: "reference", contentUrl: "https://example.sharepoint.com/deck.pptx", name: "deck.pptx" }],
      }),
      message("1002", "2026-11-01T10:01:00.25Z", "u1", "gone", { deletedDateTime: "2026-11-01T10:02:00Z" }),
      message("1001", "2026-11-01T10:00:00Z", "u1", "Can you send the deck?", { body: { contentType: "text", content: "Can you send the deck?" }, lastEditedDateTime: "2026-11-01T10:00:30Z" }),
    ],
  }),
  [messagesOf(GROUP)]: () => ({
    value: [message("2002", "2026-10-30T09:00:00Z", "u9", "<div>Launch moved to <at id=\"0\">Jash Doshi</at><br>Friday</div>")],
    "@odata.nextLink": NEXT,
  }),
  [NEXT]: () => ({
    value: [
      message("2001", "2026-10-29T09:00:00Z", "u3", "<p>Venue is booked</p>"),
      { ...message("2000", "2026-10-28T09:00:00Z", null, "<systemEventMessage/>"), messageType: "systemEventMessage" },
    ],
  }),
  [messagesOf(MEETING)]: () => ({ value: [message("3001", "2026-10-27T09:00:00Z", "u3", "<attachment id=\"c1\"></attachment>")] }),
  [messagesOf(LEFT)]: () => {
    throw new ProviderError("GET graph.microsoft.com/v1.0/me/chats/…/messages: 403 Forbidden", 403);
  },
};

describe("Teams", () => {
  it("reads each chat's last 90 days into one thread per chat, visible to its members", async () => {
    const { api, calls } = fakeApi(routes);
    const found = await teams.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      { externalId: ONE, kind: "dm", title: "Jash Doshi", url: "https://teams.microsoft.com/l/chat/one", visibility: "members", memberKeys: ["teams:u1", "teams:u2"], metadata: { chatType: "oneOnOne" } },
      { externalId: GROUP, kind: "group_dm", title: "Launch crew", url: "https://teams.microsoft.com/l/chat/group", visibility: "members", memberKeys: ["teams:u1", "teams:u2", "teams:u3"], metadata: { chatType: "group" } },
    ]);
    expect(found.messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      [ONE, `${ONE}:1001`, "chat", "teams:u1", "Can you send the deck?", "2026-11-01T10:00:00.000Z"],
      [ONE, `${ONE}:1003`, "chat", "teams:u2", "Deck is ready & sent.", "2026-11-01T10:05:00.500Z"],
      [GROUP, `${GROUP}:2001`, "chat", "teams:u3", "Venue is booked", "2026-10-29T09:00:00.000Z"],
      [GROUP, `${GROUP}:2002`, "chat", "teams:u9", "Launch moved to Jash Doshi\nFriday", "2026-10-30T09:00:00.000Z"],
    ]);
    expect(found.messages![0].editedAt).toEqual(new Date("2026-11-01T10:00:30Z"));
    expect(found.messages![1].attachments).toEqual([{ name: "deck.pptx", url: "https://example.sharepoint.com/deck.pptx" }]);
    expect(found.people).toEqual([
      { key: "teams:u1", provider: "teams", externalId: "u1", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "teams:u2", provider: "teams", externalId: "u2", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "teams:u3", provider: "teams", externalId: "u3", displayName: "Priya Nair", email: undefined },
      { key: "teams:u9", provider: "teams", externalId: "u9", displayName: "Someone", email: undefined },
    ]);
    expect(found.cursor).toEqual({
      latest: { [ONE]: "2026-11-01T10:05:00.5Z", [GROUP]: "2026-10-30T09:00:00Z", [MEETING]: "2026-10-27T09:00:00Z" },
    });

    expect(calls.find((c) => c.path === "me/chats")!.query).toEqual({ $expand: "members", $top: 50 });
    expect(calls.find((c) => c.path === messagesOf(ONE))!.query).toEqual({ $top: 50, $orderby: "lastModifiedDateTime desc", $filter: "lastModifiedDateTime gt 2026-08-04T12:00:00.000Z" });
    expect(calls.find((c) => c.path === NEXT)!.query).toEqual({});
  });

  it("asks each chat only for what changed since its cursor", async () => {
    const { api, calls } = fakeApi({ ...routes, [messagesOf(ONE)]: () => ({ value: [] }) });
    const found = await teams.sync!(api, { latest: { [ONE]: "2026-11-01T10:05:00.5Z" } }, ctx);
    expect(calls.find((c) => c.path === messagesOf(ONE))!.query.$filter).toBe("lastModifiedDateTime gt 2026-11-01T10:00:00.500Z");
    expect(calls.find((c) => c.path === messagesOf(GROUP))!.query.$filter).toBe("lastModifiedDateTime gt 2026-08-04T12:00:00.000Z");
    expect(found.threads!.map((t) => t.externalId)).toEqual([GROUP]);
    expect((found.cursor.latest as Record<string, string>)[ONE]).toBe("2026-11-01T10:05:00.5Z");
  });

  it("stops opening chats once a sync has 2000 messages, leaving the rest for the next one", async () => {
    const chats = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, topic: `Chat ${i}`, chatType: "group", members: [sumedh] }));
    const full = (page: number) => ({
      value: Array.from({ length: 50 }, (_, i) => message(`${page}-${i}`, "2026-11-01T10:00:00Z", "u1", "hello")),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/more?page=${page + 1}`,
    });
    const { api, calls } = fakeApi({
      "me/chats": () => ({ value: chats }),
      "me/chats/*": () => full(0),
      "https://graph.microsoft.com/v1.0/more*": () => full(1),
    });
    const found = await teams.sync!(api, undefined, ctx);
    expect(found.messages).toHaveLength(2000);
    expect(calls.filter((c) => c.path.startsWith("me/chats/")).map((c) => c.path)).toEqual(["me/chats/c0/messages", "me/chats/c1/messages", "me/chats/c2/messages", "me/chats/c3/messages"]);
    expect(Object.keys(found.cursor.latest as object)).toEqual(["c0", "c1", "c2", "c3"]);
  });

  it("reduces HTML bodies to plain text", () => {
    expect(htmlToText("<p>Hi <at id=\"0\">Jash</at>,</p>\n<p>1 &lt; 2 &#38; 3&#x20;&gt; 2 <emoji id=\"smile\" alt=\"🙂\" title=\"Smile\"></emoji></p><ul><li>one</li><li>two</li></ul>")).toBe("Hi Jash,\n1 < 2 & 3 > 2 🙂\none\ntwo");
    expect(htmlToText("<systemEventMessage/>")).toBe("");
  });

  it("identifies the account, and says so plainly when access is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await teams.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });

    const refused = fakeApi({
      me: () => {
        throw new ProviderError("GET graph.microsoft.com/v1.0/me: 403 Forbidden", 403);
      },
    });
    await expect(teams.identify(refused.api, {})).rejects.toThrow("Microsoft didn't allow access to Teams.");
  });
});
