import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decide } from "@/approvals/approvals";
import type { StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, connections, orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { saveSecret } from "@/lib/secrets";
import { createDocument, documentByToken, financialYear, invoiceFromQuote, proposeSend, renderPdf, setDocumentStatus, syncDocumentStatuses, totals } from "./documents";
import { updateDeskSettings } from "./settings";

const NOW = new Date("2026-11-20T06:00:00Z");
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let owner: string;

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: owner }] = await db.insert(people).values({ orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "s@metals.example", role: "owner" }).returning();
  const [mail] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: owner, externalAccountId: "s@metals.example" }).returning();
  await saveSecret(db, orgId, "connection", mail.id, { kind: "oauth", app: "google", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 30 * 86_400_000 } satisfies StoredCredential);
  await updateDeskSettings(db, orgId, { documents: { taxId: "27ABCDE1234F1Z5", address: "Shop 4, Steel Market, Mumbai", terms: "Payment within 15 days. Goods once sold are not returnable." } });
}, 60_000);
afterAll(() => close());

const lines = [
  { description: "MS pipe 2 inch, 6 m", quantity: 100, unitPrice: 612.5, taxRate: 18 },
  { description: "Cutting & handling – café rate ₹", quantity: 1, unitPrice: 1500, taxRate: 0 },
];
const input = { kind: "invoice" as const, customerName: "Sharma Traders", customerEmail: "Accounts@Sharma.example", customerPhone: "98200 12345", items: lines };

describe("amounts", () => {
  it("adds up lines and tax to the paisa", () => {
    expect(totals(lines)).toEqual({ subtotal: 62750, tax: 11025, total: 73775 });
    expect(totals([{ description: "x", quantity: 3, unitPrice: 0.1, taxRate: 18 }])).toEqual({ subtotal: 0.3, tax: 0.05, total: 0.35 });
  });
  it("knows the Indian financial year", () => {
    expect([financialYear("2026-03-31"), financialYear("2026-04-01"), financialYear("2026-11-20")]).toEqual(["2025-26", "2026-27", "2026-27"]);
  });
});

describe("creating", () => {
  it("numbers per kind and financial year, and starts again in April", async () => {
    const a = await createDocument(db, orgId, owner, input, NOW);
    const b = await createDocument(db, orgId, owner, input, NOW);
    const q = await createDocument(db, orgId, owner, { ...input, kind: "quote" }, NOW);
    const next = await createDocument(db, orgId, owner, { ...input, issuedOn: "2027-04-02" }, NOW);
    expect([a.number, b.number, q.number, next.number]).toEqual(["INV-2026-27-0001", "INV-2026-27-0002", "QUO-2026-27-0001", "INV-2027-28-0001"]);
    expect(a).toMatchObject({ subtotal: 62750, tax: 11025, total: 73775, customerEmail: "accounts@sharma.example", dueOn: "2026-12-05", status: "draft" });
    expect(q.dueOn).toBeNull();
  });

  it("uses the company's own prefix", async () => {
    await updateDeskSettings(db, orgId, { documents: { invoicePrefix: "MC", taxId: "27ABCDE1234F1Z5" } });
    expect((await createDocument(db, orgId, owner, { ...input, issuedOn: "2028-05-01" }, NOW)).number).toBe("MC-2028-29-0001");
  });

  it("makes two at once without clashing", async () => {
    const both = await Promise.all([createDocument(db, orgId, owner, { ...input, issuedOn: "2029-05-01" }, NOW), createDocument(db, orgId, owner, { ...input, issuedOn: "2029-05-01" }, NOW)]);
    expect(new Set(both.map((d) => d.number)).size).toBe(2);
  });

  it("refuses lines that can't be right", async () => {
    for (const bad of [[], [{ description: "", quantity: 1, unitPrice: 1, taxRate: 0 }], [{ description: "x", quantity: 0, unitPrice: 1, taxRate: 0 }], [{ description: "x", quantity: 1, unitPrice: -5, taxRate: 0 }], [{ description: "x", quantity: 1, unitPrice: 1, taxRate: 250 }], [{ description: "x", quantity: NaN, unitPrice: 1, taxRate: 0 }]]) {
      await expect(createDocument(db, orgId, owner, { ...input, items: bad }, NOW)).rejects.toThrow();
    }
    await expect(createDocument(db, orgId, owner, { ...input, customerName: " " }, NOW)).rejects.toThrow(/Who/);
  });

  it("turns an accepted quote into one invoice, once", async () => {
    const q = await createDocument(db, orgId, owner, { ...input, kind: "quote", issuedOn: "2030-05-01" }, NOW);
    const inv = await invoiceFromQuote(db, orgId, owner, q.id, NOW);
    expect(inv).toMatchObject({ kind: "invoice", fromDocumentId: q.id, total: q.total });
    expect((await invoiceFromQuote(db, orgId, owner, q.id, NOW)).id).toBe(inv.id);
    await expect(invoiceFromQuote(db, orgId, owner, inv.id, NOW)).rejects.toThrow(/not found/i);
  });
});

describe("the PDF", () => {
  it("is a real document with the company's details, even for characters the font lacks", async () => {
    const doc = await createDocument(db, orgId, owner, { ...input, issuedOn: "2031-05-01", notes: "Deliver to Pune godown." }, NOW);
    const bytes = await renderPdf(db, doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("flows onto more pages for a long document", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i} with a rather long description that needs wrapping across more than one line in the table`, quantity: 1 + i, unitPrice: 10, taxRate: 18 }));
    const doc = await createDocument(db, orgId, owner, { ...input, items: many, issuedOn: "2032-05-01" }, NOW);
    expect((await PDFDocument.load(await renderPdf(db, doc))).getPageCount()).toBeGreaterThan(1);
  });
});

describe("sending", () => {
  it("proposes the link to the customer, sends nothing, and is marked sent only after approval", async () => {
    const doc = await createDocument(db, orgId, owner, { ...input, issuedOn: "2033-05-01" }, NOW);
    const sent = await proposeSend(db, orgId, doc.id, NOW);
    expect(sent).toMatchObject({ ok: true, via: "email" });
    const [a] = await db.select().from(approvals).where(eq(approvals.id, (sent as { approvalId: string }).approvalId));
    expect(a.body).toContain(`/api/docs/${doc.shareToken}`);
    expect(a.summary).toContain("accounts@sharma.example");
    expect(await syncDocumentStatuses(db, orgId, NOW)).toBe(0);
    vi.stubGlobal("fetch", async () => Response.json({ id: "m" }));
    await decide(db, { orgId, personId: owner }, a.id, "approve", { now: NOW });
    vi.unstubAllGlobals();
    expect(await syncDocumentStatuses(db, orgId, NOW)).toBeGreaterThanOrEqual(1);
    expect((await documentByToken(db, doc.shareToken))!.status).toBe("sent");
    await setDocumentStatus(db, orgId, doc.id, "paid", NOW);
    expect((await documentByToken(db, doc.shareToken))!.status).toBe("paid");
  });
});
