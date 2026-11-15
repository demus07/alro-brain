import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchZendesk, zendesk } from "./zendesk";

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
const EXPORT = "incremental/tickets/cursor.json";
const unix = (iso: string) => Date.parse(iso) / 1000;

const customer = { id: 1, name: "Priya Shah", email: "Priya@Customer.com", role: "end-user" };
const agent = { id: 2, name: "Jash Doshi", email: "jash@example.com", role: "agent" };
const lead = { id: 3, name: "Sumedh Kudav", email: "sumedh@example.com", role: "admin" };

const ticket = (id: number, subject: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject,
  description: "The invoice PDF shows the wrong GST number.",
  status: "open",
  priority: "high",
  type: "problem",
  tags: ["billing", "gst"],
  group_id: 10,
  organization_id: 50,
  requester_id: 1,
  assignee_id: 2,
  due_at: "2026-11-20T00:00:00Z",
  created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  ...extra,
});
const comment = (id: number, author: number, text: string, created: string, isPublic = true) => ({ id, author_id: author, body: text, plain_body: text, public: isPublic, created_at: created });

const routes = {
  [EXPORT]: () => ({
    tickets: [ticket(123, "Wrong GST on invoice"), ticket(124, "Refund dispute", { group_id: 11, updated_at: "2026-11-01T11:00:00Z" }), ticket(125, "Legal hold", { group_id: 12 })],
    users: [customer, agent],
    groups: [
      { id: 10, name: "Support", is_public: true },
      { id: 11, name: "Finance", is_public: false },
      { id: 12, name: "Legal", is_public: false },
    ],
    organizations: [{ id: 50, name: "Shah Traders" }],
    after_cursor: "c1",
    end_of_stream: true,
  }),
  "tickets/123/comments.json": () => ({
    comments: [
      comment(9001, 1, "The invoice PDF shows the wrong GST number.", "2026-10-30T09:00:00Z"),
      comment(9002, 2, "Thanks Priya, fixing it today.", "2026-10-30T10:00:00Z"),
      comment(9003, 3, "Template bug, same as last month.", "2026-10-30T11:00:00Z", false),
    ],
    users: [customer, agent, lead],
    meta: { has_more: false },
  }),
  "tickets/124/comments.json": () => ({ comments: [comment(9010, 1, "Please refund order 88.", "2026-11-01T11:00:00Z")], users: [customer], meta: { has_more: false } }),
  "groups/11/users.json": () => ({ users: [lead], meta: { has_more: false } }),
};

describe("Zendesk", () => {
  it("maps tickets and comments on the first sync; private-group tickets go to that group only", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchZendesk(api, "acme", undefined, NOW, 0);

    expect(r.threads).toEqual([
      { externalId: "123", kind: "doc", title: "#123 Wrong GST on invoice", url: "https://acme.zendesk.com/agent/tickets/123", visibility: "org", memberKeys: [] },
      { externalId: "124", kind: "doc", title: "#124 Refund dispute", url: "https://acme.zendesk.com/agent/tickets/124", visibility: "members", memberKeys: ["zendesk:3"] },
    ]);
    const mine = r.messages!.filter((m) => m.threadExternalId === "123");
    expect(mine[0]).toMatchObject({ externalId: "123@2026-11-01T10:00:00Z", kind: "note", authorKey: "zendesk:1", subject: "#123 Wrong GST on invoice" });
    expect(mine[0].text).toBe(
      "#123 Wrong GST on invoice\nStatus: open\nPriority: high\nType: problem\nRequester: Priya Shah (priya@customer.com)\nOrganization: Shah Traders\nAssignee: Jash Doshi\nGroup: Support\nTags: billing, gst\nDue: 2026-11-20\nCreated: 2026-10-30\n\nThe invoice PDF shows the wrong GST number.",
    );
    expect(mine.slice(1).map((m) => [m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["9002", "chat", "zendesk:2", "Thanks Priya, fixing it today.", "2026-10-30T10:00:00.000Z"],
      ["9003", "chat", "zendesk:3", "Internal note: Template bug, same as last month.", "2026-10-30T11:00:00.000Z"],
    ]);
    expect(r.versions).toEqual(new Map([["123", "123@2026-11-01T10:00:00Z"], ["124", "124@2026-11-01T11:00:00Z"]]));
    expect(r.people).toContainEqual({ key: "zendesk:1", provider: "zendesk", externalId: "1", displayName: "Priya Shah", email: "priya@customer.com" });
    expect(r.people!.map((p) => p.key).sort()).toEqual(["zendesk:1", "zendesk:2", "zendesk:3"]);

    expect(calls[0]).toEqual({ path: EXPORT, query: { start_time: unix("2026-08-04T12:00:00Z"), per_page: 100, include: "users,groups,organizations", exclude_deleted: "true" } });
    expect(calls.some((c) => c.path === "tickets/125/comments.json")).toBe(false);
    expect(r.cursor).toEqual({ cursor: "c1", since: unix("2026-11-01T11:00:00Z") });
  });

  it("continues the export from the saved cursor", async () => {
    const { api, calls } = fakeApi({ [EXPORT]: () => ({ tickets: [], after_cursor: "c2", end_of_stream: true }) });
    const r = await fetchZendesk(api, "acme", { cursor: "c1", since: unix("2026-11-01T11:00:00Z") }, NOW, 0);
    expect(calls).toEqual([{ path: EXPORT, query: { cursor: "c1", per_page: 100, include: "users,groups,organizations", exclude_deleted: "true" } }]);
    expect(r.cursor).toEqual({ cursor: "c2", since: unix("2026-11-01T11:00:00Z") });
  });

  it("restarts by time, with an overlap, when the saved cursor is refused", async () => {
    const { api, calls } = fakeApi({
      [EXPORT]: (q) => {
        if (q.cursor) throw new ProviderError("invalid cursor", 400);
        return { tickets: [], after_cursor: "c9", end_of_stream: true };
      },
    });
    const r = await fetchZendesk(api, "acme", { cursor: "stale", since: unix("2026-11-01T11:00:00Z") }, NOW, 0);
    expect(calls[1].query.start_time).toBe(unix("2026-11-01T10:55:00Z"));
    expect(r.cursor).toEqual({ cursor: "c9", since: unix("2026-11-01T11:00:00Z") });
  });

  it("stops at the cap and keeps the cursor for the next sync", async () => {
    let n = 0;
    const { api, calls } = fakeApi({
      [EXPORT]: () => ({ tickets: [ticket(++n, `Ticket ${n}`)], users: [customer, agent], after_cursor: `c${n}`, end_of_stream: false }),
      "tickets/*": () => ({ comments: [], meta: { has_more: false } }),
    });
    const r = await fetchZendesk(api, "acme", undefined, NOW, 0);
    expect(calls.filter((c) => c.path === EXPORT).map((c) => c.query.cursor)).toEqual([undefined, "c1", "c2"]);
    expect(r.threads).toHaveLength(3);
    expect(r.cursor).toMatchObject({ cursor: "c3" });
  });

  it("identifies the account; refuses anonymous and non-admin users", async () => {
    const credentials = { subdomain: "https://Acme.zendesk.com/agent", email: "s@example.com", token: "t" };
    const ok = fakeApi({ "users/me.json": () => ({ user: { id: 3, name: "Sumedh Kudav", role: "admin" } }) });
    expect(await zendesk.identify(ok.api, credentials)).toEqual({ accountId: "zendesk:acme", label: "acme.zendesk.com" });
    expect(ok.calls.map((c) => c.path)).toEqual(["users/me.json"]);

    const anonymous = fakeApi({ "users/me.json": () => ({ user: { id: null, name: "Anonymous user", role: "end-user" } }) });
    await expect(zendesk.identify(anonymous.api, credentials)).rejects.toThrow("Zendesk didn't accept that email and API token.");
    const agentOnly = fakeApi({ "users/me.json": () => ({ user: { id: 2, role: "agent" } }) });
    await expect(zendesk.identify(agentOnly.api, credentials)).rejects.toThrow("isn't an admin");
  });
});
