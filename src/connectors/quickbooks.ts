import { tool } from "ai";
import { z } from "zod";
import type { Api } from "./api";
import type { Provider } from "./provider";

/*
 * QuickBooks Online accounting, read live for the finance agent: cash, receivables, bills, payments
 * and reports. Paths are v3/company/{realmId}/…; the realmId comes back with the sign-in. Queries are
 * built here from fixed templates with escaped values; the model never writes one.
 */

/** Intuit retired minor versions below 75 in August 2025; 75 is the current one. */
export const MINOR_VERSION = 75;
const DAY_MS = 86_400_000;
const PAGE = 1000;
const MAX_PAGES = 3;
const MAX_LIST = 25;
const MAX_ROWS = 40;
const HOSTS = ["quickbooks.api.intuit.com", "sandbox-quickbooks.api.intuit.com"];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** A string literal for the QuickBooks query language: quotes and backslashes escaped, control characters dropped. */
export const qbString = (v: string) => `'${v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\']/g, "\\$&")}'`;
/** A LIKE pattern matching the text anywhere; "%" is the only wildcard, so any typed one is removed. */
export const qbContains = (v: string) => qbString(`%${v.replace(/%/g, "").trim()}%`);
/** Record ids are numbers; anything else is refused rather than put in a query. */
const qbIds = (ids: string[]) => ids.filter((id) => /^\d+$/.test(id)).map((id) => `'${id}'`).join(",");

interface Ref {
  value?: string;
  name?: string;
}
interface QbInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: Ref;
  VendorRef?: Ref;
  BillEmail?: { Address?: string };
  CurrencyRef?: Ref;
}
interface QbCustomer {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Balance?: number;
  CurrencyRef?: Ref;
  Active?: boolean;
}
interface QbPayment {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  UnappliedAmt?: number;
  PaymentRefNum?: string;
  DocNumber?: string;
  CustomerRef?: Ref;
  VendorRef?: Ref;
  CurrencyRef?: Ref;
  Line?: { Amount?: number; LinkedTxn?: { TxnId?: string; TxnType?: string }[] }[];
}
interface QbCol {
  value?: string;
}
interface QbRow {
  type?: string;
  group?: string;
  ColData?: QbCol[];
  Header?: { ColData?: QbCol[] };
  Rows?: { Row?: QbRow[] };
  Summary?: { ColData?: QbCol[] };
}
interface QbReport {
  Header?: { ReportName?: string; StartPeriod?: string; EndPeriod?: string; Currency?: string; ReportBasis?: string };
  Columns?: { Column?: { ColTitle?: string }[] };
  Rows?: { Row?: QbRow[] };
}

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const cellValue = (v = "") => (/^-?[\d,]*\.?\d+$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : v);

/** A QuickBooks report as a few labelled rows: top-level totals and lines, or every line with `detail`. */
export function flattenReport(report: QbReport, detail = false) {
  const lines: { section?: string; label: string; values: (number | string)[] }[] = [];
  const add = (section: string | undefined, cols: QbCol[] = []) => {
    const [label, ...values] = cols.map((c) => c.value ?? "");
    if (label) lines.push({ section, label, values: values.map(cellValue) });
  };
  const walk = (rows: QbRow[], section: string | undefined, depth: number) => {
    for (const row of rows) {
      if (row.ColData) {
        if (detail || depth === 0) add(section, row.ColData);
        continue;
      }
      const title = row.Header?.ColData?.[0]?.value || row.group;
      walk(row.Rows?.Row ?? [], title, depth + 1);
      if (row.Summary && (detail || depth === 0)) add(title, row.Summary.ColData);
    }
  };
  walk(report.Rows?.Row ?? [], undefined, 0);
  return {
    report: report.Header?.ReportName,
    from: report.Header?.StartPeriod,
    to: report.Header?.EndPeriod,
    currency: report.Header?.Currency,
    basis: report.Header?.ReportBasis,
    columns: (report.Columns?.Column ?? []).slice(1).map((c) => c.ColTitle ?? ""),
    rows: lines.slice(0, MAX_ROWS),
    truncated: lines.length > MAX_ROWS ? `${lines.length - MAX_ROWS} more rows` : undefined,
  };
}

/** Totals by currency, so amounts in different currencies are never added together. */
function totalsByCurrency<T>(items: T[], currency: (t: T) => string, parts: Record<string, (t: T) => number>) {
  const out = new Map<string, Record<string, number>>();
  for (const item of items) {
    const row = out.get(currency(item)) ?? Object.fromEntries([...Object.keys(parts).map((k) => [k, 0]), ["count", 0]]);
    for (const [k, f] of Object.entries(parts)) row[k] = round(row[k] + f(item));
    row.count += 1;
    out.set(currency(item), row);
  }
  return [...out].map(([c, row]) => ({ currency: c, ...row }));
}

const realmOf = (credentials: Record<string, string>, fallback?: string) => {
  const realm = credentials.realmId || fallback || "";
  if (!/^\d+$/.test(realm)) throw new Error("QuickBooks didn't say which company was connected. Connect QuickBooks again from Settings.");
  return realm;
};

/** The calls the tools need, as one company. */
function qbClient(api: Api, realm: string) {
  const base = `v3/company/${realm}`;
  const get = <T>(path: string, query: Record<string, string | number | undefined> = {}) => api<T>("GET", `${base}/${path}`, { query: { ...query, minorversion: MINOR_VERSION } });
  const query = async <T>(entity: string, where: string, tail = "", pages = 1): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 0; page < pages; page++) {
      const sql = `select * from ${entity}${where ? ` where ${where}` : ""}${tail ? ` ${tail}` : ""} startposition ${page * PAGE + 1} maxresults ${PAGE}`;
      const r = await get<{ QueryResponse?: Record<string, T[] | undefined> }>("query", { query: sql });
      const found = r.QueryResponse?.[entity] ?? [];
      out.push(...found);
      if (found.length < PAGE) break;
    }
    return out;
  };
  let home: Promise<string> | undefined;
  return {
    get,
    query,
    /** The company's home currency, for records that don't name one. */
    home: () =>
      (home ??= get<{ Preferences?: { CurrencyPrefs?: { HomeCurrency?: Ref } } }>("preferences")
        .then((r) => r.Preferences?.CurrencyPrefs?.HomeCurrency?.value ?? "")
        .catch(() => "")),
  };
}

/** One open invoice or bill, trimmed, with how late it is. */
function openItem(i: QbInvoice, now: string, currency: string) {
  const late = i.DueDate ? days(i.DueDate, now) : 0;
  return {
    number: i.DocNumber || undefined,
    issued: i.TxnDate,
    due: i.DueDate,
    overdue: late > 0,
    daysOverdue: late > 0 ? late : 0,
    total: i.TotalAmt,
    amountDue: round(i.Balance ?? 0),
    currency: i.CurrencyRef?.value || currency,
  };
}

/** QuickBooks Online accounting, read live when someone asks about money: nothing is copied into memory. */
export const quickbooks: Provider = {
  id: "quickbooks",
  scope: "org",
  auth: {
    kind: "oauth",
    app: "quickbooks",
    // Intuit has no read-only accounting scope; ALRO only ever reads with it.
    scopes: ["com.intuit.quickbooks.accounting"],
    get baseUrl() {
      return process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com/" : "https://quickbooks.api.intuit.com/";
    },
    hosts: HOSTS,
  },
  async identify(api, credentials) {
    const realm = realmOf(credentials);
    const r = await qbClient(api, realm).get<{ CompanyInfo?: { CompanyName?: string; LegalName?: string } }>(`companyinfo/${realm}`);
    return { accountId: realm, label: r.CompanyInfo?.CompanyName || r.CompanyInfo?.LegalName || "QuickBooks company" };
  },
  async receivables(api, ctx) {
    const qb = qbClient(api, realmOf(ctx.credentials, ctx.accountId));
    const open = (await qb.query<QbInvoice>("Invoice", "Balance > '0'", "orderby DueDate", MAX_PAGES)).filter((i) => (i.Balance ?? 0) > 0);
    const home = open.some((i) => !i.CurrencyRef?.value) ? await qb.home() : "";
    // The invoice's own billing email is who to chase; otherwise the customer's main email, read in batches.
    const customerIds = [...new Set(open.map((i) => i.CustomerRef?.value ?? "").filter(Boolean))];
    const customers = new Map<string, QbCustomer>();
    for (let n = 0; n < customerIds.length; n += 100) {
      const ids = qbIds(customerIds.slice(n, n + 100));
      if (ids) for (const c of await qb.query<QbCustomer>("Customer", `Id in (${ids})`)) customers.set(c.Id, c);
    }
    return open.map((i) => {
      const customer = customers.get(i.CustomerRef?.value ?? "");
      return { externalId: i.Id, number: i.DocNumber || undefined, customer: i.CustomerRef?.name, email: i.BillEmail?.Address || customer?.PrimaryEmailAddr?.Address || undefined, phone: customer?.PrimaryPhone?.FreeFormNumber || undefined, currency: i.CurrencyRef?.value || home, amountDue: round(i.Balance ?? 0), dueOn: i.DueDate };
    });
  },
  tools(api, ctx) {
    const qb = qbClient(api, realmOf(ctx.credentials, ctx.accountId));
    return {
      quickbooks_receivables: tool({
        description:
          "Money customers owe the company, live from QuickBooks: invoices with a balance still due, biggest first, with the customer's name and email for chasing and how many days overdue each is. Use for 'who owes us', 'biggest overdue invoices', 'receivables' and the receivables part of a cash report. Say the figures came from QuickBooks.",
        inputSchema: z.object({
          overdueOnly: z.boolean().nullish().describe("Only invoices past their due date."),
          limit: z.number().int().min(1).max(MAX_LIST).nullish().describe("How many invoices to list (default 10)."),
        }),
        execute: async ({ overdueOnly, limit }) => {
          const now = today();
          const open = (await qb.query<QbInvoice>("Invoice", "Balance > '0'", "orderby DueDate", MAX_PAGES)).filter((i) => (i.Balance ?? 0) > 0);
          const home = open.some((i) => !i.CurrencyRef?.value) ? await qb.home() : "";
          const items = open.map((raw) => ({ raw, item: openItem(raw, now, home) }));
          const listed = items
            .filter((o) => !overdueOnly || o.item.overdue)
            .sort((a, b) => b.item.amountDue - a.item.amountDue)
            .slice(0, limit ?? 10);
          // The invoice's own billing email is who to chase; otherwise the customer's main email.
          const missing = [...new Set(listed.filter((o) => !o.raw.BillEmail?.Address).map((o) => o.raw.CustomerRef?.value ?? ""))];
          const ids = qbIds(missing);
          const customers = new Map((ids ? await qb.query<QbCustomer>("Customer", `Id in (${ids})`) : []).map((c) => [c.Id, c]));
          return {
            source: "QuickBooks",
            asOf: now,
            totals: totalsByCurrency(
              items.map((o) => o.item),
              (i) => i.currency,
              { outstanding: (i) => i.amountDue, overdue: (i) => (i.overdue ? i.amountDue : 0) },
            ),
            invoices: listed.map(({ raw, item }) => ({
              ...item,
              customer: raw.CustomerRef?.name,
              email: raw.BillEmail?.Address || customers.get(raw.CustomerRef?.value ?? "")?.PrimaryEmailAddr?.Address || undefined,
            })),
          };
        },
      }),
      quickbooks_payables: tool({
        description:
          "Bills the company has to pay, live from QuickBooks: supplier bills with a balance still due, soonest due first, including any already overdue. Use for 'what bills are due', upcoming payments and the payables part of a cash report. Say the figures came from QuickBooks.",
        inputSchema: z.object({
          dueWithinDays: z.number().int().min(0).max(365).nullish().describe("Bills due within this many days from today, plus all overdue ones (default 14)."),
        }),
        execute: async ({ dueWithinDays }) => {
          const now = today();
          const horizon = new Date(Date.now() + (dueWithinDays ?? 14) * DAY_MS).toISOString().slice(0, 10);
          const open = (await qb.query<QbInvoice>("Bill", "Balance > '0'", "orderby DueDate", MAX_PAGES)).filter((b) => (b.Balance ?? 0) > 0);
          const home = open.some((b) => !b.CurrencyRef?.value) ? await qb.home() : "";
          const bills = open.map((b) => ({ supplier: b.VendorRef?.name, ...openItem(b, now, home) }));
          const due = bills.filter((b) => !b.due || b.due <= horizon).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
          return {
            source: "QuickBooks",
            asOf: now,
            dueBy: horizon,
            totals: totalsByCurrency(due, (b) => b.currency, { due: (b) => b.amountDue, overdue: (b) => (b.overdue ? b.amountDue : 0) }),
            allUnpaid: totalsByCurrency(bills, (b) => b.currency, { due: (b) => b.amountDue }),
            bills: due.slice(0, MAX_LIST),
            truncated: due.length > MAX_LIST ? `${due.length - MAX_LIST} more bills` : undefined,
          };
        },
      }),
      quickbooks_payments: tool({
        description:
          "Payments recorded in QuickBooks since a date, live: money received from customers (and which invoices each paid) or bill payments to suppliers. Use for 'who paid us this week', 'did X pay', and the cash-in part of a weekly cash report. Say the figures came from QuickBooks.",
        inputSchema: z.object({
          since: isoDate.nullish().describe("YYYY-MM-DD; default 7 days ago."),
          direction: z.enum(["received", "paid", "both"]).nullish().describe("received = from customers (default), paid = bill payments to suppliers."),
        }),
        execute: async ({ since, direction }) => {
          const from = since ?? daysAgo(7);
          const want = direction ?? "received";
          const kinds = [
            ...(want !== "paid" ? [{ entity: "Payment", linked: "Invoice", direction: "received" as const }] : []),
            ...(want !== "received" ? [{ entity: "BillPayment", linked: "Bill", direction: "paid" as const }] : []),
          ];
          const payments = [];
          for (const k of kinds) {
            const found = await qb.query<QbPayment>(k.entity, `TxnDate >= ${qbString(from)}`, "orderby TxnDate desc");
            const linkedIds = [...new Set(found.flatMap((p) => (p.Line ?? []).flatMap((l) => (l.LinkedTxn ?? []).filter((t) => t.TxnType === k.linked).map((t) => t.TxnId ?? ""))))];
            const ids = qbIds(linkedIds.slice(0, 200));
            const numbers = new Map((ids ? await qb.query<QbInvoice>(k.linked, `Id in (${ids})`) : []).map((i) => [i.Id, i.DocNumber || `#${i.Id}`]));
            const home = found.some((p) => !p.CurrencyRef?.value) ? await qb.home() : "";
            for (const p of found)
              payments.push({
                date: p.TxnDate,
                direction: k.direction,
                [k.direction === "received" ? "customer" : "supplier"]: (p.CustomerRef ?? p.VendorRef)?.name,
                amount: round(p.TotalAmt ?? 0),
                currency: p.CurrencyRef?.value || home,
                paid: (p.Line ?? []).flatMap((l) =>
                  (l.LinkedTxn ?? []).filter((t) => t.TxnType === k.linked).map((t) => ({ [k.linked === "Invoice" ? "invoice" : "bill"]: numbers.get(t.TxnId ?? "") ?? `#${t.TxnId}`, amount: round(l.Amount ?? 0) })),
                ),
                unapplied: p.UnappliedAmt ? round(p.UnappliedAmt) : undefined,
                reference: p.PaymentRefNum || p.DocNumber || undefined,
              });
          }
          payments.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
          return {
            source: "QuickBooks",
            since: from,
            totals: totalsByCurrency(payments, (p) => `${p.direction} ${p.currency}`, { amount: (p) => p.amount }),
            payments: payments.slice(0, MAX_LIST),
            truncated: payments.length > MAX_LIST ? `${payments.length - MAX_LIST} more payments` : undefined,
          };
        },
      }),
      quickbooks_cash: tool({
        description:
          "Cash position, live from QuickBooks: the current balance of each bank account as recorded in the books. Use for 'how much cash do we have', runway questions and the cash part of a weekly report. Say the figures came from QuickBooks and are book balances (they may differ from the bank if transactions aren't recorded yet).",
        inputSchema: z.object({}),
        execute: async () => {
          const accounts = await qb.query<{ Id: string; Name?: string; FullyQualifiedName?: string; CurrentBalance?: number; CurrencyRef?: Ref; Active?: boolean }>("Account", "AccountType = 'Bank'");
          const home = accounts.some((a) => !a.CurrencyRef?.value) ? await qb.home() : "";
          const banks = accounts.filter((a) => a.Active !== false).map((a) => ({ account: a.FullyQualifiedName || a.Name, currency: a.CurrencyRef?.value || home, balance: round(a.CurrentBalance ?? 0) }));
          return {
            source: "QuickBooks",
            asOf: today(),
            accounts: banks.slice(0, MAX_LIST),
            totals: totalsByCurrency(banks, (b) => b.currency, { balance: (b) => b.balance }),
            note: new Set(banks.map((b) => b.currency)).size > 1 ? "Accounts are in different currencies; totals are per currency." : undefined,
          };
        },
      }),
      quickbooks_report: tool({
        description:
          "A QuickBooks report, live: profit_and_loss for a period, balance_sheet at a date, or aged_receivables (what each customer owes by how late it is). Returned as a few labelled rows (top-level totals); ask for detail to get every line. Use for revenue, expenses, profit, margins, the balance sheet and aging. Say the figures came from QuickBooks.",
        inputSchema: z.object({
          report: z.enum(["profit_and_loss", "balance_sheet", "aged_receivables"]),
          from: isoDate.nullish().describe("Profit and loss: start, YYYY-MM-DD (default the 1st of this month)."),
          to: isoDate.nullish().describe("Profit and loss: end; balance sheet and aging: the date (default today)."),
          detail: z.boolean().nullish().describe("Every line instead of just totals."),
        }),
        execute: async ({ report, from, to, detail }) => {
          const end = to ?? today();
          const r =
            report === "profit_and_loss"
              ? await qb.get<QbReport>("reports/ProfitAndLoss", { start_date: from ?? `${end.slice(0, 8)}01`, end_date: end })
              : report === "balance_sheet"
                ? await qb.get<QbReport>("reports/BalanceSheet", { start_date: end, end_date: end })
                : await qb.get<QbReport>("reports/AgedReceivables", { report_date: end });
          return { source: "QuickBooks", ...flattenReport(r, !!detail) };
        },
      }),
      quickbooks_customer: tool({
        description:
          "Look up a customer in QuickBooks, live: email, phone, open balance, how much is overdue, and their unpaid invoices. Use before chasing a payment or when asked about one customer's account. Say the figures came from QuickBooks.",
        inputSchema: z.object({ name: z.string().min(1).max(100).describe("Part of the customer's display or company name.") }),
        execute: async ({ name }) => {
          let matches = await qb.query<QbCustomer>("Customer", `DisplayName like ${qbContains(name)}`);
          // The query language has no OR, so the company name is a second try.
          if (!matches.length) matches = await qb.query<QbCustomer>("Customer", `CompanyName like ${qbContains(name)}`);
          if (!matches.length) return { source: "QuickBooks", matches: [], note: `No QuickBooks customer matches "${name}".` };
          const best = matches[0];
          const now = today();
          const ids = qbIds([best.Id]);
          const open = ids ? (await qb.query<QbInvoice>("Invoice", `CustomerRef = ${ids} and Balance > '0'`, "orderby DueDate")).map((i) => openItem(i, now, best.CurrencyRef?.value ?? "")) : [];
          return {
            source: "QuickBooks",
            customer: {
              name: best.DisplayName,
              company: best.CompanyName || undefined,
              email: best.PrimaryEmailAddr?.Address,
              phone: best.PrimaryPhone?.FreeFormNumber,
              currency: best.CurrencyRef?.value,
              balance: round(best.Balance ?? 0),
              overdue: round(open.reduce((s, i) => s + (i.overdue ? i.amountDue : 0), 0)),
            },
            unpaidInvoices: open.slice(0, 10),
            otherMatches: matches.slice(1, 5).map((c) => ({ name: c.DisplayName, email: c.PrimaryEmailAddr?.Address })),
          };
        },
      }),
    };
  },
};
