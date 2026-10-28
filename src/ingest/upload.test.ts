import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { messages, orgs, people, records, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { crmCsvToBatch, parseCsv } from "./parsers/crm-csv";
import { decodeWords, parseEml } from "./parsers/email";
import { mboxToBatch, splitMbox } from "./parsers/mbox";
import { uploadToBatches } from "./upload";
import { writeBatch } from "./writer";

const MULTIPART = `From: =?UTF-8?B?UHJpeWEgU2hhcm1h?= <priya@acme.com>
To: rohan@alro.ai
Subject: =?utf-8?Q?Pricing_=E2=80=94_next_steps?=
Date: Tue, 06 Oct 2026 10:00:00 +0530
Message-ID: <p1@acme.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed"

--mixed
Content-Type: multipart/alternative; boundary=alt

--alt
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

I'll send the signed order form by Friday =E2=80=94 Priya

On Mon, 5 Oct 2026 Rohan wrote:
> Any update?
--alt
Content-Type: text/html; charset=UTF-8

<p>I'll send the signed order form by Friday</p>
--alt--

--mixed
Content-Type: application/pdf; name="quote.pdf"
Content-Disposition: attachment; filename="quote.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--mixed--
`;

const HTML_ONLY = `From: Ananya Desai <ananya@alro.ai>
To: rohan@alro.ai
Subject: Re: Pricing
Date: Tue, 06 Oct 2026 12:00:00 +0530
Message-ID: <a2@alro.ai>
In-Reply-To: <p1@acme.com>
References: <p1@acme.com>
Content-Type: text/html; charset=UTF-8

<div>Thanks &amp; noted.<br>
From now on I&#39;ll own this.</div>
`;

const MBOX = `From priya@acme.com Tue Oct 06 04:30:00 2026
${MULTIPART}
From ananya@alro.ai Tue Oct 06 06:30:00 2026
${HTML_ONLY.replace("\nFrom now on", "\n>From now on")}`;

describe("email parsing", () => {
  it("decodes encoded-word headers", () => {
    expect(decodeWords("=?UTF-8?B?UHJpeWEgU2hhcm1h?= <priya@acme.com>")).toBe("Priya Sharma <priya@acme.com>");
    expect(decodeWords("=?utf-8?Q?Pricing_=E2=80=94_next_steps?=")).toBe("Pricing — next steps");
  });

  it("reads the text/plain part of a multipart email and skips attachments", () => {
    const { headers, body } = parseEml(MULTIPART);
    expect(headers.get("from")).toBe("Priya Sharma <priya@acme.com>");
    expect(body).toContain("I'll send the signed order form by Friday — Priya");
    expect(body).not.toContain("<p>");
    expect(body).not.toContain("JVBERi0");
  });

  it("falls back to HTML with tags stripped", () => {
    expect(parseEml(HTML_ONLY).body).toBe("Thanks & noted.\nFrom now on I'll own this.");
  });

  it("splits an mbox and unescapes >From lines", () => {
    const parts = splitMbox(MBOX);
    expect(parts).toHaveLength(2);
    expect(parseEml(parts[1]).body).toContain("\nFrom now on I'll own this.");

    const batch = mboxToBatch(MBOX, "rohan@alro.ai");
    expect(batch.threads).toHaveLength(1);
    expect(batch.messages.map((m) => m.text)).toEqual([
      "I'll send the signed order form by Friday — Priya",
      "Thanks & noted.\nFrom now on I'll own this.",
    ]);
    expect(batch.people.find((p) => p.email === "priya@acme.com")?.displayName).toBe("Priya Sharma");
  });
});

const DEALS_V1 = `Record ID,Deal Name,Deal Stage,Amount,Deal Owner,Last Modified Date
101,Kirana Kart pilot,Proposal,"12,000",Rohan Kulkarni,2026-10-01T10:00:00Z
102,"Finlo ""Phase 1""",Discovery,5000,Rohan Kulkarni,2026-10-01T10:00:00Z
`;
const DEALS_V2 = `Record ID,Deal Name,Deal Stage,Amount,Deal Owner,Last Modified Date
101,Kirana Kart pilot,Closed Won,"12,000",Rohan Kulkarni,2026-10-08T09:00:00Z
102,"Finlo ""Phase 1""",Discovery,5000,Rohan Kulkarni,2026-10-01T10:00:00Z
`;

describe("CRM CSV", () => {
  it("parses quoted fields", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("maps HubSpot columns to records", () => {
    const batch = crmCsvToBatch(DEALS_V1, { crm: "hubspot", type: "deal", account: "alro" });
    expect(batch.records?.map((r) => [r.externalId, r.title])).toEqual([
      ["101", "Kirana Kart pilot"],
      ["102", 'Finlo "Phase 1"'],
    ]);
    expect(batch.records?.[0].fields["Amount"]).toBe("12,000");
    expect(batch.people).toEqual([expect.objectContaining({ displayName: "Rohan Kulkarni", provider: "hubspot" })]);
  });
});

describe("uploads into the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  let orgId: string;
  let rohan: string;
  let ananya: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const [org] = await db.insert(orgs).values({ name: "ALRO" }).returning();
    orgId = org.id;
    const [r, a] = await db
      .insert(people)
      .values([
        { orgId, displayName: "Rohan Kulkarni", primaryEmail: "rohan@alro.ai", isMember: true },
        { orgId, displayName: "Ananya Desai", primaryEmail: "ananya@alro.ai", isMember: true },
      ])
      .returning();
    rohan = r.id;
    ananya = a.id;
  });
  afterAll(() => close());

  it("logs CRM changes as record_change messages, once", async () => {
    const opts = { crm: "hubspot", type: "deal", account: "alro" };
    await writeBatch(db, orgId, crmCsvToBatch(DEALS_V1, opts));
    const second = await writeBatch(db, orgId, crmCsvToBatch(DEALS_V2, opts));
    const third = await writeBatch(db, orgId, crmCsvToBatch(DEALS_V2, opts));
    expect(second.records).toEqual({ upserted: 2, changed: 1 });
    expect(third.records).toEqual({ upserted: 2, changed: 0 });

    const [deal] = await db.select().from(records).where(eq(records.externalId, "deal:101"));
    expect(deal.fields).toMatchObject({ "Deal Stage": "Closed Won" });
    expect(deal.ownerPersonId).toBe(rohan);
    expect(deal.acl).toEqual(["org"]);

    const timeline = await db
      .select({ text: messages.text, kind: messages.kind, acl: messages.acl })
      .from(messages)
      .where(eq(messages.threadId, deal.threadId!))
      .orderBy(messages.sentAt);
    expect(timeline.map((m) => m.text)).toEqual([
      expect.stringMatching(/^Deal "Kirana Kart pilot" created\./),
      'Deal "Kirana Kart pilot" updated.\nDeal Stage: Proposal → Closed Won\nLast Modified Date: 2026-10-01T10:00:00Z → 2026-10-08T09:00:00Z',
    ]);
    expect(timeline.every((m) => m.kind === "record_change" && m.acl[0] === "org")).toBe(true);
  });

  it("keeps an uploaded WhatsApp chat visible to the uploader even under another name", async () => {
    const chat = "06/10/2026, 10:00 - Ro: kal tak deck bhej dunga\n06/10/2026, 10:05 - Ananya Desai: ok\n";
    const [batch] = uploadToBatches([{ name: "WhatsApp Chat with Ananya Desai.txt", bytes: new TextEncoder().encode(chat) }], {
      uploader: { email: "rohan@alro.ai", displayName: "Rohan Kulkarni" },
      utcOffset: "+05:30",
    });
    await writeBatch(db, orgId, batch, "upload", rohan);

    const [thread] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.orgId, orgId), eq(threads.kind, "whatsapp")));
    expect(thread.title).toBe("Ananya Desai");
    const seen = (personId: string) =>
      withScope(db, { orgId, personId }, (tx) => tx.select({ text: messages.text }).from(messages).where(eq(messages.threadId, thread.id)));
    expect(await seen(rohan)).toHaveLength(2);
    expect(await seen(ananya)).toHaveLength(2);
  });

  it("rejects unknown file types and CSVs without CRM details", () => {
    const opts = { uploader: { email: "rohan@alro.ai", displayName: "Rohan Kulkarni" } };
    expect(() => uploadToBatches([{ name: "notes.docx", bytes: new Uint8Array() }], opts)).toThrow(/unsupported file type/);
    expect(() => uploadToBatches([{ name: "deals.csv", bytes: new TextEncoder().encode(DEALS_V1) }], opts)).toThrow(/CRM name/);
  });
});
