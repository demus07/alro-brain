import { tool } from "ai";
import { z } from "zod";
import { bearer, httpApi, ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

/** Pinned so response shapes don't change under us when Stripe ships a new version. */
export const STRIPE_VERSION = "2026-10-28.endive";
/** Pages of 100 read for one question; past this the answer says it's partial. */
const MAX_PAGES = 5;
/** Revenue reads further back, so it may read more. */
const MAX_REVENUE_PAGES = 30;

/** Currencies Stripe counts in whole units, and those counted in thousandths. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Stripe amounts are in the currency's smallest unit (cents); this gives major units (dollars). */
export function fromMinor(amount: number | null | undefined, currency: string): number {
  const c = currency.toLowerCase();
  const divisor = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round(((amount ?? 0) / divisor) * 1000) / 1000;
}

const day = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : undefined);
const when = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : undefined);
const CUR = (c: string) => c.toUpperCase();

/** "2026-10-01" (or any date Date.parse reads) as Unix seconds; `fallbackDays` back from now when empty. */
function sinceUnix(date: string | null | undefined, fallbackDays: number, now = Date.now()): number {
  if (!date) return Math.floor(now / 1000) - fallbackDays * 86400;
  const t = Date.parse(date);
  if (Number.isNaN(t)) throw new Error(`"${date}" isn't a date. Use YYYY-MM-DD.`);
  return Math.floor(t / 1000);
}

interface List<T> {
  data: T[];
  has_more: boolean;
}

/** Reads a Stripe list page by page (100 at a time) up to `maxPages`; `capped` when more were left. */
async function listAll<T extends { id: string }>(
  api: Api,
  path: string,
  query: Record<string, string | number | undefined>,
  maxPages = MAX_PAGES,
  enough?: (items: T[]) => boolean,
): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await api<List<T>>("GET", path, { query: { ...query, limit: 100, starting_after: after } });
    items.push(...r.data);
    if (!r.has_more || !r.data.length) return { items, capped: false };
    if (enough?.(items)) return { items, capped: true };
    after = r.data[r.data.length - 1].id;
  }
  return { items, capped: true };
}

interface Account {
  id: string;
  email?: string | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } };
}
interface Customer {
  id: string;
  name?: string | null;
  email?: string | null;
  created?: number;
  deleted?: boolean;
}
interface Invoice {
  id: string;
  number?: string | null;
  status?: string | null;
  customer?: string | Customer | null;
  customer_name?: string | null;
  customer_email?: string | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  total?: number;
  currency: string;
  created: number;
  due_date?: number | null;
  hosted_invoice_url?: string | null;
  status_transitions?: { paid_at?: number | null };
}
interface Charge {
  id: string;
  amount: number;
  amount_captured?: number;
  amount_refunded?: number;
  captured?: boolean;
  currency: string;
  status: string;
  created: number;
  description?: string | null;
  customer?: string | Customer | null;
  billing_details?: { name?: string | null; email?: string | null };
  receipt_email?: string | null;
  payment_intent?: string | null;
  refunded?: boolean;
}
interface Refund {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  created: number;
}
interface InvoicePayment {
  id: string;
  invoice: string | Invoice;
  amount_paid?: number | null;
  status?: string;
}

const isSucceeded = (c: Charge) => c.status === "succeeded" && c.captured !== false;
const received = (c: Charge) => (c.amount_captured ?? c.amount) - (c.amount_refunded ?? 0);
const customerOf = (c: Charge) => {
  const cust = typeof c.customer === "object" && c.customer && !c.customer.deleted ? c.customer : undefined;
  return {
    name: cust?.name || c.billing_details?.name || undefined,
    email: (cust?.email || c.billing_details?.email || c.receipt_email || undefined)?.toLowerCase(),
  };
};

/** Customers with this email, exactly as Stripe stores it or lower-cased. */
async function customersByEmail(api: Api, email: string): Promise<Customer[]> {
  const found = new Map<string, Customer>();
  for (const e of new Set([email.trim(), email.trim().toLowerCase()])) {
    const r = await api<List<Customer>>("GET", "v1/customers", { query: { email: e, limit: 10 } });
    for (const c of r.data) found.set(c.id, c);
  }
  return [...found.values()];
}

/**
 * Customers matching an email or name. Uses Stripe's Search API (substring match), and falls
 * back to listing when Search isn't available (it isn't for businesses in India).
 */
async function findCustomers(api: Api, q: string): Promise<Customer[]> {
  const term = q.trim().replace(/["\\]/g, "");
  const isEmail = term.includes("@");
  try {
    const r = await api<List<Customer>>("GET", "v1/customers/search", { query: { query: isEmail ? `email:"${term}"` : `name~"${term}"`, limit: 10 } });
    // Search can lag a minute behind; an exact email lookup can't.
    return !r.data.length && isEmail ? customersByEmail(api, term) : r.data;
  } catch (e) {
    if (!(e instanceof ProviderError) || ![400, 403, 404].includes(e.status)) throw e;
    if (isEmail) return customersByEmail(api, term);
    const { items } = await listAll<Customer>(api, "v1/customers", {}, 3);
    const want = term.toLowerCase();
    return items.filter((c) => c.name?.toLowerCase().includes(want) || c.email?.toLowerCase().includes(want)).slice(0, 10);
  }
}

const invoiceRow = (i: Invoice, nowSec: number) => {
  const overdue = i.status === "open" && i.due_date && i.due_date < nowSec ? Math.floor((nowSec - i.due_date) / 86400) : 0;
  return {
    number: i.number ?? i.id,
    status: i.status,
    customer: i.customer_name ?? undefined,
    email: i.customer_email?.toLowerCase() ?? undefined,
    amountDue: fromMinor(i.status === "open" ? i.amount_remaining : i.amount_due, i.currency),
    amountPaid: fromMinor(i.amount_paid, i.currency),
    currency: CUR(i.currency),
    created: day(i.created),
    dueDate: day(i.due_date),
    daysOverdue: overdue || undefined,
    paidAt: day(i.status_transitions?.paid_at),
    url: i.hosted_invoice_url ?? undefined,
  };
};

/** The invoice each payment intent or charge paid, if any (Stripe links them through Invoice Payments). */
async function invoicesPaidBy(api: Api, charges: Charge[]): Promise<Map<string, Invoice>> {
  const out = new Map<string, Invoice>();
  const queue = [...charges];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const payment = c.payment_intent ? { "payment[type]": "payment_intent", "payment[payment_intent]": c.payment_intent } : { "payment[type]": "charge", "payment[charge]": c.id };
      const r = await api<List<InvoicePayment>>("GET", "v1/invoice_payments", { query: { ...payment, status: "paid", limit: 1, "expand[]": "data.invoice" } }).catch((e) => {
        if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return undefined;
        throw e;
      });
      const inv = r?.data[0]?.invoice;
      if (inv && typeof inv === "object") out.set(c.id, inv);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

/** Sums by currency, in major units. */
function byCurrency(rows: { amount: number; currency: string }[]) {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.amount);
  return Object.fromEntries([...sums].map(([c, v]) => [CUR(c), fromMinor(v, c)]));
}

/**
 * Stripe, read live when someone asks: balance, invoices (what's overdue and who owes it),
 * payments and which invoice each paid, customers and monthly revenue. Read-only: ALRO never
 * moves money, so it asks for a restricted key with read access only.
 */
export const stripe: Provider = {
  id: "stripe",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "key", label: "Restricted API key", placeholder: "rk_live_…", secret: true }],
    setup:
      "In Stripe, open Developers → API keys → Create restricted key. Set Read on Balance, Charges, Customers, Invoices and PaymentIntents (plus Read on Accounts under Connect, so ALRO can show your business name), leave everything else at None, then paste the rk_live_… key. ALRO only reads; it can never move money.",
    docsUrl: "https://docs.stripe.com/keys/restricted-api-keys",
    api: (c) => {
      const auth = bearer(keyOf(c));
      return httpApi({ baseUrl: "https://api.stripe.com/", headers: () => ({ ...auth(), "stripe-version": STRIPE_VERSION }) });
    },
  },
  async identify(api, credentials) {
    keyOf(credentials);
    const account = await api<Account>("GET", "v1/account").catch(async (e): Promise<Account> => {
      if (e instanceof ProviderError && e.status === 401) throw new Error("Stripe didn't accept that key. Copy the whole rk_live_… key again, or create a new restricted key.");
      if (e instanceof ProviderError && (e.status === 403 || e.status === 400)) {
        // The key works but may not read the account. Stripe's refusal names the account, so use it once the key proves it can read the balance.
        const id = /acct_[A-Za-z0-9]+/.exec(e.message)?.[0];
        if (id) {
          await api("GET", "v1/balance").catch(() => {
            throw new Error("That Stripe key can't read your balance. Edit the key and set Balance, Charges, Customers, Invoices and PaymentIntents to Read.");
          });
          return { id };
        }
        throw new Error("That Stripe key can't read your account. Edit the key and set Accounts (under Connect) to Read, as well as Balance, Charges, Customers, Invoices and PaymentIntents.");
      }
      throw e;
    });
    const name = account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || account.id;
    const mode = keyOf(credentials).startsWith("rk_test_") ? " (test mode)" : "";
    return { accountId: `stripe:${account.id}`, label: `${name}${mode}` };
  },
  tools(api) {
    return {
      stripe_balance: tool({
        description:
          "The company's Stripe balance right now, per currency: money available to pay out and money still pending. Use for 'how much cash is in Stripe'. Say the figures came from Stripe; this is not the bank balance.",
        inputSchema: z.object({}),
        execute: async () => {
          const b = await api<{ available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[]; livemode?: boolean }>("GET", "v1/balance");
          return { available: byCurrency(b.available), pending: byCurrency(b.pending), testMode: b.livemode === false || undefined };
        },
      }),

      stripe_invoices: tool({
        description:
          "Invoices in Stripe, largest amount owed first, with customer, amount due, due date, days overdue and the payment link. Use for 'who owes us', 'biggest overdue invoices' (overdueOnly), or a customer's invoices (by email). Say the answer came from Stripe.",
        inputSchema: z.object({
          status: z.enum(["open", "paid", "uncollectible"]).nullish().describe("Defaults to open (unpaid)."),
          overdueOnly: z.boolean().nullish().describe("Only open invoices past their due date."),
          customerEmail: z.string().nullish(),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ status, overdueOnly, customerEmail, limit }) => {
          const nowSec = Math.floor(Date.now() / 1000);
          const want = overdueOnly ? "open" : (status ?? "open");
          let invoices: Invoice[] = [];
          let capped = false;
          if (customerEmail) {
            const customers = await customersByEmail(api, customerEmail);
            if (!customers.length) return { invoices: [], note: `No Stripe customer has the email ${customerEmail}.` };
            for (const c of customers.slice(0, 3)) {
              const r = await listAll<Invoice>(api, "v1/invoices", { customer: c.id, status: want }, 2);
              invoices.push(...r.items);
              capped ||= r.capped;
            }
          } else {
            ({ items: invoices, capped } = await listAll<Invoice>(api, "v1/invoices", { status: want }));
          }
          if (overdueOnly) invoices = invoices.filter((i) => i.due_date && i.due_date < nowSec && i.amount_remaining > 0);
          const owed = (i: Invoice) => (want === "open" ? i.amount_remaining : i.amount_due);
          invoices.sort((a, b) => fromMinor(owed(b), b.currency) - fromMinor(owed(a), a.currency));
          const rows = invoices.slice(0, limit ?? 10).map((i) => invoiceRow(i, nowSec));
          return {
            count: invoices.length,
            totalDue: want === "paid" ? undefined : byCurrency(invoices.map((i) => ({ amount: owed(i), currency: i.currency }))),
            invoices: rows,
            note: capped ? `Read the most recent ${invoices.length} matching invoices only; older ones weren't checked.` : undefined,
          };
        },
      }),

      stripe_payments: tool({
        description:
          "Successful payments received in Stripe since a date, newest first: who paid, how much, and the invoice each payment settled (if any). Use for 'who paid us this week', 'did Acme pay', or matching payments to invoices. Say the answer came from Stripe.",
        inputSchema: z.object({
          since: z.string().nullish().describe("YYYY-MM-DD. Defaults to 30 days ago."),
          customerEmail: z.string().nullish(),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ since, customerEmail, limit }) => {
          const max = limit ?? 15;
          const from = sinceUnix(since, 30);
          const query = { "created[gte]": from, "expand[]": "data.customer" };
          let charges: Charge[] = [];
          let capped = false;
          if (customerEmail) {
            const customers = await customersByEmail(api, customerEmail);
            if (!customers.length) return { payments: [], note: `No Stripe customer has the email ${customerEmail}.` };
            for (const c of customers.slice(0, 3)) {
              const r = await listAll<Charge>(api, "v1/charges", { ...query, customer: c.id }, 2);
              charges.push(...r.items);
              capped ||= r.capped;
            }
            charges.sort((a, b) => b.created - a.created);
          } else {
            ({ items: charges, capped } = await listAll<Charge>(api, "v1/charges", query, MAX_PAGES, (all) => all.filter(isSucceeded).length >= max));
          }
          const paid = charges.filter(isSucceeded);
          const shown = paid.slice(0, max);
          const invoices = await invoicesPaidBy(api, shown);
          return {
            count: paid.length,
            total: byCurrency(paid.map((c) => ({ amount: received(c), currency: c.currency }))),
            payments: shown.map((c) => {
              const inv = invoices.get(c.id);
              return {
                date: when(c.created),
                ...customerOf(c),
                amount: fromMinor(c.amount_captured ?? c.amount, c.currency),
                refunded: c.amount_refunded ? fromMinor(c.amount_refunded, c.currency) : undefined,
                currency: CUR(c.currency),
                description: c.description ?? undefined,
                invoice: inv ? { number: inv.number ?? inv.id, url: inv.hosted_invoice_url ?? undefined } : undefined,
                id: c.payment_intent ?? c.id,
              };
            }),
            note: capped ? `Read only the most recent ${charges.length} payments since then; the count and total leave out older ones.` : undefined,
          };
        },
      }),

      stripe_customer: tool({
        description:
          "Look up a customer in Stripe by email or name: lifetime paid, what they owe now, and their recent invoices. Use before chasing a customer for payment or to answer 'how much has Acme paid us'. Say the answer came from Stripe.",
        inputSchema: z.object({ query: z.string().min(2).describe("An email address or part of the customer's name.") }),
        execute: async ({ query }) => {
          const nowSec = Math.floor(Date.now() / 1000);
          const customers = await findCustomers(api, query);
          if (!customers.length) return { customers: [], note: `No Stripe customer matches "${query}".` };
          const details = [];
          for (const c of customers.slice(0, 3)) {
            const [charges, invoices] = await Promise.all([listAll<Charge>(api, "v1/charges", { customer: c.id }), listAll<Invoice>(api, "v1/invoices", { customer: c.id }, 2)]);
            const open = invoices.items.filter((i) => i.status === "open");
            details.push({
              name: c.name ?? undefined,
              email: c.email?.toLowerCase() ?? undefined,
              customerSince: day(c.created),
              lifetimePaid: byCurrency(charges.items.filter(isSucceeded).map((x) => ({ amount: received(x), currency: x.currency }))),
              openBalance: byCurrency(open.map((i) => ({ amount: i.amount_remaining, currency: i.currency }))),
              overdueInvoices: open.filter((i) => i.due_date && i.due_date < nowSec).length,
              recentInvoices: invoices.items
                .filter((i) => i.status !== "draft")
                .slice(0, 5)
                .map((i) => invoiceRow(i, nowSec)),
              note: charges.capped ? "Lifetime paid counts only the most recent 500 payments." : undefined,
            });
          }
          return { matches: customers.length, customers: details };
        },
      }),

      stripe_revenue: tool({
        description:
          "Revenue collected through Stripe per calendar month (UTC) for the last N months, per currency: successful payments, minus refunds made that month. Use for 'how much did we collect last quarter' or month-on-month trends. Say the figures came from Stripe and are payments received, not invoiced or recognised revenue.",
        inputSchema: z.object({ months: z.number().int().min(1).max(24).nullish().describe("Defaults to 6, including the current month.") }),
        execute: async ({ months }) => {
          const n = months ?? 6;
          const now = new Date();
          const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1) / 1000;
          const [charges, refunds] = await Promise.all([
            listAll<Charge>(api, "v1/charges", { "created[gte]": start }, MAX_REVENUE_PAGES),
            listAll<Refund>(api, "v1/refunds", { "created[gte]": start }, MAX_PAGES * 2),
          ]);
          const table = new Map<string, { gross: number; refunds: number; payments: number }>();
          const row = (unix: number, currency: string) => {
            const key = `${new Date(unix * 1000).toISOString().slice(0, 7)}|${currency}`;
            if (!table.has(key)) table.set(key, { gross: 0, refunds: 0, payments: 0 });
            return table.get(key)!;
          };
          for (const c of charges.items.filter(isSucceeded)) {
            const r = row(c.created, c.currency);
            r.gross += c.amount_captured ?? c.amount;
            r.payments += 1;
          }
          for (const r of refunds.items.filter((x) => x.status === "succeeded" || x.status === "pending")) row(r.created, r.currency).refunds += r.amount;
          const result = [...table]
            .map(([key, v]) => {
              const [month, currency] = key.split("|");
              return { month, currency: CUR(currency), payments: v.payments, gross: fromMinor(v.gross, currency), refunds: fromMinor(v.refunds, currency), net: fromMinor(v.gross - v.refunds, currency) };
            })
            .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
          const capped = charges.capped || refunds.capped;
          return {
            months: result,
            note: capped ? `Too many payments to read them all: only the most recent ${charges.items.length} payments are counted, so the earliest months are understated.` : undefined,
          };
        },
      }),
    };
  },
};

/** The pasted key, checked to be a restricted key: ALRO refuses full secret keys. */
function keyOf(credentials: Record<string, string>): string {
  const key = (credentials.key ?? "").trim();
  if (/^sk_(live|test)_/.test(key)) throw new Error("That's a full secret key, which can move money. Create a restricted key with read-only access instead (it starts with rk_live_).");
  if (!/^rk_(live|test)_[A-Za-z0-9]+$/.test(key)) throw new Error("Paste a Stripe restricted key: it starts with rk_live_ (or rk_test_ for test mode).");
  return key;
}
