import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { razorpay } from "./razorpay";

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
const KEYS = { keyId: "rzp_live_AbCdEf12345678", keySecret: "s3cret" };
const ctx = { accountId: "razorpay:live:AbCdEf12345678", credentials: KEYS };
const collection = (items: unknown[]) => ({ entity: "collection", count: items.length, items });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Razorpay", () => {
  it("sends the key id and secret as Basic auth", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(collection([]))));
    vi.stubGlobal("fetch", fetch);
    if (razorpay.auth.kind !== "token") throw new Error("expected token auth");
    await razorpay.auth.api(KEYS)("GET", "payments", { query: { count: 1 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.razorpay.com/v1/payments?count=1");
    expect(init.headers).toMatchObject({ authorization: `Basic ${Buffer.from("rzp_live_AbCdEf12345678:s3cret").toString("base64")}` });
  });

  it("identify proves the keys with one cheap call and names the connection after the key", async () => {
    const { api, calls } = fakeApi({ payments: () => collection([]) });
    expect(await razorpay.identify(api, KEYS)).toEqual({ accountId: "razorpay:live:AbCdEf12345678", label: "Razorpay key …5678" });
    expect(calls).toEqual([{ method: "GET", path: "payments", query: { count: 1 } }]);
    expect(await razorpay.identify(api, { keyId: "rzp_test_Zz9", keySecret: "x" })).toEqual({ accountId: "razorpay:test:Zz9", label: "Razorpay test key …Zz9" });
    await expect(razorpay.identify(api, { keyId: "pk_live_x", keySecret: "x" })).rejects.toThrow(/rzp_live_/);

    const refused = fakeApi({
      payments: () => {
        throw new ProviderError("GET api.razorpay.com/v1/payments: 401 The api key provided is invalid", 401);
      },
    });
    await expect(razorpay.identify(refused.api, KEYS)).rejects.toThrow(/didn't accept/);
  });

  it("razorpay_payments lists captured payments in rupees with their order, invoice and notes", async () => {
    const { api, calls } = fakeApi({
      payments: () =>
        collection([
          { id: "pay_2", amount: 1250050, currency: "INR", status: "captured", amount_refunded: 50, order_id: "order_9", invoice_id: "inv_7", method: "upi", email: "Accounts@Shah.in", contact: "+919800000000", notes: { po: "PO-42" }, created_at: unix("2026-11-10T05:00:00Z") },
          { id: "pay_1", amount: 99900, currency: "INR", status: "failed", notes: [], created_at: unix("2026-11-09T05:00:00Z") },
          { id: "pay_0", amount: 50000, currency: "INR", status: "captured", method: "card", email: "x@y.com", notes: [], created_at: unix("2026-11-08T05:00:00Z") },
        ]),
    });
    const r = await run(razorpay.tools!(api, ctx), "razorpay_payments", { since: "2026-11-01" });
    expect(calls[0].query).toMatchObject({ from: unix("2026-11-01T00:00:00Z"), count: 100, skip: 0 });
    expect(r.count).toBe(2);
    expect(r.total).toEqual({ INR: 13000 });
    expect(r.payments[0]).toEqual({
      id: "pay_2",
      date: "2026-11-10T05:00:00.000Z",
      amount: 12500.5,
      refunded: 0.5,
      currency: "INR",
      method: "upi",
      email: "accounts@shah.in",
      phone: "+919800000000",
      description: undefined,
      orderId: "order_9",
      invoiceId: "inv_7",
      notes: { po: "PO-42" },
    });
    expect(r.payments[1].notes).toBeUndefined();

    const one = await run(razorpay.tools!(api, ctx), "razorpay_payments", { customer: "shah.in" });
    expect(one.payments.map((p: { id: string }) => p.id)).toEqual(["pay_2"]);
  });

  it("razorpay_payments pages with skip and says when it stopped early", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `pay_${i}`, amount: 100, currency: "INR", status: "captured", created_at: unix("2026-11-10T00:00:00Z") }));
    const { api, calls } = fakeApi({ payments: () => collection(page) });
    const r = await run(razorpay.tools!(api, ctx), "razorpay_payments", {});
    expect(calls.map((c) => c.query.skip)).toEqual([0, 100, 200, 300, 400]);
    expect(r.note).toMatch(/most recent 500/);
  });

  it("razorpay_invoices puts the biggest overdue invoice first", async () => {
    const inv = (id: string, status: string, due: number, expire: string, extra: Record<string, unknown> = {}) => ({
      id,
      invoice_number: `#${id}`,
      status,
      amount: due + 1000,
      amount_paid: 1000,
      amount_due: due,
      currency: "INR",
      customer_details: { name: "Shah Traders", email: "Accounts@Shah.in", contact: "+919800000000" },
      issued_at: unix("2026-10-01T00:00:00Z"),
      expire_by: unix(expire),
      short_url: `https://rzp.io/i/${id}`,
      ...extra,
    });
    const { api, calls } = fakeApi({
      invoices: () =>
        collection([
          inv("a", "issued", 500000, "2026-11-05T00:00:00Z"),
          inv("b", "partially_paid", 900000, "2026-11-01T00:00:00Z", { customer_details: { name: "Mehta & Co", email: "pay@mehta.in" } }),
          inv("c", "issued", 2000000, "2026-12-30T00:00:00Z"),
          inv("d", "paid", 0, "2026-10-30T00:00:00Z"),
          inv("e", "expired", 300000, "2026-10-10T00:00:00Z"),
        ]),
    });
    const tools = razorpay.tools!(api, ctx);
    const overdue = await run(tools, "razorpay_invoices", { overdueOnly: true });
    expect(calls[0].query).toMatchObject({ type: "invoice", count: 100 });
    expect(overdue.invoices.map((i: { number: string }) => i.number)).toEqual(["#b", "#a"]);
    expect(overdue.totalDue).toEqual({ INR: 14000 });
    expect(overdue.invoices[0]).toEqual({
      number: "#b",
      status: "partially_paid",
      name: "Mehta & Co",
      email: "pay@mehta.in",
      phone: undefined,
      amount: 9010,
      amountPaid: 10,
      amountDue: 9000,
      currency: "INR",
      issued: "2026-10-01",
      dueDate: "2026-11-01",
      daysOverdue: 14,
      url: "https://rzp.io/i/b",
    });

    const unpaid = await run(tools, "razorpay_invoices", { customer: "shah" });
    expect(unpaid.invoices.map((i: { number: string }) => i.number)).toEqual(["#c", "#a", "#e"]);
  });

  it("razorpay_settlements totals what reached the bank", async () => {
    const { api, calls } = fakeApi({
      settlements: () =>
        collection([
          { id: "setl_2", amount: 4500000, status: "processed", fees: 9000, tax: 1620, utr: "UTR123", created_at: unix("2026-11-12T00:00:00Z") },
          { id: "setl_1", amount: 100000, status: "created", fees: 0, tax: 0, utr: null, created_at: unix("2026-11-13T00:00:00Z") },
        ]),
    });
    const r = await run(razorpay.tools!(api, ctx), "razorpay_settlements", {});
    expect(calls[0].query.from).toBe(unix("2026-10-16T12:00:00Z"));
    expect(r.settledToBank).toBe(45000);
    expect(r.settlements[0]).toEqual({ id: "setl_2", date: "2026-11-12T00:00:00.000Z", amount: 45000, status: "processed", fees: 90, tax: 16.2, utr: "UTR123" });
  });

  it("razorpay_payment_links lists links still waiting for money", async () => {
    const { api } = fakeApi({
      payment_links: () => ({
        payment_links: [
          { id: "plink_1", amount: 300000, amount_paid: 100000, currency: "INR", status: "partially_paid", customer: { name: "Priya", email: "Priya@Shah.in", contact: "+91980" }, expire_by: unix("2026-12-01T00:00:00Z"), short_url: "https://rzp.io/l/1", reference_id: "Q-12", created_at: unix("2026-11-01T00:00:00Z") },
          { id: "plink_2", amount: 50000, amount_paid: 50000, currency: "INR", status: "paid", customer: [], created_at: unix("2026-11-02T00:00:00Z") },
          { id: "plink_3", amount: 70000, amount_paid: 0, currency: "INR", status: "created", customer: [], created_at: unix("2026-11-03T00:00:00Z") },
        ],
      }),
    });
    const r = await run(razorpay.tools!(api, ctx), "razorpay_payment_links", {});
    expect(r.count).toBe(2);
    expect(r.outstanding).toEqual({ INR: 2700 });
    expect(r.links.map((l: { id: string }) => l.id)).toEqual(["plink_3", "plink_1"]);
    expect(r.links[0].customer).toBeUndefined();
    expect(r.links[1]).toMatchObject({ amount: 3000, amountPaid: 1000, customer: { name: "Priya", email: "priya@shah.in", phone: "+91980" }, reference: "Q-12", expires: "2026-12-01" });
  });

  it("has no sync and no actions: it only reads", () => {
    expect(razorpay.sync).toBeUndefined();
    expect(razorpay.actions).toBeUndefined();
  });
});
