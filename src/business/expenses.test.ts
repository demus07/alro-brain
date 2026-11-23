import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { deleteExpense, expenseSummary, expensesCsv, gstinValid, listExpenses, logExpense } from "./expenses";

const NOW = new Date("2026-11-20T06:00:00Z");
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let person: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co" }).returning();
  [{ id: person }] = await db.insert(people).values({ orgId, displayName: "Ravi, the driver", isMember: true, role: "member" }).returning();
}, 60_000);
afterAll(() => close());

describe("expenses", () => {
  it("records a receipt with its GST, and the same bill photographed twice once", async () => {
    const a = await logExpense(db, orgId, person, { vendor: "Indian Oil", spentOn: "2026-11-18", amount: 4200, taxAmount: 640.68, category: "Fuel", taxId: "27aaacb1234f1z5", invoiceNumber: "B-77" }, NOW);
    expect(a).toMatchObject({ amount: 4200, taxAmount: 640.68, category: "fuel", taxId: "27AAACB1234F1Z5", paidBy: "company" });
    expect((await logExpense(db, orgId, person, { vendor: "Indian Oil", spentOn: "2026-11-18", amount: 4200, invoiceNumber: "B-77" }, NOW)).id).toBe(a.id);
    expect(await listExpenses(db, orgId)).toHaveLength(1);
  });

  it("refuses what can't be right", async () => {
    await expect(logExpense(db, orgId, person, { vendor: " ", amount: 5 }, NOW)).rejects.toThrow(/bill/);
    await expect(logExpense(db, orgId, person, { vendor: "X", amount: 0 }, NOW)).rejects.toThrow(/more than zero/);
    await expect(logExpense(db, orgId, person, { vendor: "X", amount: 5, spentOn: "20-11-2026" }, NOW)).rejects.toThrow(/date/);
    await expect(logExpense(db, orgId, person, { vendor: "X", amount: 5, spentOn: "2027-01-01" }, NOW)).rejects.toThrow(/future/);
    await expect(logExpense(db, orgId, person, { vendor: "X", amount: 5, taxAmount: 9 }, NOW)).rejects.toThrow(/tax/);
  });

  it("totals by category and currency, with what's owed back to people who paid themselves", async () => {
    await logExpense(db, orgId, person, { vendor: "Dhaba", spentOn: "2026-11-19", amount: 300, category: "food", paidBy: "personal" }, NOW);
    await logExpense(db, orgId, person, { vendor: "AWS", spentOn: "2026-11-01", amount: 50, currency: "usd", category: "software" }, NOW);
    const s = await expenseSummary(db, orgId);
    expect(s.find((x) => x.currency === "INR")).toMatchObject({ total: 4500, tax: 640.68, count: 2, toReimburse: 300, byCategory: [{ category: "fuel", total: 4200 }, { category: "food", total: 300 }] });
    expect(s.find((x) => x.currency === "USD")?.total).toBe(50);
    expect((await expenseSummary(db, orgId, { from: "2026-11-19" })).find((x) => x.currency === "INR")?.total).toBe(300);
  });

  it("exports a spreadsheet that can't run a formula typed into a receipt", async () => {
    await logExpense(db, orgId, person, { vendor: '=HYPERLINK("http://x")', spentOn: "2026-11-17", amount: 10, note: 'says "hi", ok' }, NOW);
    const csv = await expensesCsv(db, orgId);
    expect(csv.startsWith("﻿Date,Vendor,Vendor GSTIN")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"Ravi, the driver"');
    expect(csv).toContain("Employee (reimburse)");
    expect(csv.split("\r\n").filter(Boolean).length).toBe(1 + (await listExpenses(db, orgId)).length);
  });

  it("checks a GSTIN's shape and deletes by company", async () => {
    expect([gstinValid("27AAACB1234F1Z5"), gstinValid("27AAACB1234F1X5"), gstinValid(null)]).toEqual([true, false, false]);
    const [{ e }] = await listExpenses(db, orgId, {}, 1);
    const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
    await expect(deleteExpense(db, other.id, e.id)).rejects.toThrow(/Not found/);
    await deleteExpense(db, orgId, e.id);
  });
});
