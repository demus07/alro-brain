import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { domainOf, fetchFreshdesk, freshdesk, toHtml } from "./freshdesk";

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
const DOMAIN = "acme.freshdesk.com";
const ctx = { accountId: "freshdesk:acme", credentials: { domain: DOMAIN, key: "k" } };
const opts = { toolCallId: "t", messages: [], context: {} };

const customer = { id: 1, name: "Priya Shah", email: "Priya@Customer.com", mobile: null, phone: null };
const agents = [
  { id: 2, contact: { name: "Jash Doshi", email: "jash@example.com" } },
  { id: 3, contact: { name: "Sumedh Kudav", email: "sumedh@example.com" } },
];

const ticket = (id: number, subject: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject,
  description_text: "The invoice PDF shows the wrong GST number.",
  status: 2,
  priority: 3,
  type: "Problem",
  tags: ["billing", "gst"],
  group_id: 10,
  responder_id: 2,
  requester_id: 1,
  company_id: 50,
  due_by: "2026-11-20T00:00:00Z",
  spam: false,
  created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  requester: customer,
  ...extra,
});
const convo = (id: number, user: number, text: string, created: string, extra: Record<string, unknown> = {}) => ({ id, user_id: user, body_text: text, private: false, incoming: false, source: 0, created_at: created, ...extra });

const routes = {
  agents: () => agents,
  groups: () => [{ id: 10, name: "Billing" }],
  "companies/50": () => ({ id: 50, name: "Shah Traders" }),
  tickets: () => [ticket(123, "Wrong GST on invoice"), ticket(124, "Spam offer", { spam: true }), ticket(125, "Refund please", { updated_at: "2026-11-01T11:00:00Z", company_id: null, group_id: null })],
  "tickets/123/conversations": () => [
    convo(9001, 1, "Any update?", "2026-10-30T09:30:00Z", { incoming: true, from_email: '"Priya Shah" <priya@customer.com>' }),
    convo(9002, 2, "Thanks Priya, fixing it today.", "2026-10-30T10:00:00Z"),
    convo(9003, 3, "Template bug, same as last month.", "2026-10-30T11:00:00Z", { private: true, source: 2 }),
    convo(9004, 77, "Looping in our CA.", "2026-10-30T12:00:00Z", { incoming: true, from_email: "ca@customer.com" }),
  ],
  "tickets/125/conversations": () => [],
};

describe("Freshdesk", () => {
  afterEach(() => vi.useRealTimers());

  it("maps tickets, replies and private notes on the first sync, visible to the whole company", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchFreshdesk(api, DOMAIN, undefined, NOW, 0);

    expect(r.threads).toEqual([
      { externalId: "123", kind: "doc", title: "#123 Wrong GST on invoice", url: "https://acme.freshdesk.com/a/tickets/123", visibility: "org", memberKeys: [] },
      { externalId: "125", kind: "doc", title: "#125 Refund please", url: "https://acme.freshdesk.com/a/tickets/125", visibility: "org", memberKeys: [] },
    ]);
    const mine = r.messages!.filter((m) => m.threadExternalId === "123");
    expect(mine[0]).toMatchObject({ externalId: "123@2026-11-01T10:00:00Z", kind: "note", authorKey: "freshdesk:1", subject: "#123 Wrong GST on invoice" });
    expect(mine[0].text).toBe(
      "#123 Wrong GST on invoice\nStatus: open\nPriority: high\nType: Problem\nRequester: Priya Shah (priya@customer.com)\nCompany: Shah Traders\nAgent: Jash Doshi\nGroup: Billing\nTags: billing, gst\nDue: 2026-11-20\nCreated: 2026-10-30\n\nThe invoice PDF shows the wrong GST number.",
    );
    expect(mine.slice(1).map((m) => [m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["9001", "chat", "freshdesk:1", "Any update?", "2026-10-30T09:30:00.000Z"],
      ["9002", "chat", "freshdesk:2", "Thanks Priya, fixing it today.", "2026-10-30T10:00:00.000Z"],
      ["9003", "chat", "freshdesk:3", "Internal note: Template bug, same as last month.", "2026-10-30T11:00:00.000Z"],
      ["9004", "chat", "freshdesk:77", "Looping in our CA.", "2026-10-30T12:00:00.000Z"],
    ]);
    expect(r.versions).toEqual(new Map([["123", "123@2026-11-01T10:00:00Z"], ["125", "125@2026-11-01T11:00:00Z"]]));
    expect(r.people).toContainEqual({ key: "freshdesk:1", provider: "freshdesk", externalId: "1", displayName: "Priya Shah", email: "priya@customer.com" });
    expect(r.people).toContainEqual({ key: "freshdesk:77", provider: "freshdesk", externalId: "77", displayName: "ca@customer.com", email: "ca@customer.com" });
    expect(r.people!.map((p) => p.key).sort()).toEqual(["freshdesk:1", "freshdesk:2", "freshdesk:3", "freshdesk:77"]);

    const list = calls.find((c) => c.path === "tickets")!;
    expect(list.query).toEqual({ updated_since: "2026-08-04T12:00:00Z", order_by: "updated_at", order_type: "asc", per_page: 100, page: 1, include: "requester,description" });
    expect(calls.some((c) => c.path === "tickets/124/conversations")).toBe(false);
    expect(r.cursor).toEqual({ since: "2026-11-01T11:00:00Z" });
  });

  it("asks only for tickets changed since the cursor, with an overlap", async () => {
    const { api, calls } = fakeApi({ agents: () => [], groups: () => [], tickets: () => [] });
    const r = await fetchFreshdesk(api, DOMAIN, { since: "2026-11-01T11:00:00Z" }, NOW, 0);
    expect(calls.filter((c) => c.path === "tickets").map((c) => c.query.updated_since)).toEqual(["2026-11-01T10:55:00Z"]);
    expect(r.cursor).toEqual({ since: "2026-11-01T11:00:00Z" });
  });

  it("stops at the cap and continues from the newest ticket read", async () => {
    let n = 0;
    const page = () => Array.from({ length: 100 }, () => ticket(++n, `T${n}`, { updated_at: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 1000).toISOString().replace(".000", "") }));
    const { api, calls } = fakeApi({ ...routes, tickets: page, "tickets/*": () => [] });
    const r = await fetchFreshdesk(api, DOMAIN, undefined, NOW, 0);
    expect(calls.filter((c) => c.path === "tickets").map((c) => c.query.page)).toEqual([1, 2]);
    expect(r.threads).toHaveLength(200);
    expect(r.cursor).toEqual({ since: "2026-10-01T00:03:20Z", more: true });

    // The next sync starts exactly there, no overlap.
    const next = fakeApi({ agents: () => [], groups: () => [], tickets: () => [] });
    await fetchFreshdesk(next.api, DOMAIN, r.cursor, NOW, 0);
    expect(next.calls.find((c) => c.path === "tickets")!.query).toMatchObject({ updated_since: "2026-10-01T00:03:20Z", page: 1 });
  });

  it("pages on when a whole capped sync is tickets changed in the same second", async () => {
    const same = "2026-10-01T00:00:00Z";
    let n = 0;
    const { api, calls } = fakeApi({
      ...routes,
      tickets: () => Array.from({ length: 100 }, () => ticket(++n, `T${n}`, { updated_at: same })),
      "tickets/*": () => [],
    });
    const r = await fetchFreshdesk(api, DOMAIN, { since: same, more: true }, NOW, 0);
    expect(r.cursor).toEqual({ since: same, more: true, page: 3 });
    const next = fakeApi({ agents: () => [], groups: () => [], tickets: () => [] });
    const done = await fetchFreshdesk(next.api, DOMAIN, r.cursor, NOW, 0);
    expect(next.calls.find((c) => c.path === "tickets")!.query).toMatchObject({ updated_since: same, page: 3 });
    expect(done.cursor).toEqual({ since: same });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("validates the helpdesk address", () => {
    expect(domainOf({ domain: "https://Acme.freshdesk.com/a/tickets" })).toBe(DOMAIN);
    expect(domainOf({ domain: "acme" })).toBe(DOMAIN);
    expect(() => domainOf({ domain: "support.acme.com" })).toThrow("acme.freshdesk.com");
    expect(() => domainOf({ domain: "evil.com/x.freshdesk.com" })).toThrow();
  });

  it("identifies the helpdesk; refuses a bad key and agents without global access", async () => {
    const ok = fakeApi({ "agents/me": () => ({ id: 3, ticket_scope: 1, contact: { name: "Sumedh Kudav" } }) });
    expect(await freshdesk.identify(ok.api, ctx.credentials)).toEqual({ accountId: "freshdesk:acme", label: DOMAIN });
    const bad = fakeApi({
      "agents/me": () => {
        throw new ProviderError("invalid_credentials", 401);
      },
    });
    await expect(freshdesk.identify(bad.api, ctx.credentials)).rejects.toThrow("Freshdesk didn't accept that API key.");
    const group = fakeApi({ "agents/me": () => ({ id: 4, ticket_scope: 2 }) });
    await expect(freshdesk.identify(group.api, ctx.credentials)).rejects.toThrow("Global ticket access");
  });

  it("lists open tickets for a requester, live", async () => {
    vi.useFakeTimers({ now: NOW });
    const { api, calls } = fakeApi({
      tickets: () => [ticket(123, "Wrong GST on invoice"), ticket(130, "Old one", { status: 5 }), ticket(131, "Late", { status: 3, due_by: "2026-10-01T00:00:00Z" })],
    });
    const tools = freshdesk.tools!(api, ctx);
    const r = await tools.freshdesk_tickets.execute!({ requester_email: "Priya@Customer.com" }, opts);
    expect(calls[0].query).toMatchObject({ email: "priya@customer.com", order_by: "updated_at", include: "requester", updated_since: "2025-11-02T12:00:00Z" });
    expect(r).toEqual({
      total: 2,
      tickets: [
        {
          id: 123,
          subject: "Wrong GST on invoice",
          status: "open",
          priority: "high",
          requester: { name: "Priya Shah", email: "priya@customer.com" },
          due: "2026-11-20T00:00:00Z",
          overdue: false,
          updated: "2026-11-01T10:00:00Z",
          url: "https://acme.freshdesk.com/a/tickets/123",
        },
        expect.objectContaining({ id: 131, status: "pending", overdue: true }),
      ],
    });

    const overdue = await tools.freshdesk_tickets.execute!({ status: "overdue", requester_email: "priya@customer.com" }, opts);
    expect(overdue).toMatchObject({ total: 1, tickets: [{ id: 131 }] });
  });

  it("searches when there's no requester or company, and finds a company by name", async () => {
    vi.useFakeTimers({ now: NOW });
    const { api, calls } = fakeApi({
      "search/tickets": () => ({ total: 1, results: [ticket(131, "Late", { status: 3, due_by: "2026-10-01T00:00:00Z", requester: undefined })] }),
      "companies/autocomplete": () => ({ companies: [{ id: 50, name: "Shah Traders" }] }),
      tickets: () => [],
    });
    const tools = freshdesk.tools!(api, ctx);
    await tools.freshdesk_tickets.execute!({ status: "overdue" }, opts);
    expect(calls[0]).toMatchObject({ path: "search/tickets", query: { query: `"(status:2 OR status:3) AND due_by:<'2026-11-02'"` } });
    await tools.freshdesk_tickets.execute!({ company: "Shah" }, opts);
    expect(calls[1]).toMatchObject({ path: "companies/autocomplete", query: { name: "Shah" } });
    expect(calls[2]).toMatchObject({ path: "tickets", query: { company_id: 50 } });
  });

  it("falls back to the plain listing if Freshdesk refuses updated_since with a filter", async () => {
    const { api, calls } = fakeApi({
      tickets: (q) => {
        if (q.updated_since) throw new ProviderError("invalid_field", 400);
        return [ticket(123, "Wrong GST on invoice")];
      },
    });
    const r = await freshdesk.tools!(api, ctx).freshdesk_tickets.execute!({ requester_email: "priya@customer.com" }, opts);
    expect(calls.map((c) => c.query.updated_since === undefined)).toEqual([false, true]);
    expect(r).toMatchObject({ total: 1 });
  });

  it("reads one ticket with its latest conversation", async () => {
    vi.useFakeTimers({ now: NOW });
    const { api, calls } = fakeApi({
      "tickets/123": () => ticket(123, "Wrong GST on invoice", { company: { id: 50, name: "Shah Traders" } }),
      "tickets/123/conversations": routes["tickets/123/conversations"],
    });
    const r = await freshdesk.tools!(api, ctx).freshdesk_ticket.execute!({ ticket_id: 123 }, opts);
    expect(calls[0]).toMatchObject({ path: "tickets/123", query: { include: "requester,company" } });
    expect(r).toMatchObject({ id: 123, company: "Shah Traders", description: "The invoice PDF shows the wrong GST number.", conversation_count: 4 });
    expect((r as { latest: unknown[] }).latest[2]).toEqual({ at: "2026-10-30T11:00:00Z", by: "agent", from: undefined, private_note: true, text: "Template bug, same as last month." });
  });

  it("posts an approved reply and a private note", async () => {
    const { api, calls } = fakeApi({ "tickets/123/reply": () => ({ id: 1 }), "tickets/123/notes": () => ({ id: 2 }) });
    const reply = freshdesk.actions!.freshdesk_reply;
    const input = reply.input.parse({ ticket_id: 123, body: "Hi Priya,\n\nFixed <today>." });
    expect(reply.audience(input)).toBe("external");
    expect(reply.summary(input)).toBe("Freshdesk reply to the requester on ticket #123");
    expect(reply.withBody!(input, "Edited")).toEqual({ ticket_id: 123, body: "Edited" });
    expect(await reply.run(api, input, ctx)).toEqual({ url: "https://acme.freshdesk.com/a/tickets/123", detail: "Replied on Freshdesk ticket #123." });
    expect(calls[0]).toEqual({ method: "POST", path: "tickets/123/reply", query: {}, body: { body: "<p>Hi Priya,</p><p>Fixed &lt;today&gt;.</p>" } });

    const note = freshdesk.actions!.freshdesk_add_note;
    expect(note.audience({ ticket_id: 123, body: "x" })).toBe("internal");
    await note.run(api, { ticket_id: 123, body: "Same bug\nas before" }, ctx);
    expect(calls[1]).toEqual({ method: "POST", path: "tickets/123/notes", query: {}, body: { body: toHtml("Same bug\nas before"), private: true } });
    expect(toHtml("Same bug\nas before")).toBe("<p>Same bug<br>as before</p>");
  });
});
