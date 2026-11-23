import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decide } from "@/approvals/approvals";
import type { StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, connections, orgs, people, receivables } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { saveSecret } from "@/lib/secrets";
import { chaseReceivables, closeReceivable, receivablesSummary, remindNow, reminderMessage, snoozeReceivable, syncReceivables } from "./receivables";
import { updateDeskSettings } from "./settings";

const NOW = new Date("2026-11-20T06:00:00Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10);

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let owner: string;
let razorpayId: string;

const unix = (n: number) => Math.floor((NOW.getTime() + n * DAY) / 1000);
let razorpayInvoices: Record<string, unknown>[] = [];

function stubRazorpay() {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/invoices")) {
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const count = Number(url.searchParams.get("count") ?? 10);
      return Response.json({ count: razorpayInvoices.length, items: razorpayInvoices.slice(skip, skip + count) });
    }
    return Response.json({});
  });
}
const invoice = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  invoice_number: `INV-${id}`,
  status: "issued",
  amount: 5_000_000,
  amount_paid: 0,
  amount_due: 5_000_000,
  currency: "INR",
  customer_details: { name: "Sharma Traders", email: "Accounts@Sharma.example", contact: "98200 12345" },
  expire_by: unix(-10),
  short_url: `https://rzp.io/i/${id}`,
  ...over,
});

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: owner }] = await db.insert(people).values({ orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@metals.example", role: "owner" }).returning();
  const [mail] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: owner, externalAccountId: "sumedh@metals.example" }).returning();
  await saveSecret(db, orgId, "connection", mail.id, { kind: "oauth", app: "google", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 30 * DAY } satisfies StoredCredential);
  const [rz] = await db.insert(connections).values({ orgId, provider: "razorpay", scope: "org", ownerPersonId: owner, externalAccountId: "razorpay:live:abcd" }).returning();
  razorpayId = rz.id;
  await saveSecret(db, orgId, "connection", rz.id, { kind: "token", values: { keyId: "rzp_live_abcd", keySecret: "secret" } } satisfies StoredCredential);
}, 60_000);

afterAll(() => close());
beforeEach(async () => {
  await db.delete(receivables);
  await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
  razorpayInvoices = [];
});
afterEach(() => vi.unstubAllGlobals());

const row = async (externalId: string) => (await db.select().from(receivables).where(eq(receivables.externalId, externalId)))[0];
const waiting = () => db.select().from(approvals).where(eq(approvals.status, "pending"));

describe("reading what customers owe", () => {
  it("copies the apps' open invoices and notices when one is paid", async () => {
    stubRazorpay();
    razorpayInvoices = [invoice("a"), invoice("b", { customer_details: { name: "Gupta & Sons", email: "gupta@x.example" }, amount_due: 1_000_000 })];
    expect(await syncReceivables(db, orgId, NOW)).toMatchObject({ connections: 1, seen: 2, paid: 0, errors: [] });
    expect(await row("a")).toMatchObject({ customer: "Sharma Traders", email: "accounts@sharma.example", amountDue: 50000, currency: "INR", dueOn: day(-10), status: "open", number: "INV-a" });

    // The app stops listing "a": it was paid.
    razorpayInvoices = [invoice("b", { amount_due: 1_000_000 })];
    const later = new Date(NOW.getTime() + DAY);
    expect(await syncReceivables(db, orgId, later)).toMatchObject({ seen: 1, paid: 1 });
    expect(await row("a")).toMatchObject({ status: "paid", paidAt: later });
    expect(await row("b")).toMatchObject({ status: "open" });
  });

  it("doesn't call invoices paid when it can't be sure it read them all", async () => {
    stubRazorpay();
    razorpayInvoices = Array.from({ length: 400 }, (_, i) => invoice(`bulk-${i}`));
    await syncReceivables(db, orgId, NOW);
    razorpayInvoices = razorpayInvoices.slice(0, 399);
    await syncReceivables(db, orgId, new Date(NOW.getTime() + DAY));
    // 399 listed is under the cap, so the missing one is paid.
    expect((await row("bulk-399")).status).toBe("paid");
    razorpayInvoices = Array.from({ length: 400 }, (_, i) => invoice(`bulk-${i + 1}`));
    await syncReceivables(db, orgId, new Date(NOW.getTime() + 2 * DAY));
    // A full-size read may have been cut off: bulk-0 isn't listed but isn't closed either.
    expect((await row("bulk-0")).status).toBe("open");
  }, 60_000);

  it("keeps going when one app fails and says which", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    const stats = await syncReceivables(db, orgId, NOW);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toMatch(/^razorpay:/);
  }, 30_000);

  it("brings back an invoice the app lists as owed again", async () => {
    stubRazorpay();
    razorpayInvoices = [invoice("a")];
    await syncReceivables(db, orgId, NOW);
    await closeReceivable(db, orgId, (await row("a")).id, NOW);
    expect((await row("a")).status).toBe("paid");
    await syncReceivables(db, orgId, new Date(NOW.getTime() + DAY));
    expect(await row("a")).toMatchObject({ status: "open", paidAt: null });
  });
});

const add = (externalId: string, over: Partial<typeof receivables.$inferInsert> = {}) =>
  db.insert(receivables).values({ orgId, connectionId: razorpayId, externalId, number: externalId, customer: "Sharma Traders", email: "accounts@sharma.example", currency: "INR", amountDue: 25000, dueOn: day(-3), ...over }).returning();

describe("chasing", () => {
  it("proposes a reminder from the owner's mailbox and sends nothing", async () => {
    await add("a");
    const sendSpy = vi.fn(async () => Response.json({ id: "m1" }));
    vi.stubGlobal("fetch", sendSpy);
    expect(await chaseReceivables(db, orgId, NOW)).toEqual({ proposed: 1, unreachable: 0, waiting: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
    const [a] = await waiting();
    expect(a).toMatchObject({ tool: "gmail_send_email", origin: "desk", audience: "external", personId: owner });
    expect(a.summary).toContain("accounts@sharma.example");
    expect(a.body).toContain("invoice a for");
    expect(a.body).toContain("₹25,000.00");
    expect(a.body).toContain("Sumedh Kudav");
    expect(a.reason).toBe("Sharma Traders owes ₹25,000.00, 3 days overdue");
    expect(await row("a")).toMatchObject({ remindersSent: 1, lastApprovalId: a.id });
  });

  it("follows the cadence: not before it's due, weekly after, three at most", async () => {
    const [early] = await add("early", { dueOn: day(0) });
    expect((await chaseReceivables(db, orgId, NOW)).proposed).toBe(0);
    await db.delete(receivables).where(eq(receivables.id, early.id));
    await add("a");
    expect((await chaseReceivables(db, orgId, NOW)).proposed).toBe(1);
    // Waiting for an answer: no second one on top.
    expect(await chaseReceivables(db, orgId, new Date(NOW.getTime() + 8 * DAY))).toMatchObject({ proposed: 0, waiting: 1 });
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
    // Answered, but a week hasn't passed.
    expect((await chaseReceivables(db, orgId, new Date(NOW.getTime() + 3 * DAY))).proposed).toBe(0);
    expect((await chaseReceivables(db, orgId, new Date(NOW.getTime() + 8 * DAY))).proposed).toBe(1);
    const [second] = await waiting();
    expect(second.body).toContain("Following up");
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
    expect((await chaseReceivables(db, orgId, new Date(NOW.getTime() + 16 * DAY))).proposed).toBe(1);
    expect((await waiting())[0].body).toContain("final reminder");
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
    expect((await chaseReceivables(db, orgId, new Date(NOW.getTime() + 30 * DAY))).proposed).toBe(0);
  });

  it("honours the company's own rules and a snooze", async () => {
    await updateDeskSettings(db, orgId, { reminders: { firstDays: 5, everyDays: 3, max: 1 } });
    const [r] = await add("a", { dueOn: day(-3) });
    expect((await chaseReceivables(db, orgId, NOW)).proposed).toBe(0);
    await updateDeskSettings(db, orgId, { reminders: { firstDays: 1 } });
    await snoozeReceivable(db, orgId, r.id, 10, NOW);
    expect((await chaseReceivables(db, orgId, NOW)).proposed).toBe(0);
    expect((await chaseReceivables(db, orgId, new Date(NOW.getTime() + 11 * DAY))).proposed).toBe(1);
    await updateDeskSettings(db, orgId, { reminders: undefined });
  });

  it("falls back to WhatsApp for a customer with only a phone number, and says when there's no way to reach them", async () => {
    vi.stubEnv("WHATSAPP_TOKEN", "w");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123");
    await add("phone", { email: null, phone: "98200 12345" });
    await add("nobody", { email: null, phone: null, customer: "Cash buyer" });
    expect(await chaseReceivables(db, orgId, NOW)).toMatchObject({ proposed: 1, unreachable: 1 });
    const [a] = await waiting();
    expect(a).toMatchObject({ tool: "alro_whatsapp_send", audience: "external" });
    expect(a.input).toMatchObject({ to: "919820012345" });
    vi.unstubAllEnvs();
  });

  it("uses WhatsApp's approved template when one is configured", async () => {
    vi.stubEnv("WHATSAPP_TOKEN", "w");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123");
    vi.stubEnv("WHATSAPP_REMINDER_TEMPLATE", "payment_reminder");
    await add("phone", { email: null, phone: "+91 98200 12345" });
    await chaseReceivables(db, orgId, NOW);
    const [a] = await waiting();
    expect(a.input).toMatchObject({ template: { name: "payment_reminder", language: "en", params: ["Sharma Traders", "phone", "₹25,000.00", expect.stringContaining("2026")] } });
    vi.unstubAllEnvs();
  });

  it("approving a WhatsApp reminder sends it as the approver wrote it", async () => {
    vi.stubEnv("WHATSAPP_TOKEN", "w");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123");
    await add("phone", { email: null, phone: "9820012345" });
    await chaseReceivables(db, orgId, NOW);
    const [a] = await waiting();
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json({ messages: [{ id: "wamid" }] });
    });
    const { edit } = await import("@/approvals/approvals");
    await edit(db, { orgId, personId: owner }, a.id, "Hello, please pay by Friday. Thanks, Sumedh", a.revision, NOW);
    const done = await decide(db, { orgId, personId: owner }, a.id, "approve", { now: NOW });
    expect(done.status).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ to: "919820012345", type: "text", text: { body: "Hello, please pay by Friday. Thanks, Sumedh" } });
    vi.unstubAllEnvs();
  });

  it("'Remind now' ignores the cadence but not a reminder still waiting", async () => {
    const [r] = await add("a", { dueOn: day(5) });
    expect(await remindNow(db, orgId, r.id, NOW)).toBe("proposed");
    expect(await remindNow(db, orgId, r.id, NOW)).toBe("waiting");
  });

  it("reaches nobody when the owner has no mailbox and the customer has only an email", async () => {
    await db.update(connections).set({ status: "revoked" }).where(eq(connections.provider, "gmail"));
    await add("a");
    expect(await chaseReceivables(db, orgId, NOW)).toMatchObject({ proposed: 0, unreachable: 1 });
    await db.update(connections).set({ status: "active" }).where(eq(connections.provider, "gmail"));
  });
});

describe("what chasing brought in", () => {
  it("adds up what's owed and what was recovered after a reminder, per currency", async () => {
    await add("a", { amountDue: 10000 });
    await add("b", { amountDue: 5000, dueOn: day(10) });
    await add("usd", { amountDue: 300, currency: "USD", dueOn: day(-5) });
    await add("paid-after-reminder", { amountDue: 40000, status: "paid", paidAt: new Date(NOW.getTime() - 5 * DAY), remindersSent: 2 });
    await add("paid-without", { amountDue: 7000, status: "paid", paidAt: new Date(NOW.getTime() - 5 * DAY) });
    await add("paid-long-ago", { amountDue: 9000, status: "paid", paidAt: new Date(NOW.getTime() - 120 * DAY), remindersSent: 1 });
    const summary = await receivablesSummary(db, orgId, NOW);
    expect(summary.find((s) => s.currency === "INR")).toEqual({ currency: "INR", outstanding: 15000, overdue: 10000, overdueCount: 1, recovered: 40000, recoveredCount: 1 });
    expect(summary.find((s) => s.currency === "USD")).toMatchObject({ outstanding: 300, overdue: 300 });
  });
});

describe("the words", () => {
  it("gets firmer with each stage and carries the payment link", async () => {
    const [r] = await add("x", { url: "https://rzp.io/i/x" });
    const first = reminderMessage(r, 0, 3, "Sumedh");
    const last = reminderMessage(r, 2, 40, "Sumedh");
    expect(first.subject).toBe("Payment reminder: invoice x");
    expect(first.body).toContain("https://rzp.io/i/x");
    expect(first.body).toContain("quick reminder");
    expect(last.body).toContain("final reminder");
    expect(last.body).toContain("40 days overdue");
  });
});
