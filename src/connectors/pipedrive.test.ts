import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { audienceOf, domainOf, fetchPipedrive, pipedrive } from "./pipedrive";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { method: string; path: string; query: Record<string, unknown>; body?: unknown }[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query, body: opts.body });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-15T12:00:00Z");
const ctx = { accountId: "pipedrive:9", credentials: { domain: "acme", token: "t" } };
const opts = { toolCallId: "t", messages: [], context: {} };

const users = [
  { id: 10, name: "Jash Doshi", email: "Jash@Example.com" },
  { id: 11, name: "Sumedh Kudav", email: "sumedh@example.com" },
  { id: 12, name: "Riya Mehta", email: "riya@example.com" },
];
const deal = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: "Annual plan",
  owner_id: 10,
  person_id: 100,
  org_id: 200,
  stage_id: 5,
  pipeline_id: 1,
  value: 12000,
  currency: "INR",
  status: "open",
  visible_to: 3,
  expected_close_date: "2026-12-01",
  update_time: "2026-11-10T09:00:00Z",
  ...extra,
});
const note = (id: number, dealId: number | null, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  content,
  deal_id: dealId,
  person_id: null,
  user_id: 10,
  active_flag: true,
  add_time: "2026-11-09 08:00:00",
  update_time: "2026-11-09 08:00:00",
  ...extra,
});
const LIGHT = [{ key: "title" }, { key: "visible_to", options: [{ id: 1, label: "Owner & followers" }, { id: 3, label: "Entire company" }] }];
const PREMIUM = [{ key: "visible_to", options: [{ id: 1 }, { id: 3 }, { id: 5 }, { id: 7 }].map((o) => ({ ...o, label: "x" })) }];

const syncRoutes = (deals: unknown[], notes: unknown[], activities: unknown[], fields: unknown[] = LIGHT) => ({
  "v1/notes": () => ({ data: notes, additional_data: { pagination: { more_items_in_collection: false } } }),
  "v2/activities": () => ({ data: activities, additional_data: { next_cursor: null } }),
  "v2/deals": () => ({ data: deals }),
  "v1/users": () => ({ data: users }),
  "v2/persons": () => ({ data: [{ id: 100, name: "Priya Shah", emails: [{ value: "Priya@Shah.com", primary: true }] }] }),
  "v2/organizations": () => ({ data: [{ id: 200, name: "Shah Traders" }] }),
  "v2/stages": () => ({ data: [{ id: 5, name: "Proposal", pipeline_id: 1 }] }),
  "v1/dealFields": () => ({ data: fields }),
  "v2/deals/2/followers": () => ({ data: [{ user_id: 11 }, { user_id: 12 }] }),
});

describe("Pipedrive", () => {
  it("groups notes and activities by deal on the first sync; owner-and-followers deals go to those people", async () => {
    const { api, calls } = fakeApi(
      syncRoutes(
        [deal(1), deal(2, { title: "Pilot", owner_id: 11, org_id: null, person_id: null, value: null, visible_to: 1, expected_close_date: null })],
        [
          note(50, 1, "<p>Priya wants the revised quote by Friday.</p><p>We promised 10% off.</p>", { person_id: 100, add_time: "2026-11-10 08:00:00", update_time: "2026-11-10 08:30:00" }),
          note(51, 2, "Pilot scope agreed", { user_id: 11 }),
          note(52, null, "A note on a person only", { person_id: 100 }),
          note(53, 3, "On a deal this account can't see"),
        ],
        [
          {
            id: 70,
            subject: "Send revised quote",
            type: "call",
            owner_id: 10,
            creator_user_id: 11,
            deal_id: 1,
            person_id: 100,
            participants: [{ person_id: 100, primary: true }],
            due_date: "2026-11-12",
            done: true,
            note: "<b>Bring</b> pricing",
            add_time: "2026-11-08T10:00:00Z",
            update_time: "2026-11-12T11:00:00Z",
          },
          { id: 71, subject: "Task", type: "task", owner_id: 11, creator_user_id: 11, deal_id: 2, due_date: null, done: false, add_time: "2026-11-09T10:00:00Z", update_time: "2026-11-09T10:00:00Z" },
          { id: 72, subject: "Gone", type: "call", deal_id: 1, is_deleted: true, add_time: "2026-11-09T10:00:00Z", update_time: "2026-11-09T10:00:00Z" },
        ],
      ),
    );
    const r = await fetchPipedrive(api, "acme", undefined, NOW);

    expect(r.threads).toEqual([
      { externalId: "deal:1", kind: "doc", title: "Annual plan (Shah Traders)", url: "https://acme.pipedrive.com/deal/1", visibility: "org", memberKeys: [] },
      { externalId: "deal:2", kind: "doc", title: "Pilot", url: "https://acme.pipedrive.com/deal/2", visibility: "members", memberKeys: ["pipedrive:11", "pipedrive:12"] },
    ]);
    const byId = new Map(r.messages!.map((m) => [m.externalId, m]));
    expect(byId.get("deal:1@2026-11-10T09:00:00Z")).toMatchObject({
      kind: "note",
      authorKey: "pipedrive:10",
      text: "Annual plan (Shah Traders)\nStatus: open\nStage: Proposal\nValue: 12000 INR\nOwner: Jash Doshi\nContact: Priya Shah (priya@shah.com)\nExpected close: 2026-12-01",
    });
    expect(byId.get("note:50@2026-11-10T08:30:00Z")).toMatchObject({
      threadExternalId: "deal:1",
      kind: "note",
      authorKey: "pipedrive:10",
      text: "Priya wants the revised quote by Friday.\nWe promised 10% off.",
      sentAt: new Date("2026-11-10T08:00:00Z"),
      editedAt: new Date("2026-11-10T08:30:00Z"),
    });
    expect(byId.get("activity:70@2026-11-12T11:00:00Z")).toMatchObject({
      threadExternalId: "deal:1",
      authorKey: "pipedrive:11",
      text: "Call with Priya Shah: Send revised quote — due 12 Nov 2026, done (Jash Doshi)\nBring pricing",
    });
    expect(byId.get("activity:71@2026-11-09T10:00:00Z")).toMatchObject({ threadExternalId: "deal:2", text: "Task — no due date, not done (Sumedh Kudav)" });
    expect([...byId.keys()].some((k) => /note:5[23]|activity:72/.test(k))).toBe(false);
    expect(r.versions!.get("note:50")).toBe("note:50@2026-11-10T08:30:00Z");
    expect(r.versions!.get("activity:70")).toBe("activity:70@2026-11-12T11:00:00Z");

    expect(r.people).toContainEqual({ key: "pipedrive:10", provider: "pipedrive", externalId: "10", displayName: "Jash Doshi", email: "jash@example.com" });
    expect(r.people).toContainEqual({ key: "pipedrive:person:100", provider: "pipedrive", externalId: "person:100", displayName: "Priya Shah", email: "priya@shah.com" });
    expect(r.people!.map((p) => p.key).sort()).toEqual(["pipedrive:10", "pipedrive:11", "pipedrive:12", "pipedrive:person:100"]);

    expect(calls[0]).toMatchObject({ path: "v1/notes", query: { updated_since: "2026-08-17T12:00:00Z", sort: "update_time ASC", start: 0, limit: 100 } });
    expect(calls[1]).toMatchObject({ path: "v2/activities", query: { updated_since: "2026-08-17T12:00:00Z", sort_by: "update_time", sort_direction: "asc", limit: 100 } });
    expect(calls.find((c) => c.path === "v2/deals")!.query.ids).toBe("1,2,3");
    expect(r.cursor).toEqual({ notes: { since: "2026-11-10T08:29:00Z" }, activities: { since: "2026-11-12T10:59:00Z" } });
  });

  it("reads visible_to by plan: on Premium, 7 is the company, 1 the owner only, group-visible deals are skipped", async () => {
    expect(audienceOf(3, new Set(["1", "3"]))).toBe("org");
    expect(audienceOf(1, new Set(["1", "3"]))).toBe("owner+followers");
    expect(audienceOf(3, undefined)).toBe("skip");
    expect(audienceOf(1, undefined)).toBe("owner");

    const { api, calls } = fakeApi(
      syncRoutes([deal(1), deal(2, { title: "Pilot", owner_id: 11, visible_to: 1 }), deal(4, { title: "Expansion", visible_to: 7 }), deal(5, { title: "Group", visible_to: 5 })], [note(1, 1, "a"), note(2, 2, "b"), note(4, 4, "c"), note(5, 5, "d")], [], PREMIUM),
    );
    const r = await fetchPipedrive(api, "acme", undefined, NOW);
    expect(r.threads!.map((t) => [t.externalId, t.visibility, t.memberKeys])).toEqual([
      ["deal:2", "members", ["pipedrive:11"]],
      ["deal:4", "org", []],
    ]);
    expect(calls.some((c) => c.path.endsWith("/followers"))).toBe(false);
    expect(r.messages!.map((m) => m.threadExternalId).sort()).toEqual(["deal:2", "deal:2", "deal:4", "deal:4"]);
  });

  it("asks only for what changed since the cursor on a later sync", async () => {
    const cursor = { notes: { since: "2026-11-10T08:29:00Z" }, activities: { since: "2026-11-12T10:59:00Z" } };
    const { api, calls } = fakeApi(syncRoutes([], [], []));
    const r = await fetchPipedrive(api, "acme", cursor, NOW);
    expect(calls.map((c) => [c.path, c.query.updated_since])).toEqual([
      ["v1/notes", "2026-11-10T08:29:00Z"],
      ["v2/activities", "2026-11-12T10:59:00Z"],
    ]);
    expect(r.cursor).toEqual(cursor);
  });

  it("stops at the cap; keeps the page position when a pass can't move forward in time", async () => {
    const same = Array.from({ length: 100 }, (_, i) => note(i, null, "x", { update_time: "2026-11-10 08:30:00" }));
    const routes = {
      ...syncRoutes([], [], []),
      "v1/notes": (q: Record<string, unknown>) => ({ data: same, additional_data: { pagination: { more_items_in_collection: true, next_start: Number(q.start) + 100 } } }),
      "v2/activities": () => ({ data: [], additional_data: { next_cursor: "c1" } }),
    };
    const first = fakeApi(routes);
    const r1 = await fetchPipedrive(first.api, "acme", undefined, NOW);
    expect(first.calls.filter((c) => c.path === "v1/notes").map((c) => c.query.start)).toEqual([0, 100, 200]);
    expect(first.calls.filter((c) => c.path === "v2/activities")).toHaveLength(3);
    expect(r1.cursor).toEqual({ notes: { since: "2026-11-10T08:29:00Z" }, activities: { since: "2026-08-17T12:00:00Z", next: "c1" } });

    const r2 = await fetchPipedrive(fakeApi(routes).api, "acme", r1.cursor, NOW);
    expect(r2.cursor).toMatchObject({ notes: { since: "2026-11-10T08:29:00Z", start: 300 } });
    const third = fakeApi(routes);
    await fetchPipedrive(third.api, "acme", r2.cursor, NOW);
    expect(third.calls[0].query).toMatchObject({ updated_since: "2026-11-10T08:29:00Z", start: 300 });
    expect(third.calls[3].query).toMatchObject({ cursor: "c1" });
  });

  it("accepts only a pipedrive.com company domain", () => {
    expect(domainOf({ domain: "https://Acme.pipedrive.com/deal/4" })).toBe("acme");
    expect(domainOf({ domain: " acme-india " })).toBe("acme-india");
    for (const bad of ["acme.evil.com", "acme.pipedrive.com.evil.com", "evil.com/x.pipedrive.com", "a_b", "-acme", "app", ""]) {
      expect(() => domainOf({ domain: bad })).toThrow("Enter your Pipedrive company domain");
    }
  });

  it("identifies the company; refuses a bad token or another company's token", async () => {
    const credentials = { domain: "acme.pipedrive.com", token: "t" };
    const ok = fakeApi({ "v1/users/me": () => ({ data: { id: 10, company_id: 9, company_name: "Acme", company_domain: "acme" } }) });
    expect(await pipedrive.identify(ok.api, credentials)).toEqual({ accountId: "pipedrive:9", label: "Acme (acme.pipedrive.com)" });

    const refused = fakeApi({ "v1/users/me": () => Promise.reject(new ProviderError("unauthorized access", 401)) });
    await expect(pipedrive.identify(refused.api, credentials)).rejects.toThrow("Pipedrive didn't accept that API token for acme.pipedrive.com");
    const other = fakeApi({ "v1/users/me": () => ({ data: { id: 10, company_id: 8, company_domain: "globex" } }) });
    await expect(pipedrive.identify(other.api, credentials)).rejects.toThrow("belongs to globex.pipedrive.com");
  });

  it("searches deals, people and organizations", async () => {
    const { api, calls } = fakeApi({
      "v2/itemSearch": () => ({
        data: {
          items: [
            { result_score: 1, item: { id: 1, type: "deal", title: "Annual plan", value: 12000, currency: "INR", status: "open", stage: { id: 5, name: "Proposal" }, organization: { id: 200, name: "Shah Traders" }, custom_fields: ["x"], notes: ["y"] } },
            { result_score: 0.5, item: { id: 100, type: "person", name: "Priya Shah", emails: ["priya@shah.com"], phones: ["1", "2", "3"], organization: { id: 200, name: "Shah Traders" } } },
          ],
        },
      }),
    });
    const out = await pipedrive.tools!(api, ctx).pipedrive_search.execute!({ term: "Shah", types: null, limit: null }, opts);
    expect(calls[0].query).toEqual({ term: "Shah", item_types: "deal,person,organization", limit: 10 });
    expect(out).toEqual({
      results: [
        { type: "deal", id: 1, name: "Annual plan", value: 12000, currency: "INR", status: "open", stage: "Proposal", organization: "Shah Traders", url: "https://acme.pipedrive.com/deal/1" },
        { type: "person", id: 100, name: "Priya Shah", organization: "Shah Traders", emails: ["priya@shah.com"], phones: ["1", "2"], url: "https://acme.pipedrive.com/person/100" },
      ].map((x) => expect.objectContaining(x)),
    });
  });

  it("opens one deal with its next activity and latest notes", async () => {
    const { api } = fakeApi({
      "v2/deals/1": () => ({ data: deal(1) }),
      "v1/users/10": () => ({ data: { id: 10, name: "Jash Doshi" } }),
      "v2/organizations/200": () => ({ data: { id: 200, name: "Shah Traders" } }),
      "v2/persons/100": () => ({ data: { id: 100, name: "Priya Shah", emails: [{ value: "Priya@Shah.com", primary: true }] } }),
      "v2/stages/5": () => ({ data: { id: 5, name: "Proposal", pipeline_id: 1 } }),
      "v2/pipelines/1": () => ({ data: { id: 1, name: "Sales" } }),
      "v2/activities": (q) => {
        expect(q).toMatchObject({ deal_id: 1, done: "false", sort_by: "due_date" });
        return { data: [{ id: 70, type: "call", subject: "Send revised quote", due_date: "2020-01-02", done: false, add_time: "2019-12-30T00:00:00Z" }] };
      },
      "v1/notes": () => ({ data: [{ id: 50, content: "<p>Wants 10% off</p>", add_time: "2026-11-10 08:00:00", user: { name: "Jash Doshi" } }] }),
    });
    const out = await pipedrive.tools!(api, ctx).pipedrive_deal.execute!({ dealId: 1 }, opts);
    expect(out).toEqual({
      id: 1,
      title: "Annual plan",
      status: "open",
      pipeline: "Sales",
      stage: "Proposal",
      value: 12000,
      currency: "INR",
      owner: "Jash Doshi",
      organization: "Shah Traders",
      contact: { name: "Priya Shah", email: "priya@shah.com" },
      expectedCloseDate: "2026-12-01",
      nextActivity: { type: "call", subject: "Send revised quote", dueDate: "2020-01-02", dueTime: undefined, overdue: true },
      recentNotes: [{ date: "2026-11-10", author: "Jash Doshi", text: "Wants 10% off" }],
      url: "https://acme.pipedrive.com/deal/1",
    });
  });

  it("summarises open deals by stage and lists overdue next activities", async () => {
    const { api, calls } = fakeApi({
      "v2/deals": () => ({
        data: [
          deal(1, { next_activity_id: 70 }),
          deal(2, { title: "Pilot", value: 500, currency: "USD", next_activity_id: 71 }),
          deal(3, { title: "Renewal", stage_id: 6, value: 3000, next_activity_id: null }),
        ],
        additional_data: { next_cursor: null },
      }),
      "v2/stages": () => ({ data: [{ id: 5, name: "Proposal", pipeline_id: 1, order_nr: 2 }, { id: 6, name: "Qualified", pipeline_id: 1, order_nr: 1 }] }),
      "v2/pipelines": () => ({ data: [{ id: 1, name: "Sales" }] }),
      "v1/users": () => ({ data: users }),
      "v2/activities": () => ({
        data: [
          { id: 70, type: "call", subject: "Send revised quote", due_date: "2020-01-01", done: false, add_time: "x" },
          { id: 71, type: "meeting", subject: "Kickoff", due_date: "2099-01-01", done: false, add_time: "x" },
        ],
      }),
    });
    const out = (await pipedrive.tools!(api, ctx).pipedrive_pipeline.execute!({ pipelineId: null }, opts)) as Record<string, unknown>;
    expect(calls[0].query).toMatchObject({ status: "open", include_fields: "next_activity_id", limit: 500 });
    expect(calls.find((c) => c.path === "v2/activities")!.query.ids).toBe("70,71");
    expect(out.openDeals).toBe(3);
    expect(out.stages).toEqual([
      { pipeline: "Sales", stage: "Qualified", deals: 1, totals: [{ value: 3000, currency: "INR" }] },
      { pipeline: "Sales", stage: "Proposal", deals: 2, totals: [{ value: 12000, currency: "INR" }, { value: 500, currency: "USD" }] },
    ]);
    expect(out.withoutNextActivity).toBe(1);
    expect(out.overdue).toEqual([
      expect.objectContaining({ id: 1, title: "Annual plan", value: 12000, currency: "INR", owner: "Jash Doshi", nextActivity: { type: "call", subject: "Send revised quote", dueDate: "2020-01-01" }, url: "https://acme.pipedrive.com/deal/1" }),
    ]);
  });

  it("adds a note when approved", async () => {
    const action = pipedrive.actions!.pipedrive_add_note;
    const input = action.input.parse({ content: "Priya agreed to <10%> off\nSigning Friday", dealId: 1 });
    expect(action.audience(input)).toBe("internal");
    expect(action.summary(input)).toBe("Pipedrive note on deal #1: Priya agreed to <10%> off Signing Friday");
    expect(action.withBody!(input, "Edited")).toMatchObject({ content: "Edited", dealId: 1 });
    expect(() => action.input.parse({ content: "x" })).toThrow();

    const { api, calls } = fakeApi({ "v1/notes": () => ({ data: { id: 900 } }) });
    expect(await action.run(api, input, ctx)).toEqual({ url: "https://acme.pipedrive.com/deal/1", detail: "Added note 900 to deal #1" });
    expect(calls).toEqual([{ method: "POST", path: "v1/notes", query: {}, body: { content: "Priya agreed to &lt;10%&gt; off<br>Signing Friday", deal_id: 1, person_id: undefined, org_id: undefined } }]);
  });

  it("schedules a follow-up activity when approved", async () => {
    const action = pipedrive.actions!.pipedrive_schedule_activity;
    const input = action.input.parse({ subject: "Send revised quote", type: "Call", dueDate: "2026-11-20", dueTime: "10:30", dealId: 1, note: "Include GST" });
    expect(action.audience(input)).toBe("internal");
    expect(action.summary(input)).toBe("Pipedrive Call on deal #1: Send revised quote, due 2026-11-20 10:30");
    expect(action.body!(input)).toBe("Include GST");
    expect(() => action.input.parse({ subject: "x", type: "call", dueDate: "20 Nov", dealId: 1 })).toThrow();

    const { api, calls } = fakeApi({ "v2/activities": () => ({ data: { id: 71 } }) });
    expect(await action.run(api, input, ctx)).toEqual({ url: "https://acme.pipedrive.com/deal/1", detail: "Scheduled Call 71 on deal #1, due 2026-11-20" });
    expect(calls).toEqual([
      { method: "POST", path: "v2/activities", query: {}, body: { subject: "Send revised quote", type: "call", due_date: "2026-11-20", due_time: "10:30", deal_id: 1, note: "Include GST" } },
    ]);
  });
});
