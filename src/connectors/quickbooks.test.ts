import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { MINOR_VERSION, qbContains, qbString, quickbooks } from "./quickbooks";

/** A provider API answered from a table of paths (and, for queries, the entity asked for); records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query });
    const key = path.endsWith("/query") ? `query:${/from (\w+)/.exec(String(query.query))?.[1]}` : path;
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? key.startsWith(r.slice(0, -1)) : key === r));
    if (!route) throw new ProviderError(`no route for ${key}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-16T09:00:00Z");
const REALM = "9130350000000001";
const ctx = { accountId: REALM, credentials: { realmId: REALM } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tools: Record<string, any>, name: string, input: Record<string, unknown> = {}) => tools[name].execute(input, { toolCallId: "t", messages: [] });
const sql = (calls: { path: string; query: Record<string, unknown> }[], entity: string) => calls.filter((c) => String(c.query.query ?? "").includes(`from ${entity} `)).map((c) => String(c.query.query));

const inv = (id: string, doc: string, customer: [string, string], due: string, balance: number, extra: Record<string, unknown> = {}) => ({
  Id: id,
  DocNumber: doc,
  TxnDate: "2026-09-01",
  DueDate: due,
  TotalAmt: balance,
  Balance: balance,
  CustomerRef: { value: customer[0], name: customer[1] },
  CurrencyRef: { value: "USD" },
  ...extra,
});

const routes = {
  [`v3/company/${REALM}/companyinfo/${REALM}`]: () => ({ CompanyInfo: { CompanyName: "Acme Inc" } }),
  [`v3/company/${REALM}/preferences`]: () => ({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } } }),
  "query:Invoice": (q: Record<string, unknown>) =>
    String(q.query).includes("Id in")
      ? { QueryResponse: { Invoice: [{ Id: "101", DocNumber: "1001" }, { Id: "102", DocNumber: "1002" }] } }
      : {
          QueryResponse: {
            Invoice: [
              inv("1", "1001", ["11", "Globex"], "2026-10-01", 5000, { BillEmail: { Address: "ap@globex.com" } }),
              inv("2", "1002", ["12", "Initech"], "2026-12-01", 9000),
              inv("3", "1003", ["12", "Initech"], "2026-11-10", 1200.5),
            ],
          },
        },
  "query:Customer": (q: Record<string, unknown>) =>
    String(q.query).includes("Id in")
      ? { QueryResponse: { Customer: [{ Id: "12", DisplayName: "Initech", PrimaryEmailAddr: { Address: "billing@initech.com" } }] } }
      : String(q.query).includes("DisplayName")
        ? { QueryResponse: { Customer: [{ Id: "7", DisplayName: "O'Brien & Sons", PrimaryEmailAddr: { Address: "pat@obrien.ie" }, Balance: 700, CurrencyRef: { value: "EUR" } }] } }
        : { QueryResponse: {} },
  "query:Bill": () => ({
    QueryResponse: {
      Bill: [
        { Id: "b1", DocNumber: "AWS-11", DueDate: "2026-11-20", TotalAmt: 800, Balance: 800, VendorRef: { name: "AWS" } },
        { Id: "b2", DueDate: "2026-11-01", TotalAmt: 2500, Balance: 2500, VendorRef: { name: "Landlord" } },
        { Id: "b3", DueDate: "2027-02-01", TotalAmt: 4000, Balance: 4000, VendorRef: { name: "Lawyer" } },
      ],
    },
  }),
  "query:Payment": () => ({
    QueryResponse: {
      Payment: [
        {
          Id: "p1",
          TxnDate: "2026-11-12",
          TotalAmt: 1700,
          UnappliedAmt: 0,
          CustomerRef: { value: "c1", name: "Globex" },
          CurrencyRef: { value: "USD" },
          Line: [
            { Amount: 1000, LinkedTxn: [{ TxnId: "101", TxnType: "Invoice" }] },
            { Amount: 700, LinkedTxn: [{ TxnId: "102", TxnType: "Invoice" }] },
          ],
        },
      ],
    },
  }),
  "query:Account": () => ({
    QueryResponse: {
      Account: [
        { Id: "35", Name: "Checking", CurrentBalance: 25000.456, CurrencyRef: { value: "USD" }, Active: true },
        { Id: "36", Name: "Savings", CurrentBalance: 10000, CurrencyRef: { value: "USD" }, Active: true },
      ],
    },
  }),
  [`v3/company/${REALM}/reports/ProfitAndLoss`]: () => ({
    Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-11-01", EndPeriod: "2026-11-16", Currency: "USD", ReportBasis: "Accrual" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
    Rows: {
      Row: [
        {
          type: "Section",
          group: "Income",
          Header: { ColData: [{ value: "Income" }, { value: "" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Services" }, { value: "20000.00" }] }] },
          Summary: { ColData: [{ value: "Total Income" }, { value: "20000.00" }] },
        },
        { type: "Section", group: "NetIncome", Summary: { ColData: [{ value: "Net Income" }, { value: "4500.25" }] } },
      ],
    },
  }),
  [`v3/company/${REALM}/reports/AgedReceivables`]: () => ({
    Header: { ReportName: "AgedReceivables", Currency: "USD" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Current" }, { ColTitle: "1 - 30" }, { ColTitle: "Total" }] },
    Rows: {
      Row: [
        { ColData: [{ value: "Globex", id: "c1" }, { value: "" }, { value: "5000.00" }, { value: "5000.00" }] },
        { type: "Section", group: "GrandTotal", Summary: { ColData: [{ value: "TOTAL" }, { value: "0.00" }, { value: "5000.00" }, { value: "5000.00" }] } },
      ],
    },
  }),
};

describe("QuickBooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses the production host unless QUICKBOOKS_ENVIRONMENT=sandbox, and may call both", () => {
    const auth = quickbooks.auth.kind === "oauth" ? quickbooks.auth : undefined;
    expect(auth?.scopes).toEqual(["com.intuit.quickbooks.accounting"]);
    expect(auth?.baseUrl).toBe("https://quickbooks.api.intuit.com/");
    vi.stubEnv("QUICKBOOKS_ENVIRONMENT", "sandbox");
    expect(auth?.baseUrl).toBe("https://sandbox-quickbooks.api.intuit.com/");
    expect(auth?.hosts).toEqual(["quickbooks.api.intuit.com", "sandbox-quickbooks.api.intuit.com"]);
  });

  it("identify names the company from the realmId the sign-in returned", async () => {
    const { api, calls } = fakeApi(routes);
    expect(await quickbooks.identify(api, { realmId: REALM })).toEqual({ accountId: REALM, label: "Acme Inc" });
    expect(calls[0].query.minorversion).toBe(MINOR_VERSION);
  });

  it("identify refuses without a realmId", async () => {
    const { api } = fakeApi(routes);
    await expect(quickbooks.identify(api, {})).rejects.toThrow(/which company/);
  });

  it("escapes values put into queries", () => {
    expect(qbString("O'Brien \\ Co")).toBe("'O\\'Brien \\\\ Co'");
    expect(qbContains("50% o'clock\n")).toBe("'%50 o\\'clock%'");
  });

  it("receivables: biggest overdue first, billing email or the customer's", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_receivables", { overdueOnly: true });
    expect(sql(calls, "Invoice")[0]).toBe("select * from Invoice where Balance > '0' orderby DueDate startposition 1 maxresults 1000");
    expect(r.invoices).toEqual([
      { number: "1001", issued: "2026-09-01", due: "2026-10-01", overdue: true, daysOverdue: 46, total: 5000, amountDue: 5000, currency: "USD", customer: "Globex", email: "ap@globex.com" },
      { number: "1003", issued: "2026-09-01", due: "2026-11-10", overdue: true, daysOverdue: 6, total: 1200.5, amountDue: 1200.5, currency: "USD", customer: "Initech", email: "billing@initech.com" },
    ]);
    expect(sql(calls, "Customer")[0]).toContain("where Id in ('12')");
    expect(r.totals).toEqual([{ currency: "USD", outstanding: 15200.5, overdue: 6200.5, count: 3 }]);
  });

  it("payables: overdue and soon-due bills, soonest first", async () => {
    const { api } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_payables", {});
    expect(r.bills.map((b: { supplier: string }) => b.supplier)).toEqual(["Landlord", "AWS"]);
    expect(r.bills[0]).toMatchObject({ overdue: true, daysOverdue: 15, amountDue: 2500, currency: "USD" });
  });

  it("payments: since a date, with the invoice numbers each paid", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_payments", { since: "2026-11-09" });
    expect(sql(calls, "Payment")[0]).toBe("select * from Payment where TxnDate >= '2026-11-09' orderby TxnDate desc startposition 1 maxresults 1000");
    expect(sql(calls, "Invoice")[0]).toContain("where Id in ('101','102')");
    expect(r.payments).toEqual([
      {
        date: "2026-11-12",
        direction: "received",
        customer: "Globex",
        amount: 1700,
        currency: "USD",
        paid: [
          { invoice: "1001", amount: 1000 },
          { invoice: "1002", amount: 700 },
        ],
        unapplied: undefined,
        reference: undefined,
      },
    ]);
  });

  it("cash: bank account balances with a total per currency", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_cash");
    expect(sql(calls, "Account")[0]).toContain("where AccountType = 'Bank'");
    expect(r.accounts).toEqual([
      { account: "Checking", currency: "USD", balance: 25000.46 },
      { account: "Savings", currency: "USD", balance: 10000 },
    ]);
    expect(r.totals).toEqual([{ currency: "USD", balance: 35000.46, count: 2 }]);
  });

  it("report: profit and loss flattened to top-level totals", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_report", { report: "profit_and_loss" });
    expect(calls[0].query).toMatchObject({ start_date: "2026-11-01", end_date: "2026-11-16", minorversion: MINOR_VERSION });
    expect(r).toMatchObject({ source: "QuickBooks", report: "ProfitAndLoss", currency: "USD", columns: ["Total"] });
    expect(r.rows).toEqual([
      { section: "Income", label: "Total Income", values: [20000] },
      { section: "NetIncome", label: "Net Income", values: [4500.25] },
    ]);
  });

  it("report: aged receivables keeps each customer's row", async () => {
    const { api } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_report", { report: "aged_receivables", to: "2026-11-16" });
    expect(r.rows[0]).toEqual({ section: undefined, label: "Globex", values: ["", 5000, 5000] });
    expect(r.rows[1].label).toBe("TOTAL");
  });

  it("customer: escaped name search, open balance, overdue and unpaid invoices", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(quickbooks.tools!(api, ctx), "quickbooks_customer", { name: "O'Brien" });
    expect(sql(calls, "Customer")[0]).toContain("where DisplayName like '%O\\'Brien%'");
    expect(sql(calls, "Invoice")[0]).toContain("where CustomerRef = '7' and Balance > '0'");
    expect(r.customer).toMatchObject({ name: "O'Brien & Sons", email: "pat@obrien.ie", balance: 700, overdue: 6200.5 });
  });
});
