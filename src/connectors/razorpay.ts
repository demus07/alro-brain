import { tool } from "ai";
import { z } from "zod";
import { basic, httpApi, ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

/** Pages of 100 read for one question; past this the answer says it's partial. */
const MAX_PAGES = 5;

/** Currencies counted in whole units; everything else Razorpay counts in hundredths (paise, cents). */
const ZERO_DECIMAL = new Set(["jpy", "krw", "vnd", "clp", "pyg", "ugx", "xaf", "xof"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Razorpay amounts are in the smallest unit (paise); this gives rupees (or the major unit). */
export function fromMinor(amount: number | null | undefined, currency = "INR"): number {
  const c = currency.toLowerCase();
  const divisor = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round(((amount ?? 0) / divisor) * 1000) / 1000;
}

const day = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : undefined);
const when = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : undefined);

/** "2026-10-01" as Unix seconds; `fallbackDays` back from now when empty. */
function sinceUnix(date: string | null | undefined, fallbackDays: number, now = Date.now()): number {
  if (!date) return Math.floor(now / 1000) - fallbackDays * 86400;
  const t = Date.parse(date);
  if (Number.isNaN(t)) throw new Error(`"${date}" isn't a date. Use YYYY-MM-DD.`);
  return Math.floor(t / 1000);
}

interface Collection<T> {
  count: number;
  items: T[];
}

/** Reads a Razorpay collection 100 at a time (newest first) up to `maxPages`; `capped` when more were left. */
async function listAll<T>(api: Api, path: string, query: Record<string, string | number | undefined>, maxPages = MAX_PAGES): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await api<Collection<T>>("GET", path, { query: { ...query, count: 100, skip: page * 100 } });
    items.push(...(r.items ?? []));
    if ((r.items ?? []).length < 100) return { items, capped: false };
  }
  return { items, capped: true };
}

/** Sums by currency, in major units. */
function byCurrency(rows: { amount: number; currency?: string }[]) {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.currency ?? "INR", (sums.get(r.currency ?? "INR") ?? 0) + r.amount);
  return Object.fromEntries([...sums].map(([c, v]) => [c, fromMinor(v, c)]));
}

interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  captured?: boolean;
  amount_refunded?: number;
  order_id?: string | null;
  invoice_id?: string | null;
  method?: string;
  description?: string | null;
  email?: string | null;
  contact?: string | null;
  notes?: Record<string, string> | unknown[];
  created_at: number;
}
interface Invoice {
  id: string;
  invoice_number?: string | null;
  receipt?: string | null;
  status: string;
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  customer_details?: { name?: string | null; email?: string | null; contact?: string | null; customer_name?: string | null; customer_email?: string | null } | null;
  date?: number | null;
  issued_at?: number | null;
  expire_by?: number | null;
  paid_at?: number | null;
  short_url?: string | null;
  description?: string | null;
}
interface Settlement {
  id: string;
  amount: number;
  status: string;
  fees?: number;
  tax?: number;
  utr?: string | null;
  created_at: number;
}
interface PaymentLink {
  id: string;
  amount: number;
  amount_paid?: number;
  currency?: string;
  status: string;
  description?: string | null;
  reference_id?: string | null;
  short_url?: string | null;
  customer?: { name?: string | null; email?: string | null; contact?: string | null } | unknown[] | null;
  expire_by?: number | null;
  created_at: number;
}

/** Razorpay sends notes as an object, or as an empty array when there are none. */
const notesOf = (n: Payment["notes"]) => (n && !Array.isArray(n) && Object.keys(n).length ? n : undefined);
const customerOfLink = (c: PaymentLink["customer"]) => (c && !Array.isArray(c) ? { name: c.name || undefined, email: c.email?.toLowerCase() || undefined, phone: c.contact || undefined } : undefined);

/** Key IDs look like rzp_live_ABCdef1234567x; the part after the mode identifies the key. */
function keyIdOf(credentials: Record<string, string>): { keyId: string; mode: "live" | "test"; suffix: string } {
  const keyId = (credentials.keyId ?? "").trim();
  const m = /^rzp_(live|test)_([A-Za-z0-9]+)$/.exec(keyId);
  if (!m) throw new Error("Paste your Razorpay Key ID: it starts with rzp_live_ (or rzp_test_ for test mode).");
  return { keyId, mode: m[1] as "live" | "test", suffix: m[2] };
}

/**
 * Razorpay, read live when someone asks: captured payments, unpaid and overdue invoices,
 * settlements (money that actually reached the bank) and unpaid payment links. Read-only:
 * ALRO never moves money.
 */
export const razorpay: Provider = {
  id: "razorpay",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "keyId", label: "Key ID", placeholder: "rzp_live_…" },
      { name: "keySecret", label: "Key secret", secret: true },
    ],
    setup:
      "In the Razorpay Dashboard, open Account & Settings → API Keys and generate a live key, then paste the Key ID and Key secret. Razorpay keys can't be made read-only, so ALRO only ever reads with them and never moves money.",
    docsUrl: "https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/",
    api: (c) => httpApi({ baseUrl: "https://api.razorpay.com/v1/", headers: basic(keyIdOf(c).keyId, (c.keySecret ?? "").trim()) }),
  },
  /**
   * Razorpay has no "who am I" call for key-based auth, so this reads one payment to prove the
   * keys and names the connection after the key itself. Regenerating keys gives a new key id,
   * and so reads as a new account.
   */
  async identify(api, credentials) {
    const { mode, suffix } = keyIdOf(credentials);
    await api("GET", "payments", { query: { count: 1 } }).catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 400)) throw new Error("Razorpay didn't accept that Key ID and secret. Check both were copied in full, from the same key.");
      throw e;
    });
    return { accountId: `razorpay:${mode}:${suffix}`, label: `Razorpay ${mode === "test" ? "test " : ""}key …${suffix.slice(-4)}` };
  },
  tools(api) {
    return {
      razorpay_payments: tool({
        description:
          "Captured (successful) payments in Razorpay since a date, newest first, in rupees: who paid (email/phone), how much, method, and the order, invoice and notes attached. Use for 'who paid us', 'did this customer pay', or matching a payment to an invoice. Say the answer came from Razorpay.",
        inputSchema: z.object({
          since: z.string().nullish().describe("YYYY-MM-DD. Defaults to 30 days ago."),
          customer: z.string().nullish().describe("Email or phone to match."),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ since, customer, limit }) => {
          const { items, capped } = await listAll<Payment>(api, "payments", { from: sinceUnix(since, 30) });
          const want = customer?.trim().toLowerCase();
          const paid = items.filter((p) => p.status === "captured" && (!want || p.email?.toLowerCase().includes(want) || p.contact?.replace(/\s/g, "").includes(want.replace(/\s/g, ""))));
          return {
            count: paid.length,
            total: byCurrency(paid.map((p) => ({ amount: p.amount - (p.amount_refunded ?? 0), currency: p.currency }))),
            payments: paid.slice(0, limit ?? 15).map((p) => ({
              id: p.id,
              date: when(p.created_at),
              amount: fromMinor(p.amount, p.currency),
              refunded: p.amount_refunded ? fromMinor(p.amount_refunded, p.currency) : undefined,
              currency: p.currency,
              method: p.method,
              email: p.email?.toLowerCase() || undefined,
              phone: p.contact || undefined,
              description: p.description || undefined,
              orderId: p.order_id || undefined,
              invoiceId: p.invoice_id || undefined,
              notes: notesOf(p.notes),
            })),
            note: capped ? `Read only the most recent ${items.length} payments since then; the count and total leave out older ones.` : undefined,
          };
        },
      }),

      razorpay_invoices: tool({
        description:
          "Razorpay invoices still unpaid (issued, partially paid or expired), largest amount due first, in rupees, with customer, due date and days overdue. Use for 'who owes us', 'overdue invoices' (overdueOnly) or one customer's invoices. Say the answer came from Razorpay.",
        inputSchema: z.object({
          status: z.enum(["issued", "partially_paid", "expired", "paid"]).nullish().describe("Defaults to every unpaid status."),
          overdueOnly: z.boolean().nullish().describe("Only issued or partially paid invoices past their expiry (due) date."),
          customer: z.string().nullish().describe("Name, email or phone to match."),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ status, overdueOnly, customer, limit }) => {
          const nowSec = Math.floor(Date.now() / 1000);
          const { items, capped } = await listAll<Invoice>(api, "invoices", { type: "invoice" });
          const want = customer?.trim().toLowerCase();
          const unpaid = ["issued", "partially_paid", "expired"];
          const isOverdue = (i: Invoice) => (i.status === "issued" || i.status === "partially_paid") && !!i.expire_by && i.expire_by < nowSec;
          const who = (i: Invoice) => ({
            name: i.customer_details?.name || i.customer_details?.customer_name || undefined,
            email: (i.customer_details?.email || i.customer_details?.customer_email || undefined)?.toLowerCase(),
            phone: i.customer_details?.contact || undefined,
          });
          const matching = items
            .filter((i) => (status ? i.status === status : unpaid.includes(i.status)))
            .filter((i) => !overdueOnly || isOverdue(i))
            .filter((i) => {
              if (!want) return true;
              const c = who(i);
              return [c.name?.toLowerCase(), c.email, c.phone].some((v) => v?.includes(want));
            })
            .sort((a, b) => (b.amount_due ?? 0) - (a.amount_due ?? 0));
          return {
            count: matching.length,
            totalDue: status === "paid" ? undefined : byCurrency(matching.map((i) => ({ amount: i.amount_due ?? 0, currency: i.currency }))),
            invoices: matching.slice(0, limit ?? 10).map((i) => ({
              number: i.invoice_number || i.receipt || i.id,
              status: i.status,
              ...who(i),
              amount: fromMinor(i.amount, i.currency),
              amountPaid: fromMinor(i.amount_paid, i.currency),
              amountDue: fromMinor(i.amount_due, i.currency),
              currency: i.currency ?? "INR",
              issued: day(i.issued_at ?? i.date),
              dueDate: day(i.expire_by),
              daysOverdue: isOverdue(i) ? Math.floor((nowSec - i.expire_by!) / 86400) : undefined,
              url: i.short_url || undefined,
            })),
            note: capped ? `Read only the most recent ${items.length} invoices; older ones weren't checked.` : undefined,
          };
        },
      }),

      razorpay_settlements: tool({
        description:
          "Recent Razorpay settlements: money actually paid out to the company's bank account, with fees, tax and the bank reference (UTR). Use for 'how much cash did Razorpay send us' or reconciling bank credits. Say the answer came from Razorpay.",
        inputSchema: z.object({
          since: z.string().nullish().describe("YYYY-MM-DD. Defaults to 30 days ago."),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ since, limit }) => {
          const { items, capped } = await listAll<Settlement>(api, "settlements", { from: sinceUnix(since, 30) }, 2);
          const processed = items.filter((s) => s.status === "processed");
          return {
            settledToBank: fromMinor(processed.reduce((n, s) => n + s.amount, 0)),
            currency: "INR",
            count: items.length,
            settlements: items.slice(0, limit ?? 15).map((s) => ({
              id: s.id,
              date: when(s.created_at),
              amount: fromMinor(s.amount),
              status: s.status,
              fees: s.fees ? fromMinor(s.fees) : undefined,
              tax: s.tax ? fromMinor(s.tax) : undefined,
              utr: s.utr || undefined,
            })),
            note: capped ? `Read only the most recent ${items.length} settlements.` : undefined,
          };
        },
      }),

      razorpay_payment_links: tool({
        description:
          "Razorpay payment links not yet fully paid (created or partially paid), newest first, in rupees: amount, what's left, customer, expiry and the link. Use for 'which payment links are still pending'. Say the answer came from Razorpay.",
        inputSchema: z.object({ limit: z.number().int().min(1).max(25).nullish() }),
        execute: async ({ limit }) => {
          const r = await api<{ payment_links?: PaymentLink[] }>("GET", "payment_links");
          const open = (r.payment_links ?? []).filter((l) => l.status === "created" || l.status === "partially_paid").sort((a, b) => b.created_at - a.created_at);
          return {
            count: open.length,
            outstanding: byCurrency(open.map((l) => ({ amount: l.amount - (l.amount_paid ?? 0), currency: l.currency }))),
            links: open.slice(0, limit ?? 15).map((l) => ({
              id: l.id,
              created: day(l.created_at),
              amount: fromMinor(l.amount, l.currency),
              amountPaid: l.amount_paid ? fromMinor(l.amount_paid, l.currency) : undefined,
              currency: l.currency ?? "INR",
              status: l.status,
              customer: customerOfLink(l.customer),
              description: l.description || undefined,
              reference: l.reference_id || undefined,
              expires: day(l.expire_by),
              url: l.short_url || undefined,
            })),
          };
        },
      }),
    };
  },
};
