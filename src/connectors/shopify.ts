import { tool } from "ai";
import { z } from "zod";
import { httpApi, mintedBearer, postForm, ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

/** Pinned GraphQL Admin API version (released 2026-10-01, supported until October 2027). */
export const SHOPIFY_API_VERSION = "2026-10";
/** Scopes the tools need. write_* also grants read_*. */
const REQUIRED_SCOPES = ["read_orders", "read_customers", "read_products", "read_inventory"];
/** Orders read per page when adding up sales; keeps one query under Shopify's 1,000-point cost limit. */
const SALES_PAGE = 100;
/** Pages read when adding up sales; past this the answer says it's partial. */
const MAX_SALES_PAGES = 8;
/** Longest wait for Shopify's rate limit to refill before giving up on one query. */
const MAX_THROTTLE_WAIT_MS = 10_000;

let pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tests swap the throttle wait for an instant one. */
export const setShopifyPause = (fn: (ms: number) => Promise<void>) => {
  pause = fn;
};

/**
 * "acme", "acme.myshopify.com", a pasted admin URL (admin.shopify.com/store/acme) or
 * https://acme.myshopify.com/admin, as "acme.myshopify.com". A custom domain won't do:
 * the Admin API only answers on the myshopify.com address.
 */
export function shopOf(credentials: Record<string, string>): string {
  let s = (credentials.shop ?? "").trim().toLowerCase().replace(/^https?:\/\//, "");
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(s);
  if (admin) return `${admin[1]}.myshopify.com`;
  s = s.replace(/[/?#].*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s))
    throw new Error("Enter your store's myshopify.com address, e.g. acme.myshopify.com (Shopify admin → Settings → Domains). A custom domain like acme.com won't work.");
  return s;
}

/** Trades a Dev Dashboard app's client ID and secret for an Admin API token (valid 24 hours). */
export async function mintShopifyToken(shop: string, clientId: string, clientSecret: string): Promise<{ accessToken: string; expiresIn: number }> {
  const r = await postForm(`https://${shop}/admin/oauth/access_token`, { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).catch((e) => {
    if (e instanceof ProviderError && e.status === 404) throw new Error(`There's no Shopify store at ${shop}.`);
    if (e instanceof ProviderError && e.status < 500 && e.status !== 429)
      throw new Error(
        `Shopify didn't accept that Client ID and secret for ${shop}. Copy both from the app's Settings page in the Dev Dashboard, and check the app is installed on this store and was created in the store's own organization.`,
      );
    throw e;
  });
  if (typeof r.access_token !== "string") throw new Error("Shopify didn't return an access token for that app.");
  return { accessToken: r.access_token, expiresIn: Number(r.expires_in) || 86399 };
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

/**
 * One GraphQL Admin API query. Shopify reports rate limiting inside a 200 response
 * (THROTTLED), so this waits for the bucket to refill and tries again, twice at most.
 */
async function gql<T>(api: Api, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await api<GqlResponse<T>>("POST", "graphql.json", { body: { query, variables } });
    const throttled = r.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 2) {
      const cost = r.extensions?.cost;
      const need = (cost?.requestedQueryCost ?? 100) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
      await pause(Math.min(MAX_THROTTLE_WAIT_MS, Math.max(1000, (need / (cost?.throttleStatus?.restoreRate || 50)) * 1000)));
      continue;
    }
    // Fields a store hasn't granted come back as null with an error alongside; keep what did come back.
    if (r.errors?.length && !r.data) throw new ProviderError(`Shopify: ${r.errors.map((e) => e.message).join("; ")}`, throttled ? 429 : 400);
    return r.data as T;
  }
}

interface Money {
  shopMoney: { amount: string; currencyCode: string };
}
const amt = (m: Money | null | undefined) => (m ? Number(m.shopMoney.amount) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10-01" checked, for Shopify's search syntax (read in the store's time zone). */
function dateOf(s: string): string {
  const d = s.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`"${s}" isn't a date. Use YYYY-MM-DD.`);
  return d;
}
const quoted = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

const ORDER_FIELDS = `
  name createdAt email cancelledAt displayFinancialStatus displayFulfillmentStatus
  customer { displayName }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 25) { nodes { name sku quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } }`;

interface Order {
  name: string;
  createdAt: string;
  email?: string | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customer?: { displayName?: string | null } | null;
  subtotalPriceSet?: Money | null;
  totalDiscountsSet?: Money | null;
  totalPriceSet?: Money | null;
  lineItems?: { nodes: { name: string; sku?: string | null; quantity: number; originalUnitPriceSet?: Money | null }[] };
}
interface Customer {
  id: string;
  displayName?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  numberOfOrders?: string | number | null;
  amountSpent?: { amount: string; currencyCode: string } | null;
  createdAt?: string;
  tags?: string[];
  lastOrder?: { name: string; createdAt: string; totalPriceSet?: Money | null } | null;
}

const orderRow = (o: Order) => ({
  order: o.name,
  date: o.createdAt.slice(0, 10),
  customer: o.customer?.displayName || undefined,
  email: o.email?.toLowerCase() || undefined,
  items: (o.lineItems?.nodes ?? []).map((l) => ({ name: l.name, sku: l.sku || undefined, quantity: l.quantity, unitPrice: amt(l.originalUnitPriceSet) })),
  subtotal: amt(o.subtotalPriceSet),
  discounts: amt(o.totalDiscountsSet) || undefined,
  total: amt(o.totalPriceSet),
  currency: o.totalPriceSet?.shopMoney.currencyCode,
  payment: o.displayFinancialStatus?.toLowerCase(),
  fulfillment: o.displayFulfillmentStatus?.toLowerCase(),
  cancelled: o.cancelledAt ? true : undefined,
});

/** Whether the app may read orders older than 60 days. */
async function readsAllOrders(api: Api): Promise<boolean> {
  const r = await gql<{ currentAppInstallation?: { accessScopes: { handle: string }[] } }>(api, `{ currentAppInstallation { accessScopes { handle } } }`).catch(() => undefined);
  return !!r?.currentAppInstallation?.accessScopes.some((s) => s.handle === "read_all_orders");
}
const OLD_ORDERS_NOTE = "Shopify only shows this app orders from the last 60 days. To see older ones, add the read_all_orders scope to the app in the Dev Dashboard and release a new version.";
const olderThan60Days = (date: string) => Date.parse(date) < Date.now() - 60 * 86400_000;

/** The store's customers whose email, name or phone matches. */
async function findCustomers(api: Api, q: string, first = 5): Promise<Customer[]> {
  const term = q.trim();
  const query = term.includes("@") ? `email:${quoted(term)}` : term.replace(/["\\]/g, "");
  const r = await gql<{ customers: { nodes: Customer[] } }>(
    api,
    `query($q: String!, $n: Int!) { customers(first: $n, query: $q) { nodes {
      id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
      numberOfOrders amountSpent { amount currencyCode } createdAt tags
      lastOrder { name createdAt totalPriceSet { shopMoney { amount currencyCode } } } } } }`,
    { q: query, n: first },
  );
  return r.customers.nodes;
}

/**
 * A Shopify store, read live when someone asks: orders with their line items (for quoting
 * from a customer's past orders), customers, products with stock, and sales for a period.
 * Uses a Dev Dashboard app's client credentials (Shopify's way since 2026), or the Admin API
 * token of a custom app made in the Shopify admin before 2026.
 */
export const shopify: Provider = {
  id: "shopify",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "shop", label: "Store address", placeholder: "acme.myshopify.com" },
      { name: "clientId", label: "Client ID", optional: true },
      { name: "clientSecret", label: "Client secret", secret: true, optional: true },
      { name: "token", label: "Or: Admin API access token (apps made before 2026)", placeholder: "shpat_…", secret: true, optional: true },
    ],
    setup:
      "In Shopify admin open Settings → Apps → Develop apps and build an app in the Dev Dashboard. On its Versions page add the scopes read_orders, read_all_orders, read_customers, read_products and read_inventory, release it, install it on your store, then paste the Client ID and Client secret from the app's Settings page. If you already have a custom app made in the admin before 2026, paste its shpat_ token instead. ALRO only reads.",
    docsUrl: "https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens",
    api: (c) => {
      const shop = shopOf(c);
      const baseUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/`;
      const token = c.token?.trim();
      if (token) {
        if (!/^shpat_[A-Za-z0-9]+$/.test(token)) throw new Error("An Admin API access token starts with shpat_. For an app made in the Dev Dashboard, paste its Client ID and Client secret instead.");
        return httpApi({ baseUrl, headers: () => ({ "x-shopify-access-token": token }) });
      }
      const clientId = c.clientId?.trim();
      const clientSecret = c.clientSecret?.trim();
      if (!clientId || !clientSecret)
        throw new Error("Paste the app's Client ID and Client secret from the Shopify Dev Dashboard, or the shpat_ token of a custom app made in your Shopify admin before 2026.");
      // Shopify wants the minted token in its own header, not as a Bearer token.
      const minted = mintedBearer(() => mintShopifyToken(shop, clientId, clientSecret));
      return httpApi({ baseUrl, headers: async () => ({ "x-shopify-access-token": (await minted()).authorization.replace(/^Bearer /, "") }) });
    },
  },
  async identify(api, credentials) {
    const shop = shopOf(credentials);
    const r = await gql<{ shop: { name: string; myshopifyDomain: string }; currentAppInstallation?: { accessScopes: { handle: string }[] } }>(
      api,
      `{ shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`,
    ).catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error(`Shopify didn't accept that access for ${shop}. Check the app is installed on this store and the credentials were copied in full.`);
      if (e instanceof ProviderError && e.status === 404) throw new Error(`There's no Shopify store at ${shop}.`);
      throw e;
    });
    const granted = new Set((r.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
    const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s) && !granted.has(s.replace(/^read_/, "write_")));
    if (missing.length) throw new Error(`The app can't read everything ALRO needs yet. Add ${missing.join(", ")} on the app's Versions page in the Dev Dashboard, release the version, and approve it in your Shopify admin.`);
    return { accountId: `shopify:${r.shop.myshopifyDomain}`, label: r.shop.name };
  },
  tools(api) {
    return {
      shopify_orders: tool({
        description:
          "Orders in the company's Shopify store, newest first, with line items (product, SKU, quantity, unit price), totals and payment and fulfilment status. Use for a customer's past orders (to draft a quote or reorder), or orders since a date. Say the answer came from Shopify.",
        inputSchema: z.object({
          customer: z.string().nullish().describe("The customer's email or name."),
          since: z.string().nullish().describe("YYYY-MM-DD: only orders placed on or after this day."),
          limit: z.number().int().min(1).max(10).nullish(),
        }),
        execute: async ({ customer, since, limit }) => {
          const parts: string[] = [];
          if (since) parts.push(`created_at:>=${dateOf(since)}`);
          if (customer?.includes("@")) parts.push(`email:${quoted(customer.trim())}`);
          else if (customer) {
            const found = await findCustomers(api, customer, 5);
            if (!found.length) return { orders: [], note: `No Shopify customer matches "${customer}".` };
            parts.push(`(${found.map((c) => `customer_id:${c.id.split("/").pop()}`).join(" OR ")})`);
          }
          const r = await gql<{ orders: { nodes: Order[] } }>(api, `query($q: String, $n: Int!) { orders(first: $n, sortKey: CREATED_AT, reverse: true, query: $q) { nodes { ${ORDER_FIELDS} } } }`, {
            q: parts.join(" AND ") || null,
            n: limit ?? 5,
          });
          const note = since && olderThan60Days(since) && !(await readsAllOrders(api)) ? OLD_ORDERS_NOTE : undefined;
          return { orders: r.orders.nodes.map(orderRow), note };
        },
      }),

      shopify_customer: tool({
        description:
          "Look up a customer in the Shopify store by email, name or phone: number of orders, total spent, when they became a customer, and their last order. Use before quoting or following up with a buyer. Say the answer came from Shopify.",
        inputSchema: z.object({ query: z.string().min(2).describe("An email address, name or phone number.") }),
        execute: async ({ query }) => {
          const found = await findCustomers(api, query, 5);
          if (!found.length) return { customers: [], note: `No Shopify customer matches "${query}".` };
          return {
            customers: found.map((c) => ({
              name: c.displayName || undefined,
              email: c.defaultEmailAddress?.emailAddress?.toLowerCase() || undefined,
              phone: c.defaultPhoneNumber?.phoneNumber || undefined,
              orders: c.numberOfOrders == null ? undefined : Number(c.numberOfOrders),
              totalSpent: c.amountSpent ? Number(c.amountSpent.amount) : undefined,
              currency: c.amountSpent?.currencyCode,
              customerSince: c.createdAt?.slice(0, 10),
              tags: c.tags?.length ? c.tags : undefined,
              lastOrder: c.lastOrder ? { order: c.lastOrder.name, date: c.lastOrder.createdAt.slice(0, 10), total: amt(c.lastOrder.totalPriceSet) } : undefined,
            })),
          };
        },
      }),

      shopify_products: tool({
        description:
          "Search products in the Shopify store with their variants, SKU, price and stock on hand. Use for current prices when quoting, or 'do we have X in stock'. Say the answer came from Shopify.",
        inputSchema: z.object({
          query: z.string().nullish().describe("Words in the title, vendor or type, or sku:ABC-123. Leave empty for recently updated products."),
          limit: z.number().int().min(1).max(10).nullish(),
        }),
        execute: async ({ query, limit }) => {
          const r = await gql<{
            products: {
              nodes: { title: string; handle: string; status: string; vendor?: string; productType?: string; totalInventory?: number | null; variants: { nodes: { title: string; sku?: string | null; price: string; inventoryQuantity?: number | null }[] } }[];
            };
            shop: { currencyCode: string };
          }>(
            api,
            `query($q: String, $n: Int!) { shop { currencyCode } products(first: $n, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes {
              title handle status vendor productType totalInventory
              variants(first: 20) { nodes { title sku price inventoryQuantity } } } } }`,
            { q: query?.trim() || null, n: limit ?? 5 },
          );
          return {
            currency: r.shop.currencyCode,
            products: r.products.nodes.map((p) => ({
              title: p.title,
              status: p.status.toLowerCase(),
              vendor: p.vendor || undefined,
              type: p.productType || undefined,
              inStock: p.totalInventory ?? undefined,
              variants: p.variants.nodes.map((v) => ({ title: v.title === "Default Title" ? undefined : v.title, sku: v.sku || undefined, price: Number(v.price), inStock: v.inventoryQuantity ?? undefined })),
            })),
          };
        },
      }),

      shopify_sales: tool({
        description:
          "Sales in the Shopify store for a date range, added up from its orders (cancelled and test orders left out): number of orders, gross sales (before discounts), discounts, net sales, total collected including tax and shipping, and average order value. Use for 'how did the store do last month'. Say the figures came from Shopify and are computed from orders, so they can differ slightly from Shopify's own reports (returns aren't subtracted).",
        inputSchema: z.object({
          from: z.string().describe("YYYY-MM-DD, first day included."),
          to: z.string().nullish().describe("YYYY-MM-DD, last day included. Defaults to today."),
        }),
        execute: async ({ from, to }) => {
          const start = dateOf(from);
          const end = to ? dateOf(to) : undefined;
          const q = `created_at:>=${start}${end ? ` AND created_at:<=${end}` : ""}`;
          let after: string | null = null;
          let orders = 0;
          let gross = 0;
          let discounts = 0;
          let net = 0;
          let total = 0;
          let currency: string | undefined;
          let capped = false;
          for (let page = 0; ; page++) {
            if (page >= MAX_SALES_PAGES) {
              capped = true;
              break;
            }
            const r: { orders: { nodes: (Order & { test: boolean })[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
              api,
              `query($q: String!, $after: String) { orders(first: ${SALES_PAGE}, after: $after, query: $q, sortKey: CREATED_AT) {
                nodes { cancelledAt test subtotalPriceSet { shopMoney { amount currencyCode } } totalDiscountsSet { shopMoney { amount currencyCode } } totalPriceSet { shopMoney { amount currencyCode } } }
                pageInfo { hasNextPage endCursor } } }`,
              { q, after },
            );
            for (const o of r.orders.nodes) {
              if (o.cancelledAt || o.test) continue;
              orders += 1;
              net += amt(o.subtotalPriceSet);
              discounts += amt(o.totalDiscountsSet);
              gross += amt(o.subtotalPriceSet) + amt(o.totalDiscountsSet);
              total += amt(o.totalPriceSet);
              currency ??= o.totalPriceSet?.shopMoney.currencyCode;
            }
            if (!r.orders.pageInfo.hasNextPage) break;
            after = r.orders.pageInfo.endCursor;
          }
          const notes: string[] = [];
          if (capped) notes.push(`Only the first ${orders} orders in the range were added up (Shopify limits how fast ALRO can read); the real totals are higher.`);
          if (olderThan60Days(start) && !(await readsAllOrders(api))) notes.push(OLD_ORDERS_NOTE);
          return {
            from: start,
            to: end ?? new Date().toISOString().slice(0, 10),
            orders,
            grossSales: r2(gross),
            discounts: r2(discounts),
            netSales: r2(net),
            totalCollected: r2(total),
            averageOrderValue: orders ? r2(total / orders) : 0,
            currency,
            note: notes.join(" ") || undefined,
          };
        },
      }),
    };
  },
};
