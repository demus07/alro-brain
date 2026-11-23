import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { expenses, people } from "@/db/schema";

export type Expense = typeof expenses.$inferSelect;

export const CATEGORIES = ["travel", "fuel", "food", "office", "raw material", "freight", "repairs", "utilities", "rent", "salary", "software", "marketing", "professional fees", "other"] as const;

export interface ExpenseInput {
  vendor: string;
  spentOn?: string;
  amount: number;
  taxAmount?: number | null;
  currency?: string;
  category?: string | null;
  taxId?: string | null;
  paidBy?: "company" | "personal";
  invoiceNumber?: string | null;
  note?: string | null;
}

const clean = (v: string | null | undefined, max: number) => v?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** An Indian GSTIN: 15 characters, state code first. Anything else typed is kept as the receipt read it, but flagged by `gstinValid`. */
export const gstinValid = (id: string | null | undefined) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test((id ?? "").toUpperCase());

export async function logExpense(db: Db, orgId: string, personId: string, input: ExpenseInput, now = new Date()): Promise<Expense> {
  const vendor = clean(input.vendor, 160);
  if (!vendor) throw new Error("Whose bill is it?");
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("The amount must be more than zero.");
  const spentOn = input.spentOn ?? now.toISOString().slice(0, 10);
  if (!DAY.test(spentOn) || Number.isNaN(Date.parse(spentOn))) throw new Error("Use a date like 2026-11-20.");
  if (Date.parse(spentOn) > now.getTime() + 2 * 86_400_000) throw new Error("That date is in the future.");
  const tax = input.taxAmount ?? null;
  if (tax !== null && (!(tax >= 0) || tax > input.amount)) throw new Error("The tax can't be more than the total.");
  const category = clean(input.category, 40)?.toLowerCase() ?? null;
  const taxId = clean(input.taxId, 40)?.toUpperCase().replace(/\s/g, "") ?? null;
  const invoiceNumber = clean(input.invoiceNumber, 60);
  // The same bill photographed twice is one expense.
  const [dupe] = await db.select().from(expenses).where(and(eq(expenses.orgId, orgId), eq(expenses.vendor, vendor), eq(expenses.spentOn, spentOn), eq(expenses.amount, input.amount), invoiceNumber ? eq(expenses.invoiceNumber, invoiceNumber) : undefined)).limit(1);
  if (dupe) return dupe;
  const [row] = await db
    .insert(expenses)
    .values({ orgId, personId, vendor, spentOn, amount: input.amount, taxAmount: tax, currency: (input.currency ?? "INR").toUpperCase().slice(0, 3), category, taxId, paidBy: input.paidBy === "personal" ? "personal" : "company", invoiceNumber, note: clean(input.note, 500), createdAt: now })
    .returning();
  return row;
}

export interface Range {
  from?: string;
  to?: string;
}
const within = (orgId: string, r: Range) => and(eq(expenses.orgId, orgId), r.from ? gte(expenses.spentOn, r.from) : undefined, r.to ? lte(expenses.spentOn, r.to) : undefined);

export const listExpenses = (db: Db, orgId: string, r: Range = {}, limit = 500) =>
  db.select({ e: expenses, who: people.displayName }).from(expenses).innerJoin(people, eq(people.id, expenses.personId)).where(within(orgId, r)).orderBy(desc(expenses.spentOn), desc(expenses.createdAt)).limit(limit);

export interface ExpenseSummary {
  currency: string;
  total: number;
  tax: number;
  count: number;
  /** Paid by someone from their own pocket and owed back. */
  toReimburse: number;
  byCategory: { category: string; total: number }[];
}

export async function expenseSummary(db: Db, orgId: string, r: Range = {}): Promise<ExpenseSummary[]> {
  const rows = await db
    .select({
      currency: expenses.currency,
      category: sql<string>`coalesce(${expenses.category}, 'uncategorised')`,
      total: sql<number>`sum(${expenses.amount})::float`,
      tax: sql<number>`coalesce(sum(${expenses.taxAmount}), 0)::float`,
      count: sql<number>`count(*)::int`,
      owed: sql<number>`coalesce(sum(${expenses.amount}) filter (where ${expenses.paidBy} = 'personal'), 0)::float`,
    })
    .from(expenses)
    .where(within(orgId, r))
    .groupBy(expenses.currency, sql`coalesce(${expenses.category}, 'uncategorised')`);
  const by = new Map<string, ExpenseSummary>();
  for (const x of rows) {
    const s = by.get(x.currency) ?? { currency: x.currency, total: 0, tax: 0, count: 0, toReimburse: 0, byCategory: [] };
    s.total += x.total;
    s.tax += x.tax;
    s.count += x.count;
    s.toReimburse += x.owed;
    s.byCategory.push({ category: x.category, total: x.total });
    by.set(x.currency, s);
  }
  return [...by.values()].map((s) => ({ ...s, byCategory: s.byCategory.sort((a, b) => b.total - a.total) })).sort((a, b) => b.total - a.total);
}

/** A cell that a spreadsheet would run as a formula is made plain text first. */
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** For the accountant: one row per expense, with the GST the receipt showed and the vendor's tax ID. */
export async function expensesCsv(db: Db, orgId: string, r: Range = {}): Promise<string> {
  const rows = await db.select({ e: expenses, who: people.displayName }).from(expenses).innerJoin(people, eq(people.id, expenses.personId)).where(within(orgId, r)).orderBy(asc(expenses.spentOn), asc(expenses.createdAt)).limit(20_000);
  const head = ["Date", "Vendor", "Vendor GSTIN", "Invoice number", "Category", "Amount", "GST included", "Currency", "Paid by", "Recorded by", "Note"];
  const lines = rows.map(({ e, who }) => [e.spentOn, e.vendor, e.taxId, e.invoiceNumber, e.category, e.amount, e.taxAmount, e.currency, e.paidBy === "personal" ? "Employee (reimburse)" : "Company", who, e.note].map(cell).join(","));
  return `﻿${[head.join(","), ...lines].join("\r\n")}\r\n`;
}

export async function deleteExpense(db: Db, orgId: string, id: string) {
  const [r] = await db.delete(expenses).where(and(eq(expenses.id, id), eq(expenses.orgId, orgId))).returning({ id: expenses.id });
  if (!r) throw new Error("Not found");
}
