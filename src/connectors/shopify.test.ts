import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type Api } from "./api";
import { mintShopifyToken, setShopifyPause, shopify, shopOf, SHOPIFY_API_VERSION } from "./shopify";

type Gql = { query: string; variables: Record<string, unknown> };

/** A Shopify GraphQL endpoint answered by a handler; records every query. */
function fakeGql(answer: (q: Gql) => unknown) {
  const calls: Gql[] = [];
  const api: Api = async (method, path, opts = {}) => {
    if (method !== "POST" || path !== "graphql.json") throw new ProviderError(`no route for ${method} ${path}`, 404);
    const body = opts.body as Gql;
    calls.push(body);
    return answer(body) as never;
  };
  return { api, calls };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tools: ToolSet, name: string, input: Record<string, unknown>) => (tools[name].execute as any)(input, { toolCallId: "t", messages: [] });

const NOW = new Date("2026-11-15T12:00:00Z");
const CREDS = { shop: "acme.myshopify.com", clientId: "cid", clientSecret: "csecret" };
const ctx = { accountId: "shopify:acme.myshopify.com", credentials: CREDS };
const money = (amount: number, currencyCode = "INR") => ({ shopMoney: { amount: String(amount), currencyCode } });
const ALL_SCOPES = ["read_orders", "read_all_orders", "read_customers", "read_products", "write_inventory"].map((handle) => ({ handle }));
const scopes = (list = ALL_SCOPES) => ({ data: { currentAppInstallation: { accessScopes: list } } });

const order = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  createdAt: "2026-10-20T09:30:00Z",
  email: "Priya@Shah.in",
  cancelledAt: null,
  test: false,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  customer: { displayName: "Priya Shah" },
  subtotalPriceSet: money(900),
  totalDiscountsSet: money(100),
  totalPriceSet: money(1062),
  lineItems: { nodes: [{ name: "Masala Chai - 500g", sku: "CHAI-500", quantity: 3, originalUnitPriceSet: money(250) }, { name: "Mug", sku: null, quantity: 1, originalUnitPriceSet: money(250) }] },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setShopifyPause(async () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Shopify", () => {
  it("accepts a store's myshopify.com address in the shapes people paste it", () => {
    for (const shop of ["acme", "Acme.myshopify.com", "https://acme.myshopify.com/admin", "https://admin.shopify.com/store/acme/orders"]) expect(shopOf({ shop })).toBe("acme.myshopify.com");
    expect(() => shopOf({ shop: "acme.com" })).toThrow(/myshopify\.com/);
  });

  it("mints a 24-hour token from the client ID and secret and sends it in Shopify's own header", async () => {
    const fetch = vi.fn(async (url: URL | string) =>
      String(url).endsWith("/admin/oauth/access_token")
        ? new Response(JSON.stringify({ access_token: "shpat_minted", scope: "read_orders", expires_in: 86399 }))
        : new Response(JSON.stringify({ data: { shop: { name: "Acme" } } })),
    );
    vi.stubGlobal("fetch", fetch);
    if (shopify.auth.kind !== "token") throw new Error("expected token auth");
    const api = shopify.auth.api(CREDS);
    await api("POST", "graphql.json", { body: { query: "{ shop { name } }" } });
    await api("POST", "graphql.json", { body: { query: "{ shop { name } }" } });

    const [tokenUrl, tokenInit] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(tokenUrl)).toBe("https://acme.myshopify.com/admin/oauth/access_token");
    expect(String(tokenInit.body)).toBe("grant_type=client_credentials&client_id=cid&client_secret=csecret");
    const [gqlUrl, gqlInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(gqlUrl)).toBe(`https://acme.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(gqlInit.headers).toMatchObject({ "x-shopify-access-token": "shpat_minted" });
    expect(gqlInit.headers).not.toHaveProperty("authorization");
    expect(fetch).toHaveBeenCalledTimes(3); // one mint, reused for both queries
  });

  it("explains a refused client ID and secret plainly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." }), { status: 400 })));
    await expect(mintShopifyToken("acme.myshopify.com", "cid", "bad")).rejects.toThrow(/didn't accept that Client ID and secret for acme\.myshopify\.com/);
  });

  it("uses a legacy shpat_ token as is, and asks for credentials when there are none", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal("fetch", fetch);
    if (shopify.auth.kind !== "token") throw new Error("expected token auth");
    await shopify.auth.api({ shop: "acme", token: "shpat_legacy1" })("POST", "graphql.json", { body: {} });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toMatchObject({ "x-shopify-access-token": "shpat_legacy1" });
    expect(() => shopify.auth.kind === "token" && shopify.auth.api({ shop: "acme" })).toThrow(/Client ID and Client secret/);
    expect(() => shopify.auth.kind === "token" && shopify.auth.api({ shop: "acme", token: "pat-123" })).toThrow(/shpat_/);
  });

  it("identify names the store and checks the app was given the scopes it needs", async () => {
    const ok = fakeGql(() => ({ data: { shop: { name: "Acme Tea Co", myshopifyDomain: "acme.myshopify.com" }, currentAppInstallation: { accessScopes: ALL_SCOPES } } }));
    expect(await shopify.identify(ok.api, CREDS)).toEqual({ accountId: "shopify:acme.myshopify.com", label: "Acme Tea Co" });

    const thin = fakeGql(() => ({ data: { shop: { name: "Acme", myshopifyDomain: "acme.myshopify.com" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } }));
    await expect(shopify.identify(thin.api, CREDS)).rejects.toThrow(/read_customers, read_products, read_inventory/);
  });

  it("shopify_orders finds a customer's orders by name, with line items and statuses", async () => {
    const { api, calls } = fakeGql((q) => {
      if (q.query.includes("customers(")) return { data: { customers: { nodes: [{ id: "gid://shopify/Customer/11" }, { id: "gid://shopify/Customer/12" }] } } };
      if (q.query.includes("orders(")) return { data: { orders: { nodes: [order("#1042")] } } };
      return scopes();
    });
    const r = await run(shopify.tools!(api, ctx), "shopify_orders", { customer: "Priya Shah", since: "2026-01-01" });
    expect(calls[0].variables).toEqual({ q: "Priya Shah", n: 5 });
    expect(calls[1].variables).toEqual({ q: "created_at:>=2026-01-01 AND (customer_id:11 OR customer_id:12)", n: 5 });
    expect(r.orders[0]).toEqual({
      order: "#1042",
      date: "2026-10-20",
      customer: "Priya Shah",
      email: "priya@shah.in",
      items: [
        { name: "Masala Chai - 500g", sku: "CHAI-500", quantity: 3, unitPrice: 250 },
        { name: "Mug", sku: undefined, quantity: 1, unitPrice: 250 },
      ],
      subtotal: 900,
      discounts: 100,
      total: 1062,
      currency: "INR",
      payment: "paid",
      fulfillment: "fulfilled",
      cancelled: undefined,
    });
    expect(r.note).toBeUndefined(); // the app has read_all_orders
  });

  it("shopify_orders by email searches orders directly, and warns when older orders are hidden", async () => {
    const { api, calls } = fakeGql((q) => (q.query.includes("orders(") ? { data: { orders: { nodes: [] } } } : scopes([{ handle: "read_orders" }])));
    const r = await run(shopify.tools!(api, ctx), "shopify_orders", { customer: "priya@shah.in", since: "2026-01-01" });
    expect(calls[0].variables.q).toBe('created_at:>=2026-01-01 AND email:"priya@shah.in"');
    expect(r.note).toMatch(/last 60 days/);
  });

  it("shopify_customer gives order count, total spent and last order", async () => {
    const { api, calls } = fakeGql(() => ({
      data: {
        customers: {
          nodes: [
            {
              id: "gid://shopify/Customer/11",
              displayName: "Priya Shah",
              defaultEmailAddress: { emailAddress: "Priya@Shah.in" },
              defaultPhoneNumber: { phoneNumber: "+919800000000" },
              numberOfOrders: "7",
              amountSpent: { amount: "18250.50", currencyCode: "INR" },
              createdAt: "2025-03-02T00:00:00Z",
              tags: ["wholesale"],
              lastOrder: { name: "#1042", createdAt: "2026-10-20T09:30:00Z", totalPriceSet: money(1062) },
            },
          ],
        },
      },
    }));
    const r = await run(shopify.tools!(api, ctx), "shopify_customer", { query: "priya@shah.in" });
    expect(calls[0].variables.q).toBe('email:"priya@shah.in"');
    expect(r.customers[0]).toEqual({
      name: "Priya Shah",
      email: "priya@shah.in",
      phone: "+919800000000",
      orders: 7,
      totalSpent: 18250.5,
      currency: "INR",
      customerSince: "2025-03-02",
      tags: ["wholesale"],
      lastOrder: { order: "#1042", date: "2026-10-20", total: 1062 },
    });
  });

  it("shopify_products gives variants with SKU, price and stock", async () => {
    const { api } = fakeGql(() => ({
      data: {
        shop: { currencyCode: "INR" },
        products: {
          nodes: [
            {
              title: "Masala Chai",
              handle: "masala-chai",
              status: "ACTIVE",
              vendor: "Acme",
              productType: "Tea",
              totalInventory: 40,
              variants: { nodes: [{ title: "500g", sku: "CHAI-500", price: "250.00", inventoryQuantity: 30 }, { title: "1kg", sku: "CHAI-1K", price: "450.00", inventoryQuantity: 10 }] },
            },
            { title: "Gift card", handle: "gift", status: "ACTIVE", totalInventory: null, variants: { nodes: [{ title: "Default Title", sku: "", price: "1000.00", inventoryQuantity: null }] } },
          ],
        },
      },
    }));
    const r = await run(shopify.tools!(api, ctx), "shopify_products", { query: "chai" });
    expect(r.currency).toBe("INR");
    expect(r.products[0]).toEqual({
      title: "Masala Chai",
      status: "active",
      vendor: "Acme",
      type: "Tea",
      inStock: 40,
      variants: [
        { title: "500g", sku: "CHAI-500", price: 250, inStock: 30 },
        { title: "1kg", sku: "CHAI-1K", price: 450, inStock: 10 },
      ],
    });
    expect(r.products[1].variants).toEqual([{ title: undefined, sku: undefined, price: 1000, inStock: undefined }]);
  });

  it("shopify_sales adds up orders across pages, leaving out cancelled and test orders", async () => {
    const { api, calls } = fakeGql((q) => {
      if (!q.query.includes("orders(")) return scopes();
      return q.variables.after
        ? { data: { orders: { nodes: [order("#3", { totalPriceSet: money(500), subtotalPriceSet: money(450), totalDiscountsSet: money(0) })], pageInfo: { hasNextPage: false, endCursor: null } } } }
        : {
            data: {
              orders: {
                nodes: [order("#1"), order("#2", { cancelledAt: "2026-10-21T00:00:00Z" }), order("#t", { test: true })],
                pageInfo: { hasNextPage: true, endCursor: "c1" },
              },
            },
          };
    });
    const r = await run(shopify.tools!(api, ctx), "shopify_sales", { from: "2026-10-01", to: "2026-10-31" });
    expect(calls[0].variables).toEqual({ q: "created_at:>=2026-10-01 AND created_at:<=2026-10-31", after: null });
    expect(calls[1].variables.after).toBe("c1");
    expect(r).toEqual({ from: "2026-10-01", to: "2026-10-31", orders: 2, grossSales: 1450, discounts: 100, netSales: 1350, totalCollected: 1562, averageOrderValue: 781, currency: "INR", note: undefined });
  });

  it("shopify_sales stops at its page cap and says the totals are partial", async () => {
    const { api, calls } = fakeGql((q) =>
      q.query.includes("orders(") ? { data: { orders: { nodes: [order("#1")], pageInfo: { hasNextPage: true, endCursor: "next" } } } } : scopes(),
    );
    const r = await run(shopify.tools!(api, ctx), "shopify_sales", { from: "2026-11-01" });
    expect(calls.filter((c) => c.query.includes("orders(")).length).toBe(8);
    expect(r.orders).toBe(8);
    expect(r.note).toMatch(/Only the first 8 orders/);
  });

  it("waits and retries when Shopify says the query was throttled", async () => {
    const waits: number[] = [];
    setShopifyPause(async (ms) => void waits.push(ms));
    let first = true;
    const { api, calls } = fakeGql(() => {
      if (first) {
        first = false;
        return { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 700, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } } };
      }
      return { data: { shop: { currencyCode: "INR" }, products: { nodes: [] } } };
    });
    const r = await run(shopify.tools!(api, ctx), "shopify_products", {});
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([6000]);
    expect(r.products).toEqual([]);
  });

  it("has no sync and no actions: it only reads", () => {
    expect(shopify.sync).toBeUndefined();
    expect(shopify.actions).toBeUndefined();
  });
});
