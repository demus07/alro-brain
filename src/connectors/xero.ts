import { tool } from "ai";
import { z } from "zod";
import type { Api } from "./api";
import type { Provider } from "./provider";

/*
 * Xero accounting, read live for the finance agent: cash, receivables, bills, payments and reports.
 * Every call names the organisation in the `xero-tenant-id` header. Xero allows 60 calls a minute
 * per organisation, so each tool makes as few as it can.
 */

const DAY_MS = 86_400_000;
const PAGE = 200;
const MAX_PAGES = 5;
const MAX_LIST = 25;
const MAX_ROWS = 40;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

interface XeroContactRef {
  ContactID: string;
  Name?: string;
}
interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type: string;
  Status: string;
  Contact?: XeroContactRef;
  DateString?: string;
  Date?: string;
  DueDateString?: string;
  DueDate?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  CurrencyCode?: string;
}
interface XeroContact extends XeroContactRef {
  EmailAddress?: string;
  ContactPersons?: { FirstName?: string; LastName?: string; EmailAddress?: string; IncludeInEmails?: boolean }[];
  Phones?: { PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }[];
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  ContactStatus?: string;
  DefaultCurrency?: string;
  Balances?: {
    AccountsReceivable?: { Outstanding?: number; Overdue?: number };
    AccountsPayable?: { Outstanding?: number; Overdue?: number };
  };
}
interface XeroPayment {
  PaymentID: string;
  Date?: string;
  Amount?: number;
  Reference?: string;
  PaymentType?: string;
  Status?: string;
  CurrencyRate?: number;
  Invoice?: { InvoiceID?: string; InvoiceNumber?: string; Type?: string; CurrencyCode?: string; Contact?: XeroContactRef };
}
interface XeroRow {
  RowType: string;
  Title?: string;
  Cells?: { Value?: string; Attributes?: { Id?: string; Value?: string }[] }[];
  Rows?: XeroRow[];
}
interface XeroReport {
  ReportName?: string;
  ReportTitles?: string[];
  Rows?: XeroRow[];
}

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Xero sends dates as "2026-11-30T00:00:00" strings and as "/Date(1764460800000+0000)/". */
export function xeroDate(text?: string, raw?: string): string | undefined {
  if (text) return text.slice(0, 10);
  const ms = raw && /\/Date\((-?\d+)/.exec(raw)?.[1];
  return ms ? new Date(Number(ms)).toISOString().slice(0, 10) : undefined;
}

/** A report cell as a number when it is one ("1,234.50" → 1234.5), otherwise the text. */
const cellValue = (v = "") => (/^-?[\d,]*\.?\d+$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : v);

/** A Xero report as a few labelled rows: section totals and stand-alone lines (Gross Profit, Net Profit), or every line with `detail`. */
export function flattenReport(report: XeroReport, detail = false) {
  const rows = report.Rows ?? [];
  const columns = (rows.find((r) => r.RowType === "Header")?.Cells ?? []).slice(1).map((c) => c.Value ?? "");
  const lines: { section?: string; label: string; values: (number | string)[] }[] = [];
  for (const section of rows) {
    if (section.RowType !== "Section") continue;
    for (const row of section.Rows ?? []) {
      const [label = "", ...values] = (row.Cells ?? []).map((c) => c.Value ?? "");
      if (!label || !(detail || row.RowType === "SummaryRow" || !section.Title)) continue;
      lines.push({ section: section.Title || undefined, label, values: values.map(cellValue) });
    }
  }
  return {
    report: report.ReportName,
    titles: report.ReportTitles,
    columns,
    rows: lines.slice(0, MAX_ROWS),
    truncated: lines.length > MAX_ROWS ? `${lines.length - MAX_ROWS} more rows` : undefined,
  };
}

const emailOf = (c?: XeroContact) => c?.EmailAddress || c?.ContactPersons?.find((p) => p.IncludeInEmails && p.EmailAddress)?.EmailAddress || c?.ContactPersons?.find((p) => p.EmailAddress)?.EmailAddress || undefined;

const phoneOf = (c?: XeroContact) => {
  const p = c?.Phones?.find((x) => x.PhoneNumber && (x.PhoneType === "DEFAULT" || x.PhoneType === "MOBILE"));
  return p ? [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(" ") : undefined;
};

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

/** The calls the tools need, as one organisation. */
function xeroClient(api: Api, tenantId: string) {
  const get = <T>(path: string, query?: Record<string, string | number | undefined>) => api<T>("GET", path, { query, headers: { "xero-tenant-id": tenantId } });
  let org: Promise<{ name: string; currency: string }> | undefined;
  return {
    get,
    organisation: () =>
      (org ??= get<{ Organisations?: { Name?: string; BaseCurrency?: string }[] }>("Organisation")
        .then((r) => ({ name: r.Organisations?.[0]?.Name ?? "", currency: r.Organisations?.[0]?.BaseCurrency ?? "" }))
        .catch((e) => {
          org = undefined;
          throw e;
        })),
    /** Approved invoices (ACCREC) or bills (ACCPAY) with money still owing. AUTHORISED means approved and not yet fully paid. */
    async openInvoices(type: "ACCREC" | "ACCPAY", contactId?: string) {
      const out: XeroInvoice[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await get<{ Invoices?: XeroInvoice[]; pagination?: { pageCount?: number } }>("Invoices", {
          where: `Type=="${type}"`,
          Statuses: "AUTHORISED",
          ContactIDs: contactId,
          order: "DueDate ASC",
          page,
          pageSize: PAGE,
        });
        out.push(...(r.Invoices ?? []));
        if ((r.Invoices?.length ?? 0) < PAGE || (r.pagination?.pageCount ?? page) <= page) break;
      }
      return out.filter((i) => (i.AmountDue ?? 0) > 0);
    },
    async contacts(ids: string[]) {
      if (!ids.length) return new Map<string, XeroContact>();
      const r = await get<{ Contacts?: XeroContact[] }>("Contacts", { IDs: ids.join(",") });
      return new Map((r.Contacts ?? []).map((c) => [c.ContactID, c]));
    },
  };
}

/** One open invoice or bill, trimmed, with how late it is. */
function openItem(i: XeroInvoice, now: string, contact?: XeroContact) {
  const due = xeroDate(i.DueDateString, i.DueDate);
  const late = due ? days(due, now) : 0;
  return {
    number: i.InvoiceNumber || undefined,
    reference: i.Reference || undefined,
    contact: i.Contact?.Name,
    email: emailOf(contact),
    issued: xeroDate(i.DateString, i.Date),
    due,
    overdue: late > 0,
    daysOverdue: late > 0 ? late : 0,
    total: i.Total,
    amountDue: round(i.AmountDue ?? 0),
    currency: i.CurrencyCode ?? "",
  };
}

const omit = <T extends object, K extends keyof T>(o: T, ...keys: K[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k as K))) as Omit<T, K>;

const AGE_BUCKETS = ["current", "1-30", "31-60", "61-90", "over 90"] as const;
const bucketOf = (late: number) => (late <= 0 ? "current" : late <= 30 ? "1-30" : late <= 60 ? "31-60" : late <= 90 ? "61-90" : "over 90");

/** Xero accounting, read live when someone asks about money: nothing is copied into memory. */
export const xero: Provider = {
  id: "xero",
  scope: "org",
  auth: {
    kind: "oauth",
    app: "xero",
    // Granular read-only scopes (required for Xero apps created from March 2026). offline_access is added by oauth.ts.
    scopes: [
      "accounting.invoices.read",
      "accounting.payments.read",
      "accounting.contacts.read",
      "accounting.settings.read",
      "accounting.reports.banksummary.read",
      "accounting.reports.profitandloss.read",
      "accounting.reports.balancesheet.read",
    ],
    baseUrl: "https://api.xero.com/api.xro/2.0/",
  },
  async identify(api) {
    const connections = await api<{ tenantId: string; tenantType: string; tenantName?: string; updatedDateUtc?: string }[]>("GET", "https://api.xero.com/connections");
    // A person can authorise several organisations; the one most recently connected is the one they just picked.
    const orgs = (Array.isArray(connections) ? connections : [])
      .filter((c) => c.tenantType === "ORGANISATION")
      .sort((a, b) => (b.updatedDateUtc ?? "").localeCompare(a.updatedDateUtc ?? ""));
    if (!orgs.length) throw new Error("Xero didn't share any organisation. Connect again and pick your organisation when Xero asks.");
    return { accountId: orgs[0].tenantId, label: orgs[0].tenantName || "Xero organisation" };
  },
  async receivables(api, ctx) {
    const xc = xeroClient(api, ctx.accountId);
    const open = await xc.openInvoices("ACCREC");
    const ids = [...new Set(open.flatMap((i) => (i.Contact?.ContactID ? [i.Contact.ContactID] : [])))];
    const contacts = new Map<string, XeroContact>();
    for (let n = 0; n < ids.length; n += 40) for (const [id, c] of await xc.contacts(ids.slice(n, n + 40))) contacts.set(id, c);
    const home = open.some((i) => !i.CurrencyCode) ? (await xc.organisation()).currency : "";
    return open.map((i) => {
      const contact = contacts.get(i.Contact?.ContactID ?? "");
      return { externalId: i.InvoiceID, number: i.InvoiceNumber || undefined, customer: i.Contact?.Name, email: emailOf(contact), phone: phoneOf(contact), currency: i.CurrencyCode || home, amountDue: round(i.AmountDue ?? 0), dueOn: xeroDate(i.DueDateString, i.DueDate) };
    });
  },
  tools(api, ctx) {
    const xc = xeroClient(api, ctx.accountId);
    return {
      xero_receivables: tool({
        description:
          "Money customers owe the company, live from Xero: approved sales invoices with an amount still due, biggest first, with the customer's name and email for chasing and how many days overdue each is. Use for 'who owes us', 'biggest overdue invoices', 'receivables' and the receivables part of a cash report. Say the figures came from Xero.",
        inputSchema: z.object({
          overdueOnly: z.boolean().nullish().describe("Only invoices past their due date."),
          limit: z.number().int().min(1).max(MAX_LIST).nullish().describe("How many invoices to list (default 10)."),
        }),
        execute: async ({ overdueOnly, limit }) => {
          const now = today();
          const open = (await xc.openInvoices("ACCREC")).map((i) => ({ raw: i, item: openItem(i, now) }));
          const totals = totalsByCurrency(
            open.map((o) => o.item),
            (i) => i.currency,
            { outstanding: (i) => i.amountDue, overdue: (i) => (i.overdue ? i.amountDue : 0) },
          );
          const listed = open
            .filter((o) => !overdueOnly || o.item.overdue)
            .sort((a, b) => b.item.amountDue - a.item.amountDue)
            .slice(0, limit ?? 10);
          const contacts = await xc.contacts([...new Set(listed.flatMap((o) => (o.raw.Contact?.ContactID ? [o.raw.Contact.ContactID] : [])))]);
          return {
            source: "Xero",
            asOf: now,
            totals,
            invoices: listed.map((o) => openItem(o.raw, now, contacts.get(o.raw.Contact?.ContactID ?? ""))),
          };
        },
      }),
      xero_payables: tool({
        description:
          "Bills the company has to pay, live from Xero: approved supplier bills with an amount still due, soonest due first, including any already overdue. Use for 'what bills are due', upcoming payments and the payables part of a cash report. Say the figures came from Xero.",
        inputSchema: z.object({
          dueWithinDays: z.number().int().min(0).max(365).nullish().describe("Bills due within this many days from today, plus all overdue ones (default 14)."),
        }),
        execute: async ({ dueWithinDays }) => {
          const now = today();
          const horizon = new Date(Date.now() + (dueWithinDays ?? 14) * DAY_MS).toISOString().slice(0, 10);
          const bills = (await xc.openInvoices("ACCPAY")).map((b) => openItem(b, now));
          const due = bills.filter((b) => !b.due || b.due <= horizon).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
          return {
            source: "Xero",
            asOf: now,
            dueBy: horizon,
            totals: totalsByCurrency(due, (b) => b.currency, { due: (b) => b.amountDue, overdue: (b) => (b.overdue ? b.amountDue : 0) }),
            allUnpaid: totalsByCurrency(bills, (b) => b.currency, { due: (b) => b.amountDue }),
            bills: due.slice(0, MAX_LIST).map((b) => ({ supplier: b.contact, ...omit(b, "contact", "email") })),
            truncated: due.length > MAX_LIST ? `${due.length - MAX_LIST} more bills` : undefined,
          };
        },
      }),
      xero_payments: tool({
        description:
          "Payments recorded in Xero since a date, live: money received from customers (and which invoice each paid) or paid to suppliers. Use for 'who paid us this week', 'did X pay', and the cash-in part of a weekly cash report. Say the figures came from Xero.",
        inputSchema: z.object({
          since: isoDate.nullish().describe("YYYY-MM-DD; default 7 days ago."),
          direction: z.enum(["received", "paid", "both"]).nullish().describe("received = from customers (default), paid = to suppliers."),
        }),
        execute: async ({ since, direction }) => {
          const from = since ?? daysAgo(7);
          const [y, m, d] = from.split("-").map(Number);
          const want = direction ?? "received";
          const types = new Set(want === "received" ? ["ACCRECPAYMENT"] : want === "paid" ? ["ACCPAYPAYMENT"] : ["ACCRECPAYMENT", "ACCPAYPAYMENT"]);
          const found: XeroPayment[] = [];
          for (let page = 1; page <= 3; page++) {
            const r = await xc.get<{ Payments?: XeroPayment[] }>("Payments", { where: `Date>=DateTime(${y},${m},${d}) AND Status=="AUTHORISED"`, order: "Date DESC", page, pageSize: 100 });
            found.push(...(r.Payments ?? []));
            if ((r.Payments?.length ?? 0) < 100) break;
          }
          const { currency: base } = await xc.organisation();
          const payments = found
            .filter((p) => types.has(p.PaymentType ?? ""))
            .map((p) => ({
              date: xeroDate(undefined, p.Date),
              direction: p.PaymentType === "ACCPAYPAYMENT" ? "paid" : "received",
              contact: p.Invoice?.Contact?.Name,
              invoiceNumber: p.Invoice?.InvoiceNumber || undefined,
              amount: round(p.Amount ?? 0),
              // Amounts are in the invoice's currency; Xero leaves it off the payment, so a non-1 rate means "not the base currency".
              currency: p.Invoice?.CurrencyCode ?? (!p.CurrencyRate || p.CurrencyRate === 1 ? base : "not the base currency"),
              reference: p.Reference || undefined,
            }));
          return {
            source: "Xero",
            since: from,
            totals: totalsByCurrency(payments, (p) => `${p.direction} ${p.currency}`, { amount: (p) => p.amount }),
            payments: payments.slice(0, MAX_LIST),
            truncated: payments.length > MAX_LIST ? `${payments.length - MAX_LIST} more payments` : undefined,
          };
        },
      }),
      xero_cash: tool({
        description:
          "Cash position, live from Xero: each bank account's opening balance, money in, money out and closing balance over a period (Xero's Bank Summary). Use for 'how much cash do we have', runway questions and the cash part of a weekly report. Say the figures came from Xero and are as reconciled in Xero.",
        inputSchema: z.object({
          since: isoDate.nullish().describe("Start of the period, YYYY-MM-DD; default the 1st of this month."),
          until: isoDate.nullish().describe("End of the period, YYYY-MM-DD; default today."),
        }),
        execute: async ({ since, until }) => {
          const to = until ?? today();
          const from = since ?? `${to.slice(0, 8)}01`;
          const { currency: base } = await xc.organisation();
          const accounts = await xc.get<{ Accounts?: { AccountID: string; Name?: string; CurrencyCode?: string }[] }>("Accounts", { where: 'Type=="BANK"' });
          const summary = await xc.get<{ Reports?: XeroReport[] }>("Reports/BankSummary", { fromDate: from, toDate: to });
          const currencyOf = new Map((accounts.Accounts ?? []).map((a) => [a.AccountID, a.CurrencyCode || base]));
          const rows = (summary.Reports?.[0]?.Rows ?? []).filter((r) => r.RowType === "Section").flatMap((s) => s.Rows ?? []);
          const banks = rows
            .filter((r) => r.RowType === "Row")
            .map((r) => {
              const cells = r.Cells ?? [];
              const id = cells[0]?.Attributes?.find((a) => a.Id === "accountID")?.Value ?? "";
              const n = (i: number) => round(Number((cells[i]?.Value ?? "0").replace(/,/g, "")) || 0);
              return { account: cells[0]?.Value ?? "", currency: currencyOf.get(id) ?? base, opening: n(1), received: n(2), spent: n(3), closing: n(4) };
            });
          const currencies = new Set(banks.map((b) => b.currency));
          return {
            source: "Xero",
            from,
            to,
            accounts: banks.slice(0, MAX_LIST),
            totals: totalsByCurrency(banks, (b) => b.currency, { opening: (b) => b.opening, received: (b) => b.received, spent: (b) => b.spent, closing: (b) => b.closing }),
            note: currencies.size > 1 ? "Accounts are in different currencies; totals are per currency." : undefined,
          };
        },
      }),
      xero_report: tool({
        description:
          "A Xero report, live: profit_and_loss for a period, balance_sheet at a date, or aged_receivables (what each customer owes by how late it is). Returned as a few labelled rows (section totals, gross and net profit); ask for detail to get every line. Use for revenue, expenses, profit, margins, the balance sheet and aging. Say the figures came from Xero.",
        inputSchema: z.object({
          report: z.enum(["profit_and_loss", "balance_sheet", "aged_receivables"]),
          from: isoDate.nullish().describe("Profit and loss: start, YYYY-MM-DD (default the 1st of this month)."),
          to: isoDate.nullish().describe("Profit and loss: end; balance sheet: the date (default today)."),
          detail: z.boolean().nullish().describe("Every line instead of just totals."),
        }),
        execute: async ({ report, from, to, detail }) => {
          const end = to ?? today();
          if (report === "aged_receivables") {
            // Built from open invoices: Xero's own aged report needs one contact at a time.
            const now = today();
            const byContact = new Map<string, { contact: string; currency: string; total: number } & Record<(typeof AGE_BUCKETS)[number], number>>();
            for (const i of (await xc.openInvoices("ACCREC")).map((x) => openItem(x, now))) {
              const key = `${i.contact}|${i.currency}`;
              const row = byContact.get(key) ?? { contact: i.contact ?? "", currency: i.currency, total: 0, current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "over 90": 0 };
              const b = bucketOf(i.daysOverdue);
              row[b] = round(row[b] + i.amountDue);
              row.total = round(row.total + i.amountDue);
              byContact.set(key, row);
            }
            const rows = [...byContact.values()].sort((a, b) => b.total - a.total);
            return { source: "Xero", report: "Aged receivables", asOf: now, buckets: AGE_BUCKETS, rows: rows.slice(0, MAX_LIST), truncated: rows.length > MAX_LIST ? `${rows.length - MAX_LIST} more customers` : undefined };
          }
          const r =
            report === "profit_and_loss"
              ? await xc.get<{ Reports?: XeroReport[] }>("Reports/ProfitAndLoss", { fromDate: from ?? `${end.slice(0, 8)}01`, toDate: end })
              : await xc.get<{ Reports?: XeroReport[] }>("Reports/BalanceSheet", { date: end });
          return { source: "Xero", ...flattenReport(r.Reports?.[0] ?? {}, !!detail) };
        },
      }),
      xero_contact: tool({
        description:
          "Look up a customer or supplier in Xero, live: email, phone, what they owe us or we owe them (outstanding and overdue), and their unpaid invoices. Use before chasing a payment or when asked about one company's account. Say the figures came from Xero.",
        inputSchema: z.object({ name: z.string().min(1).describe("Part of the contact's name, email or account number.") }),
        execute: async ({ name }) => {
          const r = await xc.get<{ Contacts?: XeroContact[] }>("Contacts", { searchTerm: name.slice(0, 100), page: 1, pageSize: 5 });
          const matches = (r.Contacts ?? []).slice(0, 5);
          if (!matches.length) return { source: "Xero", matches: [], note: `No Xero contact matches "${name}".` };
          // Balances aren't always included in a search; the single-contact call has them.
          const best = matches[0].Balances ? matches[0] : ((await xc.get<{ Contacts?: XeroContact[] }>(`Contacts/${encodeURIComponent(matches[0].ContactID)}`)).Contacts?.[0] ?? matches[0]);
          const now = today();
          const open = (await xc.openInvoices("ACCREC", best.ContactID)).map((i) => openItem(i, now, best));
          const shape = (c: XeroContact) => ({
            name: c.Name,
            email: emailOf(c),
            phone: phoneOf(c),
            customer: c.IsCustomer,
            supplier: c.IsSupplier,
            currency: c.DefaultCurrency,
            owesUs: c.Balances?.AccountsReceivable && { outstanding: round(c.Balances.AccountsReceivable.Outstanding ?? 0), overdue: round(c.Balances.AccountsReceivable.Overdue ?? 0) },
            weOwe: c.Balances?.AccountsPayable && { outstanding: round(c.Balances.AccountsPayable.Outstanding ?? 0), overdue: round(c.Balances.AccountsPayable.Overdue ?? 0) },
          });
          return {
            source: "Xero",
            contact: shape(best),
            unpaidInvoices: open.slice(0, 10).map((i) => omit(i, "contact", "email")),
            otherMatches: matches.slice(1).map((c) => ({ name: c.Name, email: emailOf(c) })),
          };
        },
      }),
    };
  },
};
