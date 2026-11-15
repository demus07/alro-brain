import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchZoho, zohoCrm, zohoDc, ZOHO_SCOPES } from "./zoho-crm";

interface Call {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown, method?: string) => unknown>) {
  const calls: Call[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query, headers: opts.headers, body: opts.body });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body, method) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { accountId: "zoho:9001", credentials: { dc: "in", clientId: "1000.X", clientSecret: "s", refreshToken: "r" } };
const run = (tools: ReturnType<NonNullable<typeof zohoCrm.tools>>, name: string, input: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tools[name].execute as any)(input, { toolCallId: "t", messages: [] });

const owner = { name: "Jash Doshi", id: "501", email: "Jash@Example.com" };
const deal = { name: "Shah Traders renewal", id: "7001", module: { api_name: "Deals", id: "m1" } };

const routes = {
  users: () => ({
    users: [
      { id: "501", full_name: "Jash Doshi", email: "Jash@Example.com", status: "active" },
      { id: "502", full_name: "Sumedh Kudav", email: "sumedh@example.com", status: "active" },
    ],
    info: { more_records: false },
  }),
  Contacts: () => ({
    data: [
      { id: "3001", Full_Name: "Priya Shah", Email: "Priya@Customer.com", Modified_Time: "2026-10-20T10:00:00+05:30" },
      { id: "3002", Full_Name: "No Email", Email: null, Modified_Time: "2026-10-21T10:00:00+05:30" },
    ],
    info: { more_records: false },
  }),
  Notes: () => ({
    data: [
      {
        id: "8001",
        Note_Title: "Pricing",
        Note_Content: "They want 12% off for a two-year term.",
        Parent_Id: deal,
        Owner: owner,
        Created_By: owner,
        Created_Time: "2026-10-30T09:00:00+05:30",
        Modified_Time: "2026-11-01T10:00:00+05:30",
      },
    ],
    info: { more_records: false },
  }),
  Tasks: () => ({
    data: [
      {
        id: "8101",
        Subject: "Send revised quote",
        Description: "Include the GST breakup.",
        Due_Date: "2026-11-05",
        Status: "Not Started",
        Priority: "High",
        What_Id: { name: "Shah Traders renewal", id: "7001" },
        $se_module: "Deals",
        Owner: owner,
        Modified_Time: "2026-11-01T11:00:00+05:30",
      },
    ],
    info: { more_records: false },
  }),
  Calls: () => ({
    data: [
      {
        id: "8201",
        Subject: "Intro call",
        Call_Type: "Outbound",
        Call_Start_Time: "2026-10-31T15:00:00+05:30",
        Call_Duration: "12:00",
        Who_Id: { name: "Priya Shah", id: "3001" },
        Owner: { name: "Sumedh Kudav", id: "502" },
        Modified_Time: "2026-10-31T15:20:00+05:30",
      },
    ],
    info: { more_records: false },
  }),
  Events: () => ({
    data: [
      {
        id: "8301",
        Event_Title: "Team offsite",
        Start_DateTime: "2026-11-10T10:00:00+05:30",
        End_DateTime: "2026-11-10T17:00:00+05:30",
        Venue: "Pune",
        Owner: { name: "Sumedh Kudav", id: "502" },
        Modified_Time: "2026-11-01T09:00:00+05:30",
      },
    ],
    info: { more_records: false },
  }),
};

describe("Zoho CRM sync", () => {
  it("groups activities under their deal, contact or themselves; maps users and contacts with emails", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchZoho(api, "in", undefined, NOW);

    expect(r.threads).toEqual([
      { externalId: "7001", kind: "doc", title: "Deal: Shah Traders renewal", url: "https://crm.zoho.in/crm/tab/Potentials/7001", visibility: "org", memberKeys: [], metadata: { module: "Deals" } },
      { externalId: "3001", kind: "doc", title: "Contact: Priya Shah", url: "https://crm.zoho.in/crm/tab/Contacts/3001", visibility: "org", memberKeys: [], metadata: { module: "Contacts" } },
      { externalId: "8301", kind: "doc", title: "Meeting: Team offsite", url: "https://crm.zoho.in/crm/tab/Events/8301", visibility: "org", memberKeys: [], metadata: { module: "Events" } },
    ]);
    expect(r.messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey, m.subject])).toEqual([
      ["7001", "8001@2026-11-01T10:00:00+05:30", "note", "zoho:501", "Pricing"],
      ["7001", "8101@2026-11-01T11:00:00+05:30", "note", "zoho:501", "Send revised quote"],
      ["3001", "8201@2026-10-31T15:20:00+05:30", "note", "zoho:502", "Intro call"],
      ["8301", "8301@2026-11-01T09:00:00+05:30", "note", "zoho:502", "Team offsite"],
    ]);
    expect(r.messages![0].text).toBe("Note: Pricing\nBy: Jash Doshi\n\nThey want 12% off for a two-year term.");
    expect(r.messages![1].text).toBe("Task: Send revised quote\nStatus: Not Started · Priority: High · Due: 2026-11-05\nOwner: Jash Doshi\n\nInclude the GST breakup.");
    expect(r.messages![2].text).toBe("Call: Intro call\nOutbound call at 2026-10-31T15:00:00+05:30 for 12:00\nOwner: Sumedh Kudav\nWith: Priya Shah");
    expect(r.messages![2].sentAt).toEqual(new Date("2026-10-31T09:30:00Z"));
    expect(r.messages![3].text).toBe("Meeting: Team offsite\nWhen: 2026-11-10T10:00:00+05:30 to 2026-11-10T17:00:00+05:30\nWhere: Pune\nHost: Sumedh Kudav");
    expect(r.versions!.get("8101")).toBe("8101@2026-11-01T11:00:00+05:30");

    expect(r.people).toEqual([
      { key: "zoho:501", provider: "zoho", externalId: "501", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "zoho:502", provider: "zoho", externalId: "502", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "zoho:contact:3001", provider: "zoho", externalId: "3001", displayName: "Priya Shah", email: "priya@customer.com" },
    ]);

    const tasks = calls.find((c) => c.path === "Tasks")!;
    expect(tasks.headers).toEqual({ "If-Modified-Since": "2026-08-04T12:00:00+00:00" });
    expect(tasks.query).toMatchObject({ sort_by: "Modified_Time", sort_order: "asc", per_page: 200, page: 1 });
    expect(String(tasks.query.fields)).toContain("What_Id");
    expect(r.cursor).toEqual({
      since: {
        Contacts: "2026-10-21T10:00:00+05:30",
        Notes: "2026-11-01T10:00:00+05:30",
        Tasks: "2026-11-01T11:00:00+05:30",
        Calls: "2026-10-31T15:20:00+05:30",
        Events: "2026-11-01T09:00:00+05:30",
      },
      full: [],
    });
  });

  it("asks only for what changed since the cursor, with an overlap unless the last sync stopped at its cap", async () => {
    const empty = () => ({});
    const { api, calls } = fakeApi({ users: () => ({ users: [] }), Contacts: empty, Notes: empty, Tasks: empty, Calls: empty, Events: empty });
    const r = await fetchZoho(api, "com", { since: { Tasks: "2026-11-01T11:00:00+05:30", Notes: "2026-11-01T10:00:00+05:30" }, full: ["Notes"] }, NOW);
    const header = (p: string) => calls.find((c) => c.path === p)!.headers!["If-Modified-Since"];
    expect(header("Tasks")).toBe("2026-11-01T05:25:00+00:00");
    expect(header("Notes")).toBe("2026-11-01T04:30:00+00:00");
    expect(header("Calls")).toBe("2026-08-04T12:00:00+00:00");
    // Zoho answers 204 (an empty body) when nothing changed; the cursor stays.
    expect(r.cursor).toEqual({ since: { Tasks: "2026-11-01T11:00:00+05:30", Notes: "2026-11-01T10:00:00+05:30" }, full: [] });
  });

  it("stops a module at its cap and marks it to continue; skips a module it may not read", async () => {
    let n = 0;
    const page = () => ({ data: Array.from({ length: 100 }, () => ({ id: String(++n), Note_Title: `N${n}`, Note_Content: "x", Modified_Time: `2026-10-0${1 + Math.floor(n / 100)}T00:00:00+00:00` })), info: { more_records: true } });
    const { api, calls } = fakeApi({
      users: () => ({ users: [] }),
      Contacts: () => ({}),
      Notes: page,
      Tasks: () => {
        throw new ProviderError('{"code":"NO_PERMISSION"}', 403);
      },
      Calls: () => ({}),
      Events: () => ({}),
    });
    const r = await fetchZoho(api, "com", undefined, NOW);
    expect(calls.filter((c) => c.path === "Notes").map((c) => c.query.page)).toEqual([1, 2]);
    expect(r.messages).toHaveLength(200);
    expect((r.cursor as { full: string[] }).full).toEqual(["Notes"]);
    expect(r.threads!.every((t) => t.visibility === "org")).toBe(true);
  });
});

describe("Zoho CRM connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the data centre from what was typed", () => {
    expect(zohoDc({ dc: "https://crm.zoho.in/crm/org1/tab/Home" })).toBe("in");
    expect(zohoDc({ dc: "accounts.zoho.com.au" })).toBe("com.au");
    expect(zohoDc({ dc: ".EU" })).toBe("eu");
    expect(zohoDc({ dc: "zohocloud.ca" })).toBe("ca");
    expect(zohoDc({ dc: "" })).toBe("com");
    expect(() => zohoDc({ dc: "zoho.xyz" })).toThrow("isn't one ALRO knows");
  });

  it("identifies the CRM organization", async () => {
    const { api, calls } = fakeApi({ org: () => ({ org: [{ id: "9001", company_name: "Alro Labs", domain_name: "org9001" }] }) });
    expect(await zohoCrm.identify(api, ctx.credentials)).toEqual({ accountId: "zoho:9001", label: "Alro Labs" });
    expect(calls.map((c) => c.path)).toEqual(["org"]);
    const refused = fakeApi({ org: () => { throw new ProviderError("INVALID_TOKEN", 401); } });
    await expect(zohoCrm.identify(refused.api, ctx.credentials)).rejects.toThrow("Zoho CRM refused that connection");
  });

  it("trades the grant code for a refresh token in the right data centre, then mints access tokens from it", async () => {
    const auth = zohoCrm.auth as Extract<typeof zohoCrm.auth, { kind: "token" }>;
    const seen: { url: string; body?: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), body: init.body ? String(init.body) : undefined, auth: (init.headers as Record<string, string>).authorization });
        if (String(url).includes("/oauth/v2/token")) {
          const form = new URLSearchParams(String(init.body));
          return new Response(JSON.stringify(form.get("grant_type") === "authorization_code" ? { refresh_token: "1000.refresh", access_token: "a0", api_domain: "https://www.zohoapis.in" } : { access_token: "a1", expires_in: 3600 }));
        }
        return new Response(JSON.stringify({ org: [{ id: "9001", company_name: "Alro Labs" }] }));
      }),
    );
    const stored = await auth.exchange!({ dc: "in", clientId: " 1000.X ", clientSecret: "s", code: "1000.code" });
    expect(stored).toEqual({ dc: "in", clientId: "1000.X", clientSecret: "s", refreshToken: "1000.refresh" });
    expect(seen[0].url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(Object.fromEntries(new URLSearchParams(seen[0].body))).toEqual({ grant_type: "authorization_code", client_id: "1000.X", client_secret: "s", code: "1000.code" });

    await zohoCrm.identify(auth.api(stored), stored);
    expect(Object.fromEntries(new URLSearchParams(seen[1].body))).toEqual({ grant_type: "refresh_token", client_id: "1000.X", client_secret: "s", refresh_token: "1000.refresh" });
    expect(seen[2]).toMatchObject({ url: "https://www.zohoapis.in/crm/v8/org", auth: "Bearer a1" });
  });

  it("explains a used or expired grant code", async () => {
    const auth = zohoCrm.auth as Extract<typeof zohoCrm.auth, { kind: "token" }>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_code" }))));
    await expect(auth.exchange!({ dc: "com", clientId: "1000.X", clientSecret: "s", code: "old" })).rejects.toThrow("already used or has expired");
  });

  it("asks only for read scopes plus creating notes and tasks", () => {
    expect(ZOHO_SCOPES.filter((s) => !s.endsWith(".READ"))).toEqual(["ZohoCRM.modules.notes.CREATE", "ZohoCRM.modules.tasks.CREATE"]);
  });
});

describe("Zoho CRM live tools", () => {
  it("zoho_search looks in all four modules and trims each record", async () => {
    const { api, calls } = fakeApi({
      "Leads/search": () => ({}),
      "Contacts/search": () => ({ data: [{ id: "3001", Full_Name: "Priya Shah", Email: "priya@customer.com", Account_Name: { name: "Shah Traders", id: "6001" }, Owner: owner, Mailing_Street: "x", $approved: true }] }),
      "Accounts/search": () => ({ data: [{ id: "6001", Account_Name: "Shah Traders", Industry: "Retail", Phone: null }] }),
      "Deals/search": () => {
        throw new ProviderError("NO_PERMISSION", 403);
      },
    });
    const r = await run(zohoCrm.tools!(api, ctx), "zoho_search", { query: "Shah (Traders)" });
    expect(calls.map((c) => [c.path, c.query.word])).toEqual([
      ["Leads/search", "Shah Traders"],
      ["Contacts/search", "Shah Traders"],
      ["Accounts/search", "Shah Traders"],
      ["Deals/search", "Shah Traders"],
    ]);
    expect(r.results).toEqual([
      { module: "Contacts", id: "3001", Full_Name: "Priya Shah", Email: "priya@customer.com", Account_Name: "Shah Traders", Owner: "Jash Doshi", url: "https://crm.zoho.in/crm/tab/Contacts/3001" },
      { module: "Accounts", id: "6001", Account_Name: "Shah Traders", Industry: "Retail", url: "https://crm.zoho.in/crm/tab/Accounts/6001" },
    ]);
  });

  it("zoho_record returns a deal's key fields, its currency and open tasks", async () => {
    const { api, calls } = fakeApi({
      "Deals/7001": () => ({ data: [{ id: "7001", Deal_Name: "Shah Traders renewal", Stage: "Negotiation", Amount: 450000, Closing_Date: "2026-11-30", Owner: owner, Account_Name: { name: "Shah Traders", id: "6001" }, Description: "Two-year term", Tag: [] }] }),
      "Deals/7001/Tasks": () => ({ data: [{ id: "8101", Subject: "Send revised quote", Due_Date: "2026-11-05", Status: "Not Started", Owner: owner }, { id: "8102", Subject: "Kickoff", Status: "Completed" }] }),
      org: () => ({ org: [{ id: "9001", iso_code: "INR" }] }),
    });
    const r = await run(zohoCrm.tools!(api, ctx), "zoho_record", { module: "Deals", id: "7001" });
    expect(r).toEqual({
      module: "Deals",
      id: "7001",
      Deal_Name: "Shah Traders renewal",
      Stage: "Negotiation",
      Amount: 450000,
      Currency: "INR",
      Closing_Date: "2026-11-30",
      Account_Name: "Shah Traders",
      Owner: "Jash Doshi",
      Description: "Two-year term",
      openTasks: [{ subject: "Send revised quote", due: "2026-11-05", status: "Not Started", owner: "Jash Doshi" }],
      url: "https://crm.zoho.in/crm/tab/Potentials/7001",
    });
    expect(calls[1].query.fields).toBe("Subject,Due_Date,Status,Priority,Owner");
  });

  it("zoho_pipeline totals open deals by stage, asking again without Currency in single-currency orgs", async () => {
    const { api, calls } = fakeApi({
      Deals: (q) => {
        if (String(q.fields).includes("Currency")) throw new ProviderError('{"code":"INVALID_DATA","details":{"api_name":"Currency"}}', 400);
        return {
          data: [
            { id: "1", Deal_Name: "A", Stage: "Negotiation", Amount: 100000.5, Modified_Time: "x" },
            { id: "2", Deal_Name: "B", Stage: "Negotiation", Amount: 50000, Modified_Time: "x" },
            { id: "3", Deal_Name: "C", Stage: "Qualification", Amount: null, Modified_Time: "x" },
            { id: "4", Deal_Name: "D", Stage: "Closed Won", Amount: 999999, Modified_Time: "x" },
            { id: "5", Deal_Name: "E", Stage: "Closed-Lost to Competition", Amount: 5, Modified_Time: "x" },
          ],
          info: { more_records: false },
        };
      },
      org: () => ({ org: [{ id: "9001", iso_code: "INR" }] }),
    });
    const r = await run(zohoCrm.tools!(api, ctx), "zoho_pipeline", {});
    expect(r).toEqual({
      openDeals: 3,
      stages: [
        { stage: "Negotiation", deals: 2, totals: [{ currency: "INR", amount: 150000.5 }] },
        { stage: "Qualification", deals: 1, totals: [{ currency: "INR", amount: 0 }] },
      ],
      totals: [{ currency: "INR", amount: 150000.5 }],
      note: undefined,
    });
    expect(calls.filter((c) => c.path === "Deals").map((c) => c.query.fields)).toEqual(["Deal_Name,Stage,Amount,Closing_Date,Currency", "Deal_Name,Stage,Amount,Closing_Date"]);
  });
});

describe("Zoho CRM actions", () => {
  const ok = () => ({ data: [{ code: "SUCCESS", status: "success", message: "record added", details: { id: "9901" } }] });

  it("zoho_add_note posts a note on the record", async () => {
    const action = zohoCrm.actions!.zoho_add_note;
    const input = action.input.parse({ module: "Deals", recordId: "7001", title: "Call notes", content: "Agreed 10%." });
    expect(action.audience(input)).toBe("internal");
    expect(action.summary(input)).toBe("Zoho CRM note on deal 7001: Call notes");
    expect(action.withBody!(input, "Agreed 11%.").content).toBe("Agreed 11%.");
    const { api, calls } = fakeApi({ Notes: ok });
    expect(await action.run(api, input, ctx)).toEqual({ url: "https://crm.zoho.in/crm/tab/Potentials/7001", detail: "Note added" });
    expect(calls).toEqual([
      { method: "POST", path: "Notes", query: {}, headers: undefined, body: { data: [{ Note_Title: "Call notes", Note_Content: "Agreed 10%.", Parent_Id: { module: { api_name: "Deals" }, id: "7001" } }] } },
    ]);
  });

  it("zoho_create_task links deals by What_Id and contacts by Who_Id, and reports refusals", async () => {
    const action = zohoCrm.actions!.zoho_create_task;
    const { api, calls } = fakeApi({ Tasks: ok });
    const onDeal = action.input.parse({ subject: "Send quote", dueDate: "2026-11-05", module: "Deals", recordId: "7001", description: "With GST" });
    expect(await action.run(api, onDeal, ctx)).toEqual({ url: "https://crm.zoho.in/crm/tab/Tasks/9901", detail: "Task created" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "Tasks", body: { data: [{ Subject: "Send quote", Due_Date: "2026-11-05", Description: "With GST", What_Id: { id: "7001" }, $se_module: "Deals" }] } });

    await action.run(api, action.input.parse({ subject: "Call Priya", module: "Contacts", recordId: "3001" }), ctx);
    expect(calls[1].body).toEqual({ data: [{ Subject: "Call Priya", Due_Date: undefined, Description: undefined, Who_Id: { id: "3001" } }] });

    expect(() => action.input.parse({ subject: "x", dueDate: "5 Nov" })).toThrow();
    await expect(action.run(api, action.input.parse({ subject: "x", module: "Deals" }), ctx)).rejects.toThrow("both the kind of record and its id");
    const refused = fakeApi({ Tasks: () => ({ data: [{ code: "MANDATORY_NOT_FOUND", status: "error", message: "required field not found" }] }) });
    await expect(action.run(refused.api, action.input.parse({ subject: "x" }), ctx)).rejects.toThrow("Zoho CRM didn't add the task: required field not found");
  });
});
