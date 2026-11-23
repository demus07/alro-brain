import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decide } from "@/approvals/approvals";
import type { StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, connections, leads, orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { saveSecret } from "@/lib/secrets";
import { createLead, leadSummary, leadToken, leadTokenMatches, noteCustomerReply, runLeads, setLeadStatus } from "./leads";

const T0 = new Date("2026-11-20T05:00:00Z");
const DAY = 86_400_000;
const at = (n: number, mins = 0) => new Date(T0.getTime() + n * DAY + mins * 60_000);

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let owner: string;

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: owner }] = await db.insert(people).values({ orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "s@metals.example", role: "owner" }).returning();
  const [mail] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: owner, externalAccountId: "s@metals.example" }).returning();
  await saveSecret(db, orgId, "connection", mail.id, { kind: "oauth", app: "google", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 30 * DAY } satisfies StoredCredential);
}, 60_000);
afterAll(() => close());
beforeEach(async () => {
  await db.delete(leads);
  await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
});

const enquiry = { source: "web", name: "Anita Rao", email: "Anita@Rao.example", phone: "98200 12345", message: "Need 2 tonnes of MS pipe, price?" };
const pending = () => db.select().from(approvals).where(eq(approvals.status, "pending"));

describe("a new enquiry", () => {
  it("becomes a lead with a reply waiting for approval, and sends nothing", async () => {
    const lead = (await createLead(db, orgId, enquiry, T0))!;
    expect(lead).toMatchObject({ status: "new", email: "anita@rao.example", phone: "919820012345", ownerPersonId: owner });
    const [a] = await pending();
    expect(a).toMatchObject({ tool: "gmail_send_email", origin: "desk" });
    expect(a.body).toContain("Hello Anita,");
    expect(a.reason).toContain("Need 2 tonnes");
    expect((await db.select().from(leads))[0].lastApprovalId).toBe(a.id);
  });

  it("treats a redelivered enquiry as the same one", async () => {
    expect(await createLead(db, orgId, { ...enquiry, externalId: "q-1" }, T0)).toBeDefined();
    expect(await createLead(db, orgId, { ...enquiry, externalId: "q-1" }, T0)).toBeUndefined();
    expect(await db.select().from(leads)).toHaveLength(1);
    expect(await pending()).toHaveLength(1);
  });

  it("keeps the lead and explains when there's no way to reply", async () => {
    await db.update(connections).set({ status: "revoked" }).where(eq(connections.provider, "gmail"));
    const lead = (await createLead(db, orgId, enquiry, T0))!;
    expect(await pending()).toHaveLength(0);
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].note).toMatch(/Gmail or Outlook/);
    await db.update(connections).set({ status: "active" }).where(eq(connections.provider, "gmail"));
  });

  it("rejects an empty message and strips control characters", async () => {
    await expect(createLead(db, orgId, { source: "web", message: "  " }, T0)).rejects.toThrow(/message/);
    const lead = (await createLead(db, orgId, { ...enquiry, name: "Anita\u0000\nRao" }, T0))!;
    expect(lead.name).toBe("Anita  Rao");
  });
});

describe("following up", () => {
  async function sentFirstReply() {
    const lead = (await createLead(db, orgId, enquiry, T0))!;
    const [a] = await pending();
    vi.stubGlobal("fetch", async () => Response.json({ id: "m1" }));
    await decide(db, { orgId, personId: owner }, a.id, "approve", { now: at(0, 10) });
    vi.unstubAllGlobals();
    return lead;
  }

  it("starts the clock when the reply goes out, then follows up at 2, 5 and 10 days, then lets go", async () => {
    const lead = await sentFirstReply();
    expect(await runLeads(db, orgId, at(0, 20))).toEqual({ replied: 1, followUps: 0, cold: 0 });
    const row = () => db.select().from(leads).where(eq(leads.id, lead.id)).then((r) => r[0]);
    expect(await row()).toMatchObject({ status: "replied", firstRepliedAt: at(0, 20), nextFollowUpAt: at(2, 20) });

    expect((await runLeads(db, orgId, at(1))).followUps).toBe(0);
    expect((await runLeads(db, orgId, at(2, 30))).followUps).toBe(1);
    // Counted from the first reply: the second is due on day 5, not 5 days after the first follow-up.
    expect(await row()).toMatchObject({ status: "following", followUpsSent: 1, nextFollowUpAt: at(5, 20) });
    // The follow-up is still waiting: nothing more is proposed.
    expect((await runLeads(db, orgId, at(6))).followUps).toBe(0);
    await db.update(approvals).set({ status: "done" }).where(eq(approvals.status, "pending"));
    expect((await runLeads(db, orgId, at(6))).followUps).toBe(1);
    await db.update(approvals).set({ status: "done" }).where(eq(approvals.status, "pending"));
    expect((await runLeads(db, orgId, at(11))).followUps).toBe(1);
    expect((await row()).followUpsSent).toBe(3);
    await db.update(approvals).set({ status: "done" }).where(eq(approvals.status, "pending"));
    expect((await runLeads(db, orgId, at(16))).cold).toBe(1);
    expect(await row()).toMatchObject({ status: "lost", note: "No reply after the follow-ups" });
  });

  it("stops when the customer writes back, matching by email or phone", async () => {
    const lead = await sentFirstReply();
    await runLeads(db, orgId, at(0, 20));
    expect(await noteCustomerReply(db, orgId, { email: "nobody@else.example" }, at(1))).toBe(0);
    expect(await noteCustomerReply(db, orgId, { phone: "+91 98200 12345" }, at(1))).toBe(1);
    expect((await runLeads(db, orgId, at(3))).followUps).toBe(0);
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0]).toMatchObject({ customerRepliedAt: at(1), nextFollowUpAt: null });
  });

  it("measures how fast replies go out and how leads end", async () => {
    const lead = await sentFirstReply();
    await runLeads(db, orgId, at(0, 20));
    await setLeadStatus(db, orgId, lead.id, "won", at(3));
    expect(await leadSummary(db, orgId)).toEqual({ open: 0, won: 1, lost: 0, medianReplyMinutes: 20 });
  });
});

describe("the intake address", () => {
  it("belongs to one company", () => {
    const token = leadToken(orgId);
    expect(leadTokenMatches(orgId, token)).toBe(true);
    expect(leadTokenMatches("11111111-1111-1111-1111-111111111111", token)).toBe(false);
    expect(leadTokenMatches(orgId, "nope")).toBe(false);
  });
});
