import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { deadlines, orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";

const notified: { to: string; text: string }[] = [];
vi.mock("@/channels/links", () => ({ notifyPerson: async (_db: unknown, _org: string, to: string, text: string) => (notified.push({ to, text }), ["whatsapp"]) }));

import { addDeadline, addIndiaPresets, addMonths, completeDeadline, listDeadlines, nextDue, runDeadlines } from "./deadlines";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let owner: string;
const at = (day: string) => new Date(`${day}T06:00:00Z`);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: owner }] = await db.insert(people).values({ orgId, displayName: "Sumedh", isMember: true, role: "owner" }).returning();
}, 60_000);
afterAll(() => close());
beforeEach(async () => {
  notified.length = 0;
  await db.delete(deadlines);
});

describe("dates", () => {
  it("moves by months without overflowing short ones", () => {
    expect([addMonths("2026-01-31", 1), addMonths("2026-11-30", 3), addMonths("2028-02-29", 12), addMonths("2026-12-15", 1)]).toEqual(["2026-02-28", "2027-02-28", "2029-02-28", "2027-01-15"]);
    expect(nextDue("2026-11-20", "none")).toBeUndefined();
  });
  it("validates what's typed", async () => {
    await expect(addDeadline(db, orgId, { title: " ", dueOn: "2026-12-01" })).rejects.toThrow(/What/);
    await expect(addDeadline(db, orgId, { title: "x", dueOn: "1 Dec" })).rejects.toThrow(/date/);
  });
});

describe("reminders", () => {
  it("tells the owner once per window, tightest first, then daily when overdue", async () => {
    await addDeadline(db, orgId, { title: "FSSAI licence renewal", kind: "licence", dueOn: "2026-12-31", ownerPersonId: owner });
    expect((await runDeadlines(db, orgId, at("2026-11-20"))).reminded).toBe(0);
    expect((await runDeadlines(db, orgId, at("2026-12-01"))).reminded).toBe(1);
    expect(notified[0].text).toContain("due in 30 days (2026-12-31)");
    expect((await runDeadlines(db, orgId, at("2026-12-02"))).reminded).toBe(0);
    // Jumping to 5 days out announces the 7-day window once, not the 30 too.
    expect((await runDeadlines(db, orgId, at("2026-12-26"))).reminded).toBe(1);
    expect((await runDeadlines(db, orgId, at("2026-12-26"))).reminded).toBe(0);
    expect((await runDeadlines(db, orgId, at("2026-12-30"))).reminded).toBe(1);
    expect(notified.at(-1)!.text).toContain("due in 1 day ");
    expect((await runDeadlines(db, orgId, at("2027-01-02"))).overdue).toBe(1);
    expect(notified.at(-1)!.text).toContain("was due 2 days ago");
    expect((await runDeadlines(db, orgId, at("2027-01-03"))).overdue).toBe(1);
    expect(notified.every((n) => n.to === owner)).toBe(true);
  });

  it("falls back to the owner when the date has nobody assigned", async () => {
    await addDeadline(db, orgId, { title: "Rent agreement", dueOn: "2026-11-21" });
    await runDeadlines(db, orgId, at("2026-11-20"));
    expect(notified[0].to).toBe(owner);
  });
});

describe("repeating dates and presets", () => {
  it("rolls a repeating date forward when done, and closes the rest", async () => {
    const m = await addDeadline(db, orgId, { title: "GSTR-3B", dueOn: "2026-11-20", repeat: "monthly" });
    const o = await addDeadline(db, orgId, { title: "Contract ends", dueOn: "2026-11-20" });
    expect(await completeDeadline(db, orgId, m.id, at("2026-11-19"))).toBe("2026-12-20");
    expect(await completeDeadline(db, orgId, o.id)).toBeUndefined();
    expect((await listDeadlines(db, orgId)).map((d) => [d.title, d.dueOn])).toEqual([["GSTR-3B", "2026-12-20"]]);
  });

  it("adds the usual Indian filing dates once, starting from the next one", async () => {
    expect(await addIndiaPresets(db, orgId, owner, at("2026-11-25"))).toBe(9);
    expect(await addIndiaPresets(db, orgId, owner, at("2026-11-25"))).toBe(0);
    const due = Object.fromEntries((await listDeadlines(db, orgId)).map((d) => [d.preset, d.dueOn]));
    expect(due).toMatchObject({ "in-gstr1": "2026-12-11", "in-gstr3b": "2026-12-20", "in-tds-pay": "2026-12-07", "in-itr": "2027-07-31", "in-adv-tax-dec": "2026-12-15", "in-adv-tax-mar": "2027-03-15", "in-adv-tax-jun": "2027-06-15" });
  });
});
