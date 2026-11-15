import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { flattenReport, xero, xeroDate } from "./xero";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, headers: opts.headers ?? {} });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-16T09:00:00Z");
const ctx = { accountId: "tenant-1", credentials: {} };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tools: Record<string, any>, name: string, input: Record<string, unknown> = {}) => tools[name].execute(input, { toolCallId: "t", messages: [] });

const invoice = (n: string, contactId: string, contact: string, due: string, amountDue: number, extra: Record<string, unknown> = {}) => ({
  InvoiceID: `id-${n}`,
  InvoiceNumber: n,
  Type: "ACCREC",
  Status: "AUTHORISED",
  Contact: { ContactID: contactId, Name: contact },
  DateString: "2026-09-01T00:00:00",
  DueDateString: `${due}T00:00:00`,
  Total: amountDue,
  AmountDue: amountDue,
  CurrencyCode: "GBP",
  ...extra,
});

const routes = {
  "https://api.xero.com/connections": () => [
    { tenantId: "old", tenantType: "ORGANISATION", tenantName: "Old Co", updatedDateUtc: "2025-01-01T00:00:00" },
    { tenantId: "practice", tenantType: "PRACTICEMANAGER", tenantName: "Practice", updatedDateUtc: "2026-11-15T00:00:00" },
    { tenantId: "tenant-1", tenantType: "ORGANISATION", tenantName: "Acme Ltd", updatedDateUtc: "2026-11-14T00:00:00" },
  ],
  Organisation: () => ({ Organisations: [{ Name: "Acme Ltd", BaseCurrency: "GBP" }] }),
  Invoices: (q: Record<string, unknown>) =>
    q.where === 'Type=="ACCREC"'
      ? {
          Invoices: [
            invoice("INV-1", "c1", "Globex", "2026-10-01", 5000),
            invoice("INV-2", "c2", "Initech", "2026-12-01", 9000),
            invoice("INV-3", "c1", "Globex", "2026-11-10", 1200.5),
            invoice("INV-4", "c3", "Umbrella", "2026-08-01", 300, { CurrencyCode: "USD" }),
            invoice("INV-5", "c2", "Initech", "2026-10-15", 0),
          ],
        }
      : {
          Invoices: [
            invoice("BILL-1", "s1", "AWS", "2026-11-20", 800, { Type: "ACCPAY" }),
            invoice("BILL-2", "s2", "Landlord", "2026-11-01", 2500, { Type: "ACCPAY" }),
            invoice("BILL-3", "s3", "Lawyer", "2027-02-01", 4000, { Type: "ACCPAY" }),
          ],
        },
  Contacts: (q: Record<string, unknown>) =>
    q.IDs
      ? {
          Contacts: String(q.IDs)
            .split(",")
            .map((id) => ({ ContactID: id, Name: id, EmailAddress: id === "c3" ? "" : `ar@${id}.com`, ContactPersons: id === "c3" ? [{ EmailAddress: "pay@umbrella.com", IncludeInEmails: true }] : [] })),
        }
      : { Contacts: [{ ContactID: "c1", Name: "Globex", EmailAddress: "ar@globex.com" }, { ContactID: "c9", Name: "Globex Asia" }] },
  "Contacts/c1": () => ({
    Contacts: [{ ContactID: "c1", Name: "Globex", EmailAddress: "ar@globex.com", IsCustomer: true, Balances: { AccountsReceivable: { Outstanding: 6200.5, Overdue: 6200.5 }, AccountsPayable: { Outstanding: 0, Overdue: 0 } } }],
  }),
  Payments: () => ({
    Payments: [
      { PaymentID: "p1", Date: "/Date(1763164800000+0000)/", Amount: 1500, PaymentType: "ACCRECPAYMENT", Status: "AUTHORISED", CurrencyRate: 1, Invoice: { InvoiceNumber: "INV-0", Contact: { ContactID: "c1", Name: "Globex" } } },
      { PaymentID: "p2", Date: "/Date(1763164800000+0000)/", Amount: 200, PaymentType: "ACCPAYPAYMENT", Status: "AUTHORISED", Invoice: { InvoiceNumber: "BILL-0", Contact: { ContactID: "s1", Name: "AWS" } } },
    ],
  }),
  Accounts: () => ({ Accounts: [{ AccountID: "b1", Name: "Barclays", CurrencyCode: "GBP" }, { AccountID: "b2", Name: "Wise USD", CurrencyCode: "USD" }] }),
  "Reports/BankSummary": () => ({
    Reports: [
      {
        ReportName: "Bank Summary",
        Rows: [
          { RowType: "Header", Cells: [{ Value: "Bank Accounts" }, { Value: "Opening Balance" }, { Value: "Cash Received" }, { Value: "Cash Spent" }, { Value: "Closing Balance" }] },
          {
            RowType: "Section",
            Title: "",
            Rows: [
              { RowType: "Row", Cells: [{ Value: "Barclays", Attributes: [{ Id: "accountID", Value: "b1" }] }, { Value: "10,000.00" }, { Value: "1500.00" }, { Value: "700.00" }, { Value: "10,800.00" }] },
              { RowType: "Row", Cells: [{ Value: "Wise USD", Attributes: [{ Id: "accountID", Value: "b2" }] }, { Value: "50.00" }, { Value: "0.00" }, { Value: "0.00" }, { Value: "50.00" }] },
              { RowType: "SummaryRow", Cells: [{ Value: "Total" }, { Value: "10050.00" }, { Value: "1500.00" }, { Value: "700.00" }, { Value: "10850.00" }] },
            ],
          },
        ],
      },
    ],
  }),
  "Reports/ProfitAndLoss": () => ({
    Reports: [
      {
        ReportName: "Profit and Loss",
        ReportTitles: ["Profit and Loss", "Acme Ltd", "1 November 2026 to 16 November 2026"],
        Rows: [
          { RowType: "Header", Cells: [{ Value: "" }, { Value: "16 Nov 2026" }] },
          {
            RowType: "Section",
            Title: "Income",
            Rows: [
              { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "20000.00" }] },
              { RowType: "SummaryRow", Cells: [{ Value: "Total Income" }, { Value: "20000.00" }] },
            ],
          },
          { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [{ Value: "Gross Profit" }, { Value: "18000.00" }] }] },
          { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [{ Value: "Net Profit" }, { Value: "4,500.25" }] }] },
        ],
      },
    ],
  }),
};

describe("Xero", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("asks for granular read-only scopes", () => {
    expect(xero.auth).toMatchObject({ kind: "oauth", app: "xero", baseUrl: "https://api.xero.com/api.xro/2.0/" });
    const scopes = xero.auth.kind === "oauth" ? xero.auth.scopes : [];
    expect(scopes.every((s) => s.endsWith(".read"))).toBe(true);
    expect(scopes).not.toContain("accounting.transactions.read");
  });

  it("identify names the organisation most recently connected", async () => {
    const { api } = fakeApi(routes);
    expect(await xero.identify(api, {})).toEqual({ accountId: "tenant-1", label: "Acme Ltd" });
  });

  it("identify refuses when no organisation was shared", async () => {
    const { api } = fakeApi({ "https://api.xero.com/connections": () => [] });
    await expect(xero.identify(api, {})).rejects.toThrow(/organisation/);
  });

  it("receivables: biggest overdue first with emails, totals per currency, tenant header on every call", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_receivables", { overdueOnly: true, limit: 5 });
    expect(r.invoices.map((i: { number: string }) => i.number)).toEqual(["INV-1", "INV-3", "INV-4"]);
    expect(r.invoices[0]).toMatchObject({ contact: "Globex", email: "ar@c1.com", amountDue: 5000, currency: "GBP", due: "2026-10-01", overdue: true, daysOverdue: 46 });
    expect(r.invoices[2].email).toBe("pay@umbrella.com");
    expect(r.totals).toEqual([
      { currency: "GBP", outstanding: 15200.5, overdue: 6200.5, count: 3 },
      { currency: "USD", outstanding: 300, overdue: 300, count: 1 },
    ]);
    expect(calls.find((c) => c.path === "Invoices")!.query).toMatchObject({ Statuses: "AUTHORISED", where: 'Type=="ACCREC"' });
    expect(calls.every((c) => c.headers["xero-tenant-id"] === "tenant-1")).toBe(true);
  });

  it("payables: overdue and soon-due bills, soonest first", async () => {
    const { api } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_payables", { dueWithinDays: 14 });
    expect(r.bills.map((b: { number: string }) => b.number)).toEqual(["BILL-2", "BILL-1"]);
    expect(r.bills[0]).toMatchObject({ supplier: "Landlord", overdue: true, amountDue: 2500 });
    expect(r.bills[0].email).toBeUndefined();
    expect(r.allUnpaid).toEqual([{ currency: "GBP", due: 7300, count: 3 }]);
  });

  it("payments: received since a date with the invoice each paid", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_payments", { since: "2026-11-09" });
    expect(calls.find((c) => c.path === "Payments")!.query.where).toBe('Date>=DateTime(2026,11,9) AND Status=="AUTHORISED"');
    expect(r.payments).toEqual([{ date: "2025-11-15", direction: "received", contact: "Globex", invoiceNumber: "INV-0", amount: 1500, currency: "GBP", reference: undefined }]);
  });

  it("cash: bank summary per account with each account's currency", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_cash");
    expect(calls.find((c) => c.path === "Reports/BankSummary")!.query).toEqual({ fromDate: "2026-11-01", toDate: "2026-11-16" });
    expect(r.accounts).toEqual([
      { account: "Barclays", currency: "GBP", opening: 10000, received: 1500, spent: 700, closing: 10800 },
      { account: "Wise USD", currency: "USD", opening: 50, received: 0, spent: 0, closing: 50 },
    ]);
    expect(r.note).toMatch(/different currencies/);
  });

  it("report: profit and loss flattened to totals", async () => {
    const { api } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_report", { report: "profit_and_loss" });
    expect(r.rows).toEqual([
      { section: "Income", label: "Total Income", values: [20000] },
      { section: undefined, label: "Gross Profit", values: [18000] },
      { section: undefined, label: "Net Profit", values: [4500.25] },
    ]);
  });

  it("report: aged receivables bucketed per customer from open invoices", async () => {
    const { api } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_report", { report: "aged_receivables" });
    expect(r.rows[0]).toEqual({ contact: "Initech", currency: "GBP", total: 9000, current: 9000, "1-30": 0, "31-60": 0, "61-90": 0, "over 90": 0 });
    expect(r.rows.find((x: { contact: string }) => x.contact === "Globex")).toMatchObject({ total: 6200.5, "1-30": 1200.5, "31-60": 5000 });
  });

  it("contact: balances from the single-contact call and unpaid invoices", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await run(xero.tools!(api, ctx), "xero_contact", { name: "globex" });
    expect(calls[0]).toMatchObject({ path: "Contacts", query: { searchTerm: "globex" } });
    expect(r.contact).toMatchObject({ name: "Globex", email: "ar@globex.com", owesUs: { outstanding: 6200.5, overdue: 6200.5 } });
    expect(r.otherMatches).toEqual([{ name: "Globex Asia", email: undefined }]);
    expect(calls.find((c) => c.path === "Invoices")!.query.ContactIDs).toBe("c1");
  });

  it("reads Xero's two date formats", () => {
    expect(xeroDate("2026-11-30T00:00:00")).toBe("2026-11-30");
    expect(xeroDate(undefined, "/Date(1764460800000+0000)/")).toBe("2025-11-30");
    expect(flattenReport({}).rows).toEqual([]);
  });
});
