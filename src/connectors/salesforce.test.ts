import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchSalesforce, myDomain, noteContent, salesforce } from "./salesforce";

interface Call {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
}

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: Call[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query, body: opts.body });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

/** Answers SOQL by the object it reads (the first FROM). */
const soqlRoutes = (tables: Record<string, (q: string) => unknown[]>) => ({
  query: (query: Record<string, unknown>) => {
    const q = String(query.q);
    const object = /FROM (\w+)/.exec(q)![1];
    const table = tables[object];
    if (!table) throw new ProviderError(`[{"errorCode":"INVALID_TYPE","message":"sObject type '${object}' is not supported."}]`, 400);
    const records = table(q);
    return { totalSize: records.length, done: true, records };
  },
});
const soqlOf = (calls: Call[], object: string) => calls.filter((c) => c.path === "query" && new RegExp(`FROM ${object}\\b`).test(String(c.query.q))).map((c) => String(c.query.q));

const NOW = new Date("2026-11-02T12:00:00Z");
const HOST = "acme.my.salesforce.com";
const ctx = { accountId: "salesforce:00D000000000001", credentials: { domain: "https://acme.my.salesforce.com", clientId: "3MVG", clientSecret: "s" } };
const run = (tools: ReturnType<NonNullable<typeof salesforce.tools>>, name: string, input: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tools[name].execute as any)(input, { toolCallId: "t", messages: [] });

const OPP = "006000000000001AAA";
const ACC = "001000000000001AAA";
const LEAD = "00Q000000000001AAA";
const JASH = "005000000000001AAA";
const SUMEDH = "005000000000002AAA";
const opp = { Id: OPP, Name: "Shah Traders renewal", Type: "Opportunity" };

const tables = {
  Organization: () => [{ Id: "00D000000000001", DefaultAccountAccess: "None", DefaultContactAccess: "ControlledByParent", DefaultOpportunityAccess: "Read", DefaultLeadAccess: "None", DefaultCaseAccess: "Edit" }],
  User: () => [
    { Id: JASH, Name: "Jash Doshi", Email: "Jash@Example.com" },
    { Id: SUMEDH, Name: "Sumedh Kudav", Email: "sumedh@example.com" },
  ],
  Contact: () => [{ Id: "003000000000001AAA", Name: "Priya Shah", Email: "Priya@Customer.com", SystemModstamp: "2026-10-20T10:00:00.000+0000" }],
  Task: () => [
    {
      Id: "00T000000000001AAA",
      Subject: "Send revised quote",
      Description: "Include the GST breakup.",
      Status: "Not Started",
      Priority: "High",
      ActivityDate: "2026-11-05",
      TaskSubtype: "Task",
      WhatId: OPP,
      What: opp,
      WhoId: "003000000000001AAA",
      Who: { Name: "Priya Shah", Type: "Contact" },
      AccountId: ACC,
      Account: { Name: "Shah Traders" },
      OwnerId: JASH,
      LastModifiedDate: "2026-11-01T10:00:00.000+0000",
      SystemModstamp: "2026-11-01T10:00:00.000+0000",
    },
    {
      Id: "00T000000000002AAA",
      Subject: "Call Shah Traders",
      TaskSubtype: "Call",
      Status: "Completed",
      CallDurationInSeconds: 600,
      CallDisposition: "Wants a demo",
      AccountId: ACC,
      Account: { Name: "Shah Traders" },
      OwnerId: SUMEDH,
      LastModifiedDate: "2026-11-01T11:00:00.000+0000",
      SystemModstamp: "2026-11-01T11:00:00.000+0000",
    },
    { Id: "00T000000000003AAA", Subject: "Renew domain", Status: "Not Started", OwnerId: SUMEDH, SystemModstamp: "2026-11-01T12:00:00.000+0000" },
    { Id: "00T000000000004AAA", Subject: "Qualify lead", Status: "Not Started", WhoId: LEAD, Who: { Name: "Big Lead", Type: "Lead" }, OwnerId: JASH, SystemModstamp: "2026-11-01T12:30:00.000+0000" },
  ],
  Event: () => [
    {
      Id: "00U000000000001AAA",
      Subject: "Pricing review",
      StartDateTime: "2026-11-03T09:00:00.000+0000",
      EndDateTime: "2026-11-03T10:00:00.000+0000",
      Location: "Zoom",
      WhatId: OPP,
      What: opp,
      OwnerId: JASH,
      IsPrivate: false,
      SystemModstamp: "2026-11-01T09:00:00.000+0000",
    },
    { Id: "00U000000000002AAA", Subject: "Doctor", StartDateTime: "2026-11-04T09:00:00.000+0000", WhatId: OPP, What: opp, OwnerId: SUMEDH, IsPrivate: true, SystemModstamp: "2026-11-01T09:30:00.000+0000" },
  ],
  EmailMessage: () => [
    {
      Id: "02s000000000001AAA",
      Subject: "Re: renewal",
      TextBody: "Can you do 12%?",
      FromName: "Priya Shah",
      FromAddress: "priya@customer.com",
      ToAddress: "jash@example.com",
      MessageDate: "2026-11-01T08:00:00.000+0000",
      RelatedToId: OPP,
      RelatedTo: opp,
      CreatedById: JASH,
      SystemModstamp: "2026-11-01T08:00:01.000+0000",
    },
  ],
  Note: () => [{ Id: "002000000000001AAA", Title: "Old note", Body: "From before Lightning.", IsPrivate: false, ParentId: ACC, Parent: { Name: "Shah Traders", Type: "Account" }, OwnerId: JASH, SystemModstamp: "2026-10-01T08:00:00.000+0000" }],
  ContentNote: () => [
    { Id: "069000000000001AAA", Title: "Discovery", TextPreview: "Budget", OwnerId: JASH, LastModifiedDate: "2026-11-01T07:00:00.000+0000" },
    { Id: "069000000000002AAA", Title: "My ideas", TextPreview: "", OwnerId: SUMEDH, LastModifiedDate: "2026-11-01T07:30:00.000+0000" },
  ],
  ContentDocumentLink: () => [
    { ContentDocumentId: "069000000000001AAA", LinkedEntityId: JASH, LinkedEntity: { Name: "Jash Doshi", Type: "User" } },
    { ContentDocumentId: "069000000000001AAA", LinkedEntityId: OPP, LinkedEntity: { Name: "Shah Traders renewal", Type: "Opportunity" } },
    { ContentDocumentId: "069000000000002AAA", LinkedEntityId: SUMEDH, LinkedEntity: { Name: "Sumedh Kudav", Type: "User" } },
  ],
  Account: () => [{ Id: ACC, OwnerId: JASH }],
  Lead: () => [{ Id: LEAD, OwnerId: "00G000000000001AAA" }],
};
const routes = {
  ...soqlRoutes(tables),
  "sobjects/ContentNote/069000000000001AAA/Content": () => "<p>Budget is <b>₹5L</b></p><p>Decision by Dec</p>",
  "sobjects/ContentNote/069000000000002AAA/Content": () => "<p>Try annual plans</p>",
};

describe("Salesforce sync", () => {
  it("files activities under their opportunity or account, sharing each as the org's defaults allow", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchSalesforce(api, HOST, undefined, NOW);

    expect(r.threads).toEqual([
      { externalId: OPP, kind: "doc", title: "Opportunity: Shah Traders renewal", url: `https://${HOST}/${OPP}`, visibility: "org", memberKeys: [], metadata: { object: "Opportunity" } },
      // Accounts are private by default here: only the account's owner sees its thread.
      { externalId: ACC, kind: "doc", title: "Account: Shah Traders", url: `https://${HOST}/${ACC}`, visibility: "members", memberKeys: [`salesforce:${JASH}`], metadata: { object: "Account" } },
      { externalId: "00T000000000003AAA", kind: "doc", title: "Renew domain", url: `https://${HOST}/00T000000000003AAA`, visibility: "members", memberKeys: [`salesforce:${SUMEDH}`] },
      { externalId: "00U000000000002AAA", kind: "doc", title: "Doctor", url: `https://${HOST}/00U000000000002AAA`, visibility: "members", memberKeys: [`salesforce:${SUMEDH}`] },
      { externalId: "069000000000002AAA", kind: "doc", title: "My ideas", url: `https://${HOST}/069000000000002AAA`, visibility: "members", memberKeys: [`salesforce:${SUMEDH}`] },
    ]);
    // The lead belongs to a queue, so nobody can be named: its task is skipped.
    expect(r.messages!.some((m) => m.text.includes("Qualify lead"))).toBe(false);

    const byId = new Map(r.messages!.map((m) => [m.externalId, m]));
    expect(byId.get("00T000000000001AAA@2026-11-01T10:00:00.000+0000")).toMatchObject({
      threadExternalId: OPP,
      kind: "note",
      authorKey: `salesforce:${JASH}`,
      subject: "Send revised quote",
      text: "Task: Send revised quote\nStatus: Not Started · Priority: High · Due: 2026-11-05\nWith: Priya Shah\n\nInclude the GST breakup.",
    });
    expect(byId.get("00T000000000002AAA@2026-11-01T11:00:00.000+0000")).toMatchObject({ threadExternalId: ACC, text: "Call: Call Shah Traders\nStatus: Completed\nDuration: 10 min\nResult: Wants a demo" });
    expect(byId.get("00U000000000001AAA@2026-11-01T09:00:00.000+0000")).toMatchObject({
      threadExternalId: OPP,
      sentAt: new Date("2026-11-03T09:00:00Z"),
      text: "Meeting: Pricing review\nWhen: 2026-11-03T09:00:00.000+0000 to 2026-11-03T10:00:00.000+0000\nWhere: Zoom",
    });
    expect(byId.get("02s000000000001AAA")).toMatchObject({ threadExternalId: OPP, kind: "email", text: "Email: Re: renewal\nFrom: Priya Shah <priya@customer.com>\nTo: jash@example.com\n\nCan you do 12%?" });
    expect(byId.get("069000000000001AAA@2026-11-01T07:00:00.000+0000")).toMatchObject({ threadExternalId: OPP, text: "Note: Discovery\n\nBudget is ₹5L\nDecision by Dec" });
    expect(byId.get("002000000000001AAA@2026-10-01T08:00:00.000+0000")).toMatchObject({ threadExternalId: ACC, text: "Note: Old note\n\nFrom before Lightning." });
    expect(r.versions!.get("00T000000000001AAA")).toBe("00T000000000001AAA@2026-11-01T10:00:00.000+0000");
    expect(r.versions!.has("02s000000000001AAA")).toBe(false);

    expect(r.people).toEqual([
      { key: `salesforce:${JASH}`, provider: "salesforce", externalId: JASH, displayName: "Jash Doshi", email: "jash@example.com" },
      { key: `salesforce:${SUMEDH}`, provider: "salesforce", externalId: SUMEDH, displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "salesforce:003000000000001AAA", provider: "salesforce", externalId: "003000000000001AAA", displayName: "Priya Shah", email: "priya@customer.com" },
    ]);

    expect(soqlOf(calls, "Task")[0]).toMatch(/FROM Task WHERE SystemModstamp > 2026-08-04T12:00:00Z ORDER BY SystemModstamp ASC LIMIT 200$/);
    expect(soqlOf(calls, "ContentNote")[0]).toMatch(/WHERE LastModifiedDate > 2026-08-04T12:00:00Z ORDER BY LastModifiedDate ASC LIMIT 50$/);
    expect(soqlOf(calls, "ContentDocumentLink")[0]).toContain("WHERE ContentDocumentId IN ('069000000000001AAA', '069000000000002AAA')");
    // Owners are looked up only for record types the org keeps private.
    expect(soqlOf(calls, "Account")[0]).toBe(`SELECT Id, OwnerId FROM Account WHERE Id IN ('${ACC}')`);
    expect(soqlOf(calls, "Opportunity")).toEqual([]);
    expect(r.cursor).toEqual({
      since: {
        Contact: "2026-10-20T10:00:00.000+0000",
        Task: "2026-11-01T12:30:00.000+0000",
        Event: "2026-11-01T09:30:00.000+0000",
        EmailMessage: "2026-11-01T08:00:01.000+0000",
        Note: "2026-10-01T08:00:00.000+0000",
        ContentNote: "2026-11-01T07:30:00.000+0000",
      },
      full: [],
    });
  });

  it("asks only for what changed, with an overlap unless the last sync stopped at its cap; skips objects it can't read", async () => {
    const { api, calls } = fakeApi(soqlRoutes({ Organization: () => [], User: () => [], Contact: () => [], Task: () => [], Event: () => [], Note: () => [], ContentNote: () => [] }));
    const r = await fetchSalesforce(api, HOST, { since: { Task: "2026-11-01T10:00:00.000+0000", Event: "2026-11-01T09:00:00.000+0000" }, full: ["Event"] }, NOW);
    expect(soqlOf(calls, "Task")[0]).toContain("WHERE SystemModstamp > 2026-11-01T09:55:00Z");
    expect(soqlOf(calls, "Event")[0]).toContain("WHERE SystemModstamp > 2026-11-01T09:00:00Z");
    // EmailMessage isn't available in this org: answered 400 INVALID_TYPE, and the sync carries on.
    expect(soqlOf(calls, "EmailMessage")).toHaveLength(1);
    expect(r.cursor).toEqual({ since: { Task: "2026-11-01T10:00:00.000+0000", Event: "2026-11-01T09:00:00.000+0000" }, full: [] });
    // With no readable defaults, everything counts as private.
    expect(r.threads).toEqual([]);
  });

  it("stops an object at its cap and marks it to continue", async () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({ Id: `00T${String(i).padStart(15, "0")}`, Subject: `T${i}`, OwnerId: JASH, SystemModstamp: "2026-11-01T10:00:00.000+0000" }));
    const { api } = fakeApi(soqlRoutes({ ...tables, Task: () => tasks, Event: () => [], EmailMessage: () => [], Note: () => [], ContentNote: () => [] }));
    const r = await fetchSalesforce(api, HOST, undefined, NOW);
    expect((r.cursor as { full: string[] }).full).toEqual(["Task"]);
    expect(r.messages).toHaveLength(200);
  });
});

describe("Salesforce connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts My Domain URLs, including sandboxes and Lightning links", () => {
    expect(myDomain({ domain: "https://Acme.my.salesforce.com/lightning/page/home" })).toBe("acme.my.salesforce.com");
    expect(myDomain({ domain: "acme--uat.sandbox.my.salesforce.com" })).toBe("acme--uat.sandbox.my.salesforce.com");
    expect(myDomain({ domain: "https://acme.lightning.force.com/" })).toBe("acme.my.salesforce.com");
    expect(myDomain({ domain: "acme" })).toBe("acme.my.salesforce.com");
    expect(() => myDomain({ domain: "https://login.salesforce.com" })).toThrow("My Domain URL");
    expect(() => myDomain({ domain: "https://acme.my.salesforce.com.evil.io" })).toThrow("My Domain URL");
  });

  it("mints a token with the client credentials flow and identifies the org", async () => {
    const auth = salesforce.auth as Extract<typeof salesforce.auth, { kind: "token" }>;
    const seen: { url: string; body?: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), body: init.body ? String(init.body) : undefined, auth: (init.headers as Record<string, string>).authorization });
        if (String(url).endsWith("/services/oauth2/token")) return new Response(JSON.stringify({ access_token: "00D!tok", instance_url: "https://acme.my.salesforce.com", token_type: "Bearer" }));
        return new Response(JSON.stringify({ done: true, records: [{ Id: "00D000000000001", Name: "Alro Labs" }] }));
      }),
    );
    expect(await salesforce.identify(auth.api(ctx.credentials), ctx.credentials)).toEqual({ accountId: "salesforce:00D000000000001", label: "Alro Labs (acme.my.salesforce.com)" });
    expect(seen[0].url).toBe("https://acme.my.salesforce.com/services/oauth2/token");
    expect(Object.fromEntries(new URLSearchParams(seen[0].body))).toEqual({ grant_type: "client_credentials", client_id: "3MVG", client_secret: "s" });
    expect(seen[1].url).toBe("https://acme.my.salesforce.com/services/data/v68.0/query?q=SELECT+Id%2C+Name+FROM+Organization+LIMIT+1");
    expect(seen[1].auth).toBe("Bearer 00D!tok");
  });

  it("explains client-credentials refusals in plain words", async () => {
    const auth = salesforce.auth as Extract<typeof salesforce.auth, { kind: "token" }>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "no client credentials user enabled" }), { status: 400 })));
    await expect(salesforce.identify(auth.api(ctx.credentials), ctx.credentials)).rejects.toThrow("no Run As user");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_client_id", error_description: "client identifier invalid" }), { status: 400 })));
    await expect(salesforce.identify(auth.api(ctx.credentials), ctx.credentials)).rejects.toThrow("didn't accept that consumer key and secret");
  });
});

describe("Salesforce live tools", () => {
  const singleCurrency = {
    Organization: (q: string) => (q.includes("DefaultCurrencyIsoCode") ? [{ DefaultCurrencyIsoCode: "INR" }] : []),
  };
  const opportunity = (q: string) => {
    if (q.includes("CurrencyIsoCode")) throw new ProviderError("[{\"errorCode\":\"INVALID_FIELD\"}]", 400);
    return [
      {
        attributes: { type: "Opportunity" },
        Id: OPP,
        Name: "Shah Traders renewal",
        StageName: "Negotiation",
        Amount: 450000,
        CloseDate: "2026-11-30",
        Probability: 70,
        IsClosed: false,
        IsWon: false,
        NextStep: null,
        Description: "Two-year term",
        Account: { attributes: {}, Name: "Shah Traders" },
        Owner: { attributes: {}, Name: "Jash Doshi" },
      },
    ];
  };

  it("salesforce_search escapes the words and trims each record", async () => {
    const { api, calls } = fakeApi({
      ...soqlRoutes({ ...singleCurrency, Opportunity: opportunity }),
      search: () => ({
        searchRecords: [
          { attributes: { type: "Account", url: "/x" }, Id: ACC, Name: "Shah Traders", Industry: "Retail", Website: null, Owner: { Name: "Jash Doshi" } },
          { attributes: { type: "Opportunity" }, Id: OPP, Name: "Shah Traders renewal", StageName: "Negotiation", Amount: 450000, CloseDate: "2026-11-30" },
        ],
      }),
    });
    const r = await run(salesforce.tools!(api, ctx), "salesforce_search", { query: "Shah & Co (Pune)" });
    const q = String(calls.find((c) => c.path === "search")!.query.q);
    expect(q.startsWith("FIND {Shah \\& Co \\(Pune\\)} IN ALL FIELDS RETURNING Account(")).toBe(true);
    expect(q).toContain("Lead(Id, Name, Company, Email, Status WHERE IsConverted = false LIMIT 8)");
    expect(r.results).toEqual([
      { type: "Account", Id: ACC, Name: "Shah Traders", Industry: "Retail", Owner: "Jash Doshi", url: `https://${HOST}/${ACC}` },
      { type: "Opportunity", Id: OPP, Name: "Shah Traders renewal", StageName: "Negotiation", Amount: 450000, CloseDate: "2026-11-30", currency: "INR", url: `https://${HOST}/${OPP}` },
    ]);
  });

  it("salesforce_opportunity returns stage, amount with currency, owner and open tasks", async () => {
    const { api, calls } = fakeApi(
      soqlRoutes({
        ...singleCurrency,
        Opportunity: opportunity,
        Task: () => [{ Id: "00T1", Subject: "Send revised quote", ActivityDate: "2026-11-05", Status: "Not Started", Priority: "High", Owner: { Name: "Jash Doshi" } }],
      }),
    );
    const r = await run(salesforce.tools!(api, ctx), "salesforce_opportunity", { id: OPP });
    expect(r).toEqual({
      Id: OPP,
      Name: "Shah Traders renewal",
      StageName: "Negotiation",
      Amount: 450000,
      CloseDate: "2026-11-30",
      Probability: 70,
      IsClosed: false,
      IsWon: false,
      Account: "Shah Traders",
      Owner: "Jash Doshi",
      currency: "INR",
      description: "Two-year term",
      openTasks: [{ subject: "Send revised quote", due: "2026-11-05", status: "Not Started", priority: "High", owner: "Jash Doshi" }],
      url: `https://${HOST}/${OPP}`,
    });
    expect(soqlOf(calls, "Opportunity").at(-1)).toContain(`WHERE Id = '${OPP}'`);
    expect(soqlOf(calls, "Task")[0]).toContain(`WHERE WhatId = '${OPP}' AND IsClosed = false`);

    await run(salesforce.tools!(api, ctx), "salesforce_opportunity", { name: "50%_off 'deal'" });
    expect(soqlOf(calls, "Opportunity").at(-1)).toContain("WHERE Name LIKE '%50\\%\\_off \\'deal\\'%'");
  });

  it("salesforce_pipeline totals open opportunities by stage in each currency, in stage order", async () => {
    const { api, calls } = fakeApi(
      soqlRoutes({
        Opportunity: (q) =>
          q.includes("LIMIT 1") && !q.includes("StageName")
            ? [{ Id: OPP, CurrencyIsoCode: "USD" }]
            : [
                { StageName: "Negotiation", Amount: 1000.5, CurrencyIsoCode: "USD" },
                { StageName: "Negotiation", Amount: 200000, CurrencyIsoCode: "INR" },
                { StageName: "Prospecting", Amount: null, CurrencyIsoCode: "USD" },
              ],
        OpportunityStage: () => [
          { ApiName: "Prospecting", MasterLabel: "Prospecting", SortOrder: 1 },
          { ApiName: "Negotiation", MasterLabel: "Negotiation/Review", SortOrder: 7 },
        ],
      }),
    );
    const r = await run(salesforce.tools!(api, ctx), "salesforce_pipeline", { closingBy: "2026-12-31" });
    expect(r).toEqual({
      openOpportunities: 3,
      stages: [
        { stage: "Prospecting", opportunities: 1, totals: [{ currency: "USD", amount: 0 }] },
        {
          stage: "Negotiation",
          opportunities: 2,
          totals: [
            { currency: "USD", amount: 1000.5 },
            { currency: "INR", amount: 200000 },
          ],
        },
      ],
      totals: [
        { currency: "USD", amount: 1000.5 },
        { currency: "INR", amount: 200000 },
      ],
      note: undefined,
    });
    expect(soqlOf(calls, "Opportunity").at(-1)).toBe("SELECT StageName, Amount, CurrencyIsoCode FROM Opportunity WHERE IsClosed = false AND CloseDate <= 2026-12-31 LIMIT 2000");
  });
});

describe("Salesforce actions", () => {
  it("salesforce_create_task creates the task on the records given", async () => {
    const action = salesforce.actions!.salesforce_create_task;
    const input = action.input.parse({ subject: "Send quote", dueDate: "2026-11-05", whatId: OPP, description: "With GST" });
    expect(action.audience(input)).toBe("internal");
    expect(action.summary(input)).toBe("Salesforce task: Send quote (due 2026-11-05)");
    const { api, calls } = fakeApi({ "sobjects/Task": () => ({ id: "00T000000000009AAA", success: true, errors: [] }) });
    expect(await action.run(api, input, ctx)).toEqual({ url: `https://${HOST}/00T000000000009AAA`, detail: "Task created" });
    expect(calls).toEqual([
      { method: "POST", path: "sobjects/Task", query: {}, body: { Subject: "Send quote", ActivityDate: "2026-11-05", WhatId: OPP, WhoId: undefined, Description: "With GST" } },
    ]);
    expect(() => action.input.parse({ subject: "x", whatId: "' OR 1=1" })).toThrow();
  });

  it("salesforce_log_note saves a note and attaches it to the record", async () => {
    const action = salesforce.actions!.salesforce_log_note;
    const input = action.input.parse({ recordId: OPP, title: "Call notes", body: "Agreed 10% <net>\nSign by Friday" });
    expect(action.withBody!(input, "Agreed 11%").body).toBe("Agreed 11%");
    const { api, calls } = fakeApi({
      "sobjects/ContentNote": () => ({ id: "069000000000009AAA", success: true }),
      "sobjects/ContentDocumentLink": () => ({ id: "06A000000000009AAA", success: true }),
    });
    expect(await action.run(api, input, ctx)).toEqual({ url: `https://${HOST}/${OPP}`, detail: "Note added" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "sobjects/ContentNote", body: { Title: "Call notes", Content: noteContent("Agreed 10% <net>\nSign by Friday") } });
    expect(Buffer.from(noteContent("Agreed 10% <net>\nSign by Friday"), "base64").toString()).toBe("<p>Agreed 10% &lt;net&gt;</p><p>Sign by Friday</p>");
    expect(calls[1]).toMatchObject({ method: "POST", path: "sobjects/ContentDocumentLink", body: { ContentDocumentId: "069000000000009AAA", LinkedEntityId: OPP, ShareType: "I" } });

    const unlinked = fakeApi({
      "sobjects/ContentNote": () => ({ id: "069000000000009AAA", success: true }),
      "sobjects/ContentDocumentLink": () => {
        throw new ProviderError("INSUFFICIENT_ACCESS", 400);
      },
    });
    await expect(action.run(unlinked.api, input, ctx)).rejects.toThrow("saved the note but couldn't attach it");
  });
});
