import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { fromMinor, stripe, STRIPE_VERSION } from "./stripe";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { method: string; path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ method, path, query });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tools: ToolSet, name: string, input: Record<string, unknown>) => (tools[name].execute as any)(input, { toolCallId: "t", messages: [] });

const NOW = new Date("2026-11-15T12:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;
const KEY = { key: "rk_live_abc123" };
const ctx = { accountId: "stripe:acct_1", credentials: KEY };

const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: `INV-${id}`,
  status: "open",
  customer: "cus_1",
  customer_name: "Shah Traders",
  customer_email: "Accounts@Shah.in",
  amount_due: 100000,
  amount_paid: 0,
  amount_remaining: 100000,
  currency: "usd",
  created: unix("2026-09-01T00:00:00Z"),
  due_date: unix("2026-10-01T00:00:00Z"),
  hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
  ...extra,
});
const charge = (id: string, created: string, extra: Record<string, unknown> = {}) => ({
  id,
  amount: 50000,
  amount_captured: 50000,
  amount_refunded: 0,
  captured: true,
  currency: "usd",
  status: "succeeded",
  created: unix(created),
  customer: { id: "cus_1", name: "Shah Traders", email: "Accounts@Shah.in" },
  billing_details: { name: null, email: null },
  payment_intent: `pi_${id}`,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Stripe", () => {
  it("converts minor units per currency", () => {
    expect(fromMinor(123456, "usd")).toBe(1234.56);
    expect(fromMinor(5000, "jpy")).toBe(5000);
    expect(fromMinor(12340, "kwd")).toBe(12.34);
  });

  it("sends the restricted key as a bearer token with a pinned Stripe-Version", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "acct_1" })));
    vi.stubGlobal("fetch", fetch);
    if (stripe.auth.kind !== "token") throw new Error("expected token auth");
    await stripe.auth.api(KEY)("GET", "v1/account");
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.stripe.com/v1/account");
    expect(init.headers).toMatchObject({ authorization: "Bearer rk_live_abc123", "stripe-version": STRIPE_VERSION });
  });

  it("identify names the business, and refuses full secret keys", async () => {
    const { api } = fakeApi({ "v1/account": () => ({ id: "acct_1", business_profile: { name: "Acme Pvt Ltd" } }) });
    expect(await stripe.identify(api, KEY)).toEqual({ accountId: "stripe:acct_1", label: "Acme Pvt Ltd" });
    expect(await stripe.identify(api, { key: "rk_test_x1" })).toEqual({ accountId: "stripe:acct_1", label: "Acme Pvt Ltd (test mode)" });
    await expect(stripe.identify(api, { key: "sk_live_abc" })).rejects.toThrow(/restricted key/);
  });

  it("identify explains a refused key, and falls back to the account Stripe names when Accounts isn't readable", async () => {
    const refused = fakeApi({
      "v1/account": () => {
        throw new ProviderError("GET api.stripe.com/v1/account: 401 Invalid API Key", 401);
      },
    });
    await expect(stripe.identify(refused.api, KEY)).rejects.toThrow(/didn't accept that key/);

    const noAccount = fakeApi({
      "v1/account": () => {
        throw new ProviderError(`GET api.stripe.com/v1/account: 403 {"error":{"message":"The provided key 'rk_live_***abc' does not have the required permissions for this endpoint on account 'acct_9Z'."}}`, 403);
      },
      "v1/balance": () => ({ available: [], pending: [] }),
    });
    expect(await stripe.identify(noAccount.api, KEY)).toEqual({ accountId: "stripe:acct_9Z", label: "acct_9Z" });
  });

  it("stripe_balance gives available and pending per currency in major units", async () => {
    const { api } = fakeApi({ "v1/balance": () => ({ available: [{ amount: 1234567, currency: "usd" }], pending: [{ amount: 50000, currency: "usd" }, { amount: 990000, currency: "inr" }], livemode: true }) });
    const r = await run(stripe.tools!(api, ctx), "stripe_balance", {});
    expect(r).toEqual({ available: { USD: 12345.67 }, pending: { USD: 500, INR: 9900 }, testMode: undefined });
  });

  it("stripe_invoices lists the biggest overdue invoices first, across pages", async () => {
    const { api, calls } = fakeApi({
      "v1/invoices": (q) =>
        q.starting_after
          ? { has_more: false, data: [invoice("c", { amount_remaining: 900000, amount_due: 900000 })] }
          : {
              has_more: true,
              data: [
                invoice("a", { amount_remaining: 20000 }),
                invoice("b", { amount_remaining: 500000, customer_name: "Mehta & Co", customer_email: "pay@mehta.in" }),
                invoice("not-due", { amount_remaining: 9999999, due_date: unix("2026-12-01T00:00:00Z") }),
              ],
            },
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_invoices", { overdueOnly: true, limit: 5 });
    expect(calls[0].query).toMatchObject({ status: "open", limit: 100 });
    expect(calls[1].query).toMatchObject({ starting_after: "not-due" });
    expect(r.count).toBe(3);
    expect(r.totalDue).toEqual({ USD: 14200 });
    expect(r.invoices.map((i: { number: string }) => i.number)).toEqual(["INV-c", "INV-b", "INV-a"]);
    expect(r.invoices[1]).toEqual({
      number: "INV-b",
      status: "open",
      customer: "Mehta & Co",
      email: "pay@mehta.in",
      amountDue: 5000,
      amountPaid: 0,
      currency: "USD",
      created: "2026-09-01",
      dueDate: "2026-10-01",
      daysOverdue: 45,
      paidAt: undefined,
      url: "https://invoice.stripe.com/i/b",
    });
  });

  it("stripe_invoices for one customer asks Stripe for that customer's invoices only", async () => {
    const { api, calls } = fakeApi({
      "v1/customers": (q) => ({ has_more: false, data: q.email === "accounts@shah.in" ? [{ id: "cus_1", email: "accounts@shah.in" }] : [] }),
      "v1/invoices": () => ({ has_more: false, data: [invoice("a")] }),
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_invoices", { customerEmail: "Accounts@Shah.in" });
    expect(calls.find((c) => c.path === "v1/invoices")!.query).toMatchObject({ customer: "cus_1", status: "open" });
    expect(r.invoices).toHaveLength(1);
  });

  it("stripe_payments lists successful payments with the invoice each one paid", async () => {
    const { api, calls } = fakeApi({
      "v1/charges": () => ({
        has_more: false,
        data: [
          charge("ch_2", "2026-11-10T10:00:00Z", { amount_refunded: 10000 }),
          charge("ch_failed", "2026-11-09T10:00:00Z", { status: "failed" }),
          charge("ch_1", "2026-11-01T10:00:00Z", { customer: null, billing_details: { name: "Walk-in", email: "Buyer@Example.com" } }),
        ],
      }),
      "v1/invoice_payments": (q) => ({ has_more: false, data: q["payment[payment_intent]"] === "pi_ch_2" ? [{ id: "inpay_1", invoice: invoice("a", { status: "paid" }) }] : [] }),
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_payments", { since: "2026-11-01" });
    expect(calls[0].query).toMatchObject({ "created[gte]": unix("2026-11-01T00:00:00Z"), "expand[]": "data.customer" });
    expect(calls.find((c) => c.path === "v1/invoice_payments")!.query).toMatchObject({ "payment[type]": "payment_intent", status: "paid", "expand[]": "data.invoice" });
    expect(r.count).toBe(2);
    expect(r.total).toEqual({ USD: 900 });
    expect(r.payments[0]).toEqual({
      date: "2026-11-10T10:00:00.000Z",
      name: "Shah Traders",
      email: "accounts@shah.in",
      amount: 500,
      refunded: 100,
      currency: "USD",
      description: undefined,
      invoice: { number: "INV-a", url: "https://invoice.stripe.com/i/a" },
      id: "pi_ch_2",
    });
    expect(r.payments[1]).toMatchObject({ name: "Walk-in", email: "buyer@example.com", invoice: undefined });
  });

  it("stripe_customer sums lifetime paid and open balance, and lists recent invoices", async () => {
    const { api, calls } = fakeApi({
      "v1/customers/search": () => ({ has_more: false, data: [{ id: "cus_1", name: "Shah Traders", email: "Accounts@Shah.in", created: unix("2025-01-10T00:00:00Z") }] }),
      "v1/charges": () => ({ has_more: false, data: [charge("ch_1", "2026-10-01T00:00:00Z"), charge("ch_2", "2026-09-01T00:00:00Z", { amount_refunded: 50000 })] }),
      "v1/invoices": () => ({ has_more: false, data: [invoice("a"), invoice("d", { status: "draft" }), invoice("p", { status: "paid", amount_paid: 50000, amount_remaining: 0 })] }),
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_customer", { query: "shah" });
    expect(calls[0].query).toMatchObject({ query: 'name~"shah"' });
    expect(r.customers[0]).toMatchObject({
      name: "Shah Traders",
      email: "accounts@shah.in",
      customerSince: "2025-01-10",
      lifetimePaid: { USD: 500 },
      openBalance: { USD: 1000 },
      overdueInvoices: 1,
    });
    expect(r.customers[0].recentInvoices.map((i: { number: string }) => i.number)).toEqual(["INV-a", "INV-p"]);
  });

  it("stripe_customer falls back to listing when Search isn't available (India)", async () => {
    const { api } = fakeApi({
      "v1/customers/search": () => {
        throw new ProviderError("GET api.stripe.com/v1/customers/search: 400 Search is not available", 400);
      },
      "v1/customers": () => ({ has_more: false, data: [{ id: "cus_1", name: "Shah Traders" }, { id: "cus_2", name: "Mehta & Co" }] }),
      "v1/charges": () => ({ has_more: false, data: [] }),
      "v1/invoices": () => ({ has_more: false, data: [] }),
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_customer", { query: "mehta" });
    expect(r.customers.map((c: { name: string }) => c.name)).toEqual(["Mehta & Co"]);
  });

  it("stripe_revenue nets refunds out of each month's payments", async () => {
    const { api, calls } = fakeApi({
      "v1/charges": () => ({
        has_more: false,
        data: [
          charge("ch_3", "2026-11-02T00:00:00Z"),
          charge("ch_2", "2026-10-20T00:00:00Z", { amount_captured: 200000, amount: 200000 }),
          charge("ch_x", "2026-10-21T00:00:00Z", { status: "failed" }),
          charge("ch_1", "2026-10-05T00:00:00Z", { currency: "inr", amount: 1000000, amount_captured: 1000000 }),
        ],
      }),
      "v1/refunds": () => ({ has_more: false, data: [{ id: "re_1", amount: 30000, currency: "usd", status: "succeeded", created: unix("2026-11-03T00:00:00Z") }] }),
    });
    const r = await run(stripe.tools!(api, ctx), "stripe_revenue", { months: 2 });
    expect(calls[0].query["created[gte]"]).toBe(unix("2026-10-01T00:00:00Z"));
    expect(r.months).toEqual([
      { month: "2026-10", currency: "INR", payments: 1, gross: 10000, refunds: 0, net: 10000 },
      { month: "2026-10", currency: "USD", payments: 1, gross: 2000, refunds: 0, net: 2000 },
      { month: "2026-11", currency: "USD", payments: 1, gross: 500, refunds: 300, net: 200 },
    ]);
    expect(r.note).toBeUndefined();
  });

  it("has no sync and no actions: it only reads", () => {
    expect(stripe.sync).toBeUndefined();
    expect(stripe.actions).toBeUndefined();
  });
});
