import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchIntercom, intercom, regionOf } from "./intercom";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { method: string; path: string; query: Record<string, unknown>; body?: unknown }[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query, ...(opts.body === undefined ? {} : { body: opts.body }) });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;
const ctx = { accountId: "intercom:abc123", credentials: { token: "t", region: "" } };
const opts = { toolCallId: "t", messages: [], context: {} };
const SEARCH = "conversations/search";

const priya = { type: "user", id: "c1", name: "Priya Shah", email: "Priya@Customer.com" };
const jash = { type: "admin", id: "11", name: "Jash Doshi", email: "jash@example.com" };
const sumedh = { type: "admin", id: "12", name: "Sumedh Kudav", email: "sumedh@example.com" };

const summary = (id: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: null,
  state: "open",
  created_at: unix("2026-10-30T09:00:00Z"),
  updated_at: unix(updated),
  admin_assignee_id: 11,
  source: { type: "conversation", subject: "", body: "<p>The invoice PDF shows the wrong GST number.</p>", author: priya },
  ...extra,
});
const part = (id: string, type: string, author: unknown, body: string | null, at: string) => ({ id, part_type: type, author, body, created_at: unix(at) });

const routes = {
  admins: () => ({ type: "admin.list", admins: [jash, sumedh] }),
  [SEARCH]: () => ({ conversations: [summary("501", "2026-11-01T10:00:00Z"), summary("502", "2026-11-01T11:00:00Z"), summary("503", "2026-11-01T11:30:00Z")], total_count: 3, pages: {} }),
  "conversations/501": () => ({
    ...summary("501", "2026-11-01T10:00:00Z", { priority: "high", tags: { tags: [{ name: "billing" }] } }),
    title: "Wrong GST on invoice",
    source: { type: "conversation", subject: "", body: "The invoice PDF shows the wrong GST number.", author: priya },
    contacts: { contacts: [{ id: "c1", email: "priya@customer.com" }] },
    conversation_parts: {
      conversation_parts: [
        part("p1", "assignment", jash, null, "2026-10-30T09:05:00Z"),
        part("p2", "comment", jash, "Thanks Priya, fixing it today.", "2026-10-30T10:00:00Z"),
        part("p3", "note", sumedh, "Template bug, same as last month.", "2026-10-30T11:00:00Z"),
        part("p4", "comment", priya, "Great, thanks!", "2026-10-30T12:00:00Z"),
        part("p5", "unknown", jash, "something new", "2026-10-30T13:00:00Z"),
      ],
    },
  }),
  "conversations/502": () => ({ ...summary("502", "2026-11-01T11:00:00Z"), title: "", source: { type: "email", subject: "<p>Refund please</p>", body: "Order 88 arrived broken.", author: priya }, admin_assignee_id: 0 }),
  // The token's teammate can't open this one.
  "conversations/503": () => {
    throw new ProviderError("token_unauthorized", 403);
  },
};

describe("Intercom", () => {
  afterEach(() => vi.useRealTimers());

  it("maps conversations, replies and internal notes on the first sync", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchIntercom(api, "abc123", "us", undefined, NOW, 0);

    expect(r.threads).toEqual([
      { externalId: "501", kind: "doc", title: "Wrong GST on invoice", url: "https://app.intercom.com/a/inbox/abc123/inbox/conversation/501", visibility: "org", memberKeys: [] },
      { externalId: "502", kind: "doc", title: "Refund please", url: "https://app.intercom.com/a/inbox/abc123/inbox/conversation/502", visibility: "org", memberKeys: [] },
    ]);
    const mine = r.messages!.filter((m) => m.threadExternalId === "501");
    expect(mine[0]).toMatchObject({ externalId: `501@${unix("2026-11-01T10:00:00Z")}`, kind: "note", authorKey: "intercom:contact:c1", subject: "Wrong GST on invoice" });
    expect(mine[0].text).toBe(
      "Wrong GST on invoice\nState: open\nPriority: high\nContact: Priya Shah (priya@customer.com)\nAssignee: Jash Doshi\nTags: billing\nChannel: conversation\nStarted: 2026-10-30\n\nThe invoice PDF shows the wrong GST number.",
    );
    expect(mine.slice(1).map((m) => [m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["p2", "chat", "intercom:admin:11", "Thanks Priya, fixing it today.", "2026-10-30T10:00:00.000Z"],
      ["p3", "chat", "intercom:admin:12", "Internal note: Template bug, same as last month.", "2026-10-30T11:00:00.000Z"],
      ["p4", "chat", "intercom:contact:c1", "Great, thanks!", "2026-10-30T12:00:00.000Z"],
    ]);
    expect(r.messages!.find((m) => m.threadExternalId === "502")!.text).toContain("Channel: email\nStarted: 2026-10-30\n\nOrder 88 arrived broken.");
    expect(r.versions!.get("502")).toBe(`502@${unix("2026-11-01T11:00:00Z")}`);
    expect(r.people).toContainEqual({ key: "intercom:contact:c1", provider: "intercom", externalId: "contact:c1", displayName: "Priya Shah", email: "priya@customer.com" });
    expect(r.people).toContainEqual({ key: "intercom:admin:11", provider: "intercom", externalId: "admin:11", displayName: "Jash Doshi", email: "jash@example.com" });
    expect(r.people!.map((p) => p.key).sort()).toEqual(["intercom:admin:11", "intercom:admin:12", "intercom:contact:c1"]);

    const search = calls.find((c) => c.path === SEARCH)!;
    expect(search).toMatchObject({
      method: "POST",
      body: { query: { field: "updated_at", operator: ">", value: unix("2026-08-04T12:00:00Z") - 1 }, sort: { field: "updated_at", order: "ascending" }, pagination: { per_page: 150 } },
    });
    expect(calls.find((c) => c.path === "conversations/501")!.query).toEqual({ display_as: "plaintext" });
    expect(r.cursor).toEqual({ since: unix("2026-11-01T11:30:00Z") });
  });

  it("asks only for conversations changed since the cursor, with an overlap", async () => {
    const { api, calls } = fakeApi({ admins: () => ({ admins: [] }), [SEARCH]: () => ({ conversations: [], pages: {} }) });
    const r = await fetchIntercom(api, "abc123", "us", { since: unix("2026-11-01T11:30:00Z") }, NOW, 0);
    expect((calls.find((c) => c.path === SEARCH)!.body as { query: { value: number } }).query.value).toBe(unix("2026-11-01T11:25:00Z") - 1);
    expect(r.cursor).toEqual({ since: unix("2026-11-01T11:30:00Z") });
  });

  it("stops at the cap; pages on only when every conversation read changed in the same second", async () => {
    let n = 0;
    const same = "2026-10-01T00:00:00Z";
    const { api, calls } = fakeApi({
      admins: () => ({ admins: [] }),
      [SEARCH]: () => ({ conversations: [summary(String(++n), same)], pages: { next: { starting_after: `a${n}` } } }),
      "conversations/*": () => ({ conversation_parts: { conversation_parts: [] } }),
    });
    const r = await fetchIntercom(api, "abc123", "us", { since: unix(same), more: true }, NOW, 0);
    expect(calls.filter((c) => c.path === SEARCH).map((c) => (c.body as { pagination: { starting_after?: string } }).pagination.starting_after)).toEqual([undefined, "a1"]);
    expect(r.cursor).toEqual({ since: unix(same), more: true, after: "a2" });

    // A position Intercom has forgotten: the search starts again.
    const stale = fakeApi({
      admins: () => ({ admins: [] }),
      [SEARCH]: (_q, body) => {
        if ((body as { pagination: { starting_after?: string } }).pagination.starting_after) throw new ProviderError("invalid starting_after", 400);
        return { conversations: [summary("9", "2026-10-02T00:00:00Z")], pages: {} };
      },
      "conversations/*": () => ({ conversation_parts: { conversation_parts: [] } }),
    });
    const again = await fetchIntercom(stale.api, "abc123", "us", r.cursor, NOW, 0);
    expect(again.cursor).toEqual({ since: unix("2026-10-02T00:00:00Z") });
  });

  it("validates the region and pins the API version", async () => {
    expect(regionOf({})).toBe("us");
    expect(regionOf({ region: " EU " })).toBe("eu");
    expect(regionOf({ region: "https://api.au.intercom.io" })).toBe("au");
    expect(() => regionOf({ region: "ap" })).toThrow("US, EU or AU");
    const auth = intercom.auth;
    if (auth.kind !== "token") throw new Error("token auth expected");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await auth.api({ token: "tok", region: "eu" })("GET", "me");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.eu.intercom.io/me");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok", "intercom-version": "2.18" });
    fetchMock.mockRestore();
  });

  it("identifies the workspace; refuses a bad token", async () => {
    const ok = fakeApi({ me: () => ({ type: "admin", id: "12", name: "Sumedh Kudav", app: { id_code: "abc123", name: "Acme" } }) });
    expect(await intercom.identify(ok.api, ctx.credentials)).toEqual({ accountId: "intercom:abc123", label: "Acme" });
    const bad = fakeApi({
      me: () => {
        throw new ProviderError("unauthorized", 401);
      },
    });
    await expect(intercom.identify(bad.api, ctx.credentials)).rejects.toThrow("Intercom didn't accept that access token.");
  });

  it("lists open or snoozed conversations for a contact, live", async () => {
    const { api, calls } = fakeApi({
      "contacts/search": () => ({ data: [{ id: "c1", role: "user", email: "priya@customer.com" }] }),
      [SEARCH]: () => ({ conversations: [summary("501", "2026-11-01T10:00:00Z", { waiting_since: unix("2026-11-01T09:00:00Z") })], total_count: 1 }),
      admins: routes.admins,
    });
    const r = await intercom.tools!(api, ctx).intercom_conversations.execute!({ contact_email: "Priya@Customer.com" }, opts);
    expect(calls[0].body).toEqual({ query: { field: "email", operator: "=", value: "priya@customer.com" }, pagination: { per_page: 5 } });
    expect(calls[1].body).toEqual({
      query: {
        operator: "AND",
        value: [
          { field: "contact_ids", operator: "=", value: "c1" },
          {
            operator: "OR",
            value: [
              { field: "state", operator: "=", value: "open" },
              { field: "state", operator: "=", value: "snoozed" },
            ],
          },
        ],
      },
      sort: { field: "updated_at", order: "descending" },
      pagination: { per_page: 15 },
    });
    expect(r).toEqual({
      total: 1,
      conversations: [
        {
          id: "501",
          title: undefined,
          state: "open",
          contact: { name: "Priya Shah", email: "priya@customer.com" },
          assignee: "Jash Doshi",
          waiting_since: "2026-11-01T09:00:00.000Z",
          updated: "2026-11-01T10:00:00.000Z",
          first_message: "The invoice PDF shows the wrong GST number.",
          url: "https://app.intercom.com/a/inbox/abc123/inbox/conversation/501",
        },
      ],
    });
  });

  it("lists recent conversations of any state when asked", async () => {
    vi.useFakeTimers({ now: NOW });
    const { api, calls } = fakeApi({ [SEARCH]: () => ({ conversations: [] }), admins: () => ({ admins: [] }) });
    await intercom.tools!(api, ctx).intercom_conversations.execute!({ state: "any", limit: 5 }, opts);
    expect(calls[0].body).toMatchObject({ query: { field: "updated_at", operator: ">", value: unix("2026-10-03T12:00:00Z") }, pagination: { per_page: 5 } });
  });

  it("looks up a contact with their company and recent conversations", async () => {
    const { api, calls } = fakeApi({
      "contacts/search": () => ({ data: [{ id: "c1", role: "user", name: "Priya Shah", email: "priya@customer.com", created_at: unix("2025-01-01T00:00:00Z"), location: { city: "Pune", country: "India" } }] }),
      "contacts/c1/companies": () => ({ data: [{ name: "Shah Traders", website: "shah.example", plan: { name: "Pro" }, size: 12 }] }),
      [SEARCH]: () => ({ conversations: [summary("501", "2026-11-01T10:00:00Z")] }),
      admins: routes.admins,
    });
    const r = await intercom.tools!(api, ctx).intercom_contact.execute!({ email: "priya@customer.com" }, opts);
    expect(calls.find((c) => c.path === SEARCH)!.body).toMatchObject({ query: { field: "contact_ids", operator: "=", value: "c1" }, pagination: { per_page: 5 } });
    expect(r).toMatchObject({
      found: true,
      name: "Priya Shah",
      location: "Pune, India",
      signed_up: "2025-01-01T00:00:00.000Z",
      companies: [{ name: "Shah Traders", website: "shah.example", plan: "Pro", size: 12 }],
      recent_conversations: [{ id: "501", state: "open" }],
      url: "https://app.intercom.com/a/apps/abc123/users/c1/all-conversations",
    });
  });

  it("posts an approved reply and an internal note as the token's teammate", async () => {
    const { api, calls } = fakeApi({ me: () => ({ id: "12", name: "Sumedh Kudav" }), "conversations/501/reply": () => ({ type: "conversation" }) });
    const reply = intercom.actions!.intercom_reply;
    const input = reply.input.parse({ conversation_id: "501", body: "Hi Priya,\nFixed." });
    expect(reply.audience(input)).toBe("external");
    expect(reply.summary(input)).toBe("Intercom reply to the customer in conversation 501");
    expect(reply.withBody!(input, "Edited")).toEqual({ conversation_id: "501", body: "Edited" });
    const euCtx = { ...ctx, credentials: { token: "t", region: "eu" } };
    expect(await reply.run(api, input, euCtx)).toEqual({ url: "https://app.eu.intercom.com/a/inbox/abc123/inbox/conversation/501", detail: "Replied in Intercom conversation 501 as Sumedh Kudav." });
    expect(calls.slice(0, 2)).toEqual([
      { method: "GET", path: "me", query: {} },
      { method: "POST", path: "conversations/501/reply", query: {}, body: { message_type: "comment", type: "admin", admin_id: "12", body: "<p>Hi Priya,<br>Fixed.</p>" } },
    ]);

    const note = intercom.actions!.intercom_add_note;
    expect(note.audience({ conversation_id: "501", body: "x" })).toBe("internal");
    await note.run(api, { conversation_id: "501", body: "Same bug" }, ctx);
    expect(calls[3]).toEqual({ method: "POST", path: "conversations/501/reply", query: {}, body: { message_type: "note", type: "admin", admin_id: "12", body: "<p>Same bug</p>" } });
  });
});
