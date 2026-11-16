import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import {
  auditLog,
  channelLinks,
  chunks,
  commitmentEvents,
  commitments,
  connections,
  edges,
  entities,
  entityMentions,
  insights,
  messages,
  notifications,
  orgs,
  people,
  procedures,
  routines,
  threadMembers,
  threads,
  trackerRows,
  trackers,
} from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { buildBrief, renderBrief } from "@/notify/brief";
import { TRACKER_PRESETS } from "@/work/trackers";
import { refreshInsights, workingDaysBetween } from "./compute";
import { notifyInsights } from "./notify";
import { loadSubject } from "./profile";
import { dismissInsight, visibleInsights } from "./read";
import { companyState, departmentState } from "./state";
import { insightTools } from "./tools";

/** Monday 16 Nov 2026, 11:30 in Kolkata. */
const NOW = new Date("2026-11-16T06:00:00Z");
const TZ = "Asia/Kolkata";
const day = (iso: string) => new Date(`${iso}T06:00:00Z`);
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(() => close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A fresh company: three members (Olu is in no conversation), and two outside people. */
async function company(name: string) {
  const [{ id: orgId }] = await db.insert(orgs).values({ name, timezone: TZ }).returning();
  const [sumedh, jash, olu, priya, ravi] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, department: "sales" },
      { orgId, displayName: "Jash Doshi", isMember: true, department: "operations" },
      { orgId, displayName: "Olu Outsider", isMember: true },
      { orgId, displayName: "Priya Nair", isMember: false, primaryEmail: "priya@acme.com" },
      { orgId, displayName: "Ravi Mills", isMember: false },
    ])
    .returning({ id: people.id });
  const [{ id: connectionId }] = await db.insert(connections).values({ orgId, provider: "upload:whatsapp", scope: "personal", ownerPersonId: sumedh.id }).returning();
  let n = 0;
  const c = {
    orgId,
    sumedh: sumedh.id,
    jash: jash.id,
    olu: olu.id,
    priya: priya.id,
    ravi: ravi.id,
    viewer: (personId: string) => ({ orgId, personId }),
    /** A private conversation between these people. */
    async thread(title: string, members: string[]) {
      const [t] = await db.insert(threads).values({ orgId, connectionId, kind: "whatsapp", externalId: `t${n++}`, title, visibility: "members" }).returning();
      await db.insert(threadMembers).values(members.map((personId) => ({ orgId, threadId: t.id, personId })));
      return t.id;
    },
    async say(threadId: string, authorPersonId: string, text: string, sentAt: Date) {
      const [m] = await db.insert(messages).values({ orgId, threadId, connectionId, externalId: `m${n++}`, kind: "chat", authorPersonId, sentAt, text }).returning();
      return m;
    },
    async promise(p: { title: string; owner: string; to?: string; entity?: string; status: "open" | "overdue"; dueAt?: Date; in: string }) {
      const m = await c.say(p.in, p.owner, `I'll ${p.title}`, day("2026-11-02"));
      const [row] = await db
        .insert(commitments)
        .values({
          orgId,
          title: p.title,
          ownerPersonId: p.owner,
          counterpartyPersonId: p.to,
          relatedEntityId: p.entity,
          status: p.status,
          dueAt: p.dueAt ?? (p.status === "overdue" ? day("2026-11-10") : day("2026-11-25")),
          quote: m.text,
          confidence: 0.9,
          sourceMessageId: m.id,
          acl: [...m.acl, `p:${p.owner}`],
        })
        .returning();
      return row;
    },
    async entity(name: string, type: "company" | "deal", threadId: string) {
      const [e] = await db.insert(entities).values({ orgId, type, name, acl: [`t:${threadId}`] }).returning();
      return e.id;
    },
    /** A conversation window in `threadId` on each date that mentions the entity. */
    async mention(entityId: string, threadId: string, dates: string[]) {
      for (const date of dates) {
        const m = await c.say(threadId, c.priya, "About the order", day(date));
        const [chunk] = await db.insert(chunks).values({ orgId, threadId, messageIds: [m.id], startAt: m.sentAt, endAt: m.sentAt, text: m.text }).returning();
        await db.insert(entityMentions).values({ orgId, entityId, chunkId: chunk.id });
      }
    },
    of: (kind: string) => db.select().from(insights).where(and(eq(insights.orgId, orgId), eq(insights.kind, kind))),
  };
  return c;
}

describe("working days", () => {
  it("skips the weekend", () => {
    expect(workingDaysBetween(new Date("2026-11-13T10:00:00Z"), NOW, TZ)).toBe(1); // Friday → Monday
    expect(workingDaysBetween(new Date("2026-11-10T10:00:00Z"), NOW, TZ)).toBe(4); // Tuesday → Monday
    expect(workingDaysBetween(NOW, NOW, TZ)).toBe(0);
  });
});

describe("waiting on us", () => {
  let c: Awaited<ReturnType<typeof company>>;
  let waiting: string;
  let ask: string;

  beforeAll(async () => {
    c = await company("Waiting Co");
    waiting = await c.thread("Priya Nair", [c.sumedh]);
    await c.say(waiting, c.sumedh, "Will check with the mill", day("2026-11-09"));
    ask = (await c.say(waiting, c.priya, "Can you send the mill certificate for the last lot?", day("2026-11-10"))).id;
    // Near-misses: asked only one working day ago; nothing asked; already answered.
    const fresh = await c.thread("Ravi Mills", [c.sumedh]);
    await c.say(fresh, c.ravi, "Could you confirm the rate?", day("2026-11-13"));
    const thanks = await c.thread("Thanks", [c.jash]);
    await c.say(thanks, c.ravi, "Thanks, received the payment.", day("2026-11-05"));
    const answered = await c.thread("Answered", [c.jash]);
    await c.say(answered, c.priya, "When will the truck leave?", day("2026-11-05"));
    await c.say(answered, c.jash, "It left this morning.", day("2026-11-06"));
    for (const [personId, chat] of [[c.sumedh, "sumedh-chat"], [c.jash, "jash-chat"], [c.olu, "olu-chat"]]) {
      await db.insert(channelLinks).values({ orgId: c.orgId, personId, channel: "telegram", externalUserId: chat });
    }
  });

  it("fires only for the question nobody answered for two working days", async () => {
    expect(await refreshInsights(db, c.orgId, NOW)).toMatchObject({ open: 1, opened: 1, resolved: 0 });
    const [row, ...rest] = await c.of("waiting_on_us");
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      key: `waiting_on_us:${waiting}`,
      title: "Priya Nair has waited 4 working days for a reply",
      severity: 3,
      status: "new",
      subjectPersonId: c.priya,
      department: "sales",
      evidenceMessageIds: [ask],
      acl: [`t:${waiting}`],
    });
    expect(row.detail).toContain("mill certificate");
    expect(row.suggestion).toContain("Draft a reply to Priya Nair");
  });

  it("is invisible to people outside the conversation, everywhere it is shown", async () => {
    expect((await visibleInsights(db, c.viewer(c.sumedh))).map((i) => i.kind)).toEqual(["waiting_on_us"]);
    for (const other of [c.jash, c.olu]) {
      expect(await visibleInsights(db, c.viewer(other))).toEqual([]);
      expect((await buildBrief(db, c.viewer(other), TZ, NOW)).attention).toEqual([]);
      expect((await companyState(db, c.viewer(other), TZ, NOW)).tiles.waitingOnUs).toBe(0);
    }
    const brief = await buildBrief(db, c.viewer(c.sumedh), TZ, NOW);
    expect(brief.attention.map((i) => i.title)).toEqual(["Priya Nair has waited 4 working days for a reply"]);
    const mail = renderBrief(brief, "Sumedh Kudav", "https://alro.test");
    expect(mail.subject).toBe("Your ALRO brief: 1 to act on today");
    expect(mail.text).toContain("Needs attention\n- Priya Nair has waited");
    expect(mail.html).toContain('href="https://alro.test/?ask=Draft%20a%20reply%20to%20Priya%20Nair');
    const state = await companyState(db, c.viewer(c.sumedh), TZ, NOW);
    expect(state.tiles.waitingOnUs).toBe(1);
    expect(state.attention).toHaveLength(1);
    expect((await departmentState(db, c.viewer(c.sumedh), "sales"))?.attention).toHaveLength(1);
    expect((await departmentState(db, c.viewer(c.jash), "sales"))?.attention).toEqual([]);
  });

  it("answers the agent from insights, citing the evidence only to those who can see it", async () => {
    const run = (personId: string) =>
      (insightTools(db, c.viewer(personId), TZ).listInsights as unknown as { execute: (i: unknown, o: unknown) => Promise<{ insights: { title: string; urgency: string; sources: { ref: string; messageId: string; author: string }[] }[] }> }).execute({}, { toolCallId: "t", messages: [] });
    const mine = await run(c.sumedh);
    expect(mine.insights).toHaveLength(1);
    expect(mine.insights[0]).toMatchObject({ urgency: "act today", sources: [{ ref: "S501", messageId: ask, author: "Priya Nair" }] });
    expect((await run(c.olu)).insights).toEqual([]);
  });

  it("tells the member in the conversation once, and nobody who can't see it", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "t");
    const sent: { chat_id: string; text: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    });
    expect(await notifyInsights(db, c.orgId, NOW)).toEqual({ people: 1, insights: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe("sumedh-chat");
    expect(sent[0].text).toContain("Priya Nair has waited 4 working days");
    // Run again, and after a recompute (which updates the row rather than adding one): nothing more goes out.
    await refreshInsights(db, c.orgId, later(1));
    expect(await c.of("waiting_on_us")).toHaveLength(1);
    expect(await notifyInsights(db, c.orgId, later(1))).toEqual({ people: 0, insights: 0 });
    expect(sent).toHaveLength(1);
    const told = await db.select().from(notifications).where(and(eq(notifications.orgId, c.orgId), like(notifications.kind, "insight:%")));
    expect(told.map((t) => [t.personId, t.channel])).toEqual([[c.sumedh, "telegram"]]);
  });

  it("stays dismissed across recomputation until it changes materially, and the dismissal is audited", async () => {
    const [row] = await c.of("waiting_on_us");
    // Someone who can't see it can't dismiss it.
    expect(await dismissInsight(db, c.viewer(c.olu), row.id)).toBe(false);
    expect(await dismissInsight(db, c.viewer(c.sumedh), row.id)).toBe(true);
    const [logged] = await db.select().from(auditLog).where(and(eq(auditLog.orgId, c.orgId), eq(auditLog.action, "insight.dismiss")));
    expect(logged).toMatchObject({ personId: c.sumedh, target: row.id });

    expect(await refreshInsights(db, c.orgId, later(2))).toMatchObject({ open: 0, opened: 0 });
    expect((await c.of("waiting_on_us"))[0]).toMatchObject({ status: "dismissed", dismissedBy: c.sumedh });
    expect(await visibleInsights(db, c.viewer(c.sumedh))).toEqual([]);

    // She writes again: that is new, so it comes back.
    const nudge = await c.say(waiting, c.priya, "Any update on the certificate?", later(3));
    expect(await refreshInsights(db, c.orgId, later(4))).toMatchObject({ open: 1, opened: 1 });
    expect((await c.of("waiting_on_us"))[0]).toMatchObject({ status: "new", dismissedBy: null, evidenceMessageIds: [nudge.id, ask] });
  });

  it("resolves once someone replies", async () => {
    await c.say(waiting, c.sumedh, "Sent it just now, sorry for the wait.", later(5));
    expect(await refreshInsights(db, c.orgId, later(6))).toMatchObject({ open: 0, resolved: 1 });
    expect((await c.of("waiting_on_us"))[0].status).toBe("resolved");
    expect(await visibleInsights(db, c.viewer(c.sumedh))).toEqual([]);
  });
});

describe("gone quiet", () => {
  it("fires for a once-active client with something open, and not for its near-misses", async () => {
    const c = await company("Quiet Co");
    const t = await c.thread("Orders", [c.sumedh, c.jash]);
    const weekly = ["2026-10-05", "2026-10-13", "2026-10-20", "2026-10-27"];
    const acme = await c.entity("Acme Steel", "company", t);
    await c.mention(acme, t, weekly);
    await c.promise({ title: "send the revised quote", owner: c.sumedh, entity: acme, status: "open", in: t });
    // Nothing open with them.
    const idle = await c.entity("Beta Traders", "company", t);
    await c.mention(idle, t, weekly);
    // Still in touch last week.
    const recent = await c.entity("Gamma Infra", "company", t);
    await c.mention(recent, t, [...weekly, "2026-11-10"]);
    await c.promise({ title: "share the test report", owner: c.sumedh, entity: recent, status: "open", in: t });
    // Was never a weekly conversation.
    const oneOff = await c.entity("Delta Works", "company", t);
    await c.mention(oneOff, t, ["2026-10-27"]);
    await c.promise({ title: "call them back", owner: c.sumedh, entity: oneOff, status: "open", in: t });

    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("gone_quiet");
    expect(rows.map((r) => r.key)).toEqual([`gone_quiet:${acme}`]);
    expect(rows[0]).toMatchObject({ title: "Acme Steel has gone quiet", subjectEntityId: acme, severity: 2, department: "sales", acl: [`p:${c.sumedh}`, `t:${t}`] });
    expect(rows[0].detail).toContain("No contact since 27 Oct (20 days)");
    expect(rows[0].detail).toContain("1 promise to do with them is still open");

    // The profile is there for someone in the conversation and not for someone outside it.
    const profile = await loadSubject(db, c.viewer(c.sumedh), acme, NOW);
    expect(profile).toMatchObject({ name: "Acme Steel", type: "company" });
    expect(profile?.attention.map((i) => i.kind)).toEqual(["gone_quiet"]);
    expect(profile?.owedToThem.map((p) => p.title)).toEqual(["send the revised quote"]);
    expect(profile?.conversations.map((x) => x.title)).toEqual(["Orders"]);
    expect(await loadSubject(db, c.viewer(c.olu), acme, NOW)).toBeUndefined();
  });
});

describe("promises", () => {
  it("flags a client with several overdue promises or one that keeps slipping, not one late promise", async () => {
    const c = await company("Risk Co");
    const t = await c.thread("Clients", [c.sumedh, c.jash]);
    const acme = await c.entity("Acme Steel", "company", t);
    const first = await c.promise({ title: "send the mill certificate", owner: c.sumedh, entity: acme, status: "overdue", dueAt: day("2026-11-05"), in: t });
    const second = await c.promise({ title: "confirm the delivery date", owner: c.jash, entity: acme, status: "overdue", in: t });
    const single = await c.entity("Beta Traders", "company", t);
    await c.promise({ title: "send the invoice", owner: c.sumedh, entity: single, status: "overdue", in: t });
    // Missed, moved, missed again: now open with a new date.
    const slipping = await c.entity("Gamma Infra", "deal", t);
    const moved = await c.promise({ title: "share the drawings", owner: c.sumedh, entity: slipping, status: "open", in: t });
    await db.insert(commitmentEvents).values([1, 2].map(() => ({ orgId: c.orgId, commitmentId: moved.id, type: "status_changed" as const, fromStatus: "due_soon" as const, toStatus: "overdue" as const, actor: "watcher" })));

    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("at_risk");
    expect(rows.map((r) => r.key).sort()).toEqual([`at_risk:e:${acme}`, `at_risk:e:${slipping}`].sort());
    const risk = rows.find((r) => r.subjectEntityId === acme)!;
    expect(risk).toMatchObject({ title: "Acme Steel is at risk: 2 promises to them are overdue", severity: 2, department: null });
    expect(risk.detail).toBe("2 promises overdue, the oldest since 5 Nov. Owned by Sumedh (1), Jash (1).");
    expect(new Set(risk.evidenceMessageIds)).toEqual(new Set([first.sourceMessageId, second.sourceMessageId]));
    expect(risk.acl).toEqual([`p:${c.jash}`, `p:${c.sumedh}`, `t:${t}`].sort());
    expect(rows.find((r) => r.subjectEntityId === slipping)).toMatchObject({ title: "Promises to Gamma Infra keep slipping", severity: 2 });
    // Visible to the people in that conversation only.
    expect((await visibleInsights(db, c.viewer(c.jash), { kinds: ["at_risk"] })).length).toBe(2);
    expect(await visibleInsights(db, c.viewer(c.olu))).toEqual([]);
  });

  it("flags the member carrying far more than the others, and nobody when the load is even", async () => {
    const c = await company("Busy Co");
    const t = await c.thread("Work", [c.sumedh, c.jash]);
    for (let i = 0; i < 6; i++) await c.promise({ title: `do thing ${i}`, owner: c.sumedh, status: i < 2 ? "overdue" : "open", in: t });
    // Near-miss: plenty overdue, but not many open.
    for (let i = 0; i < 5; i++) await c.promise({ title: `do other thing ${i}`, owner: c.jash, status: i < 3 ? "overdue" : "open", in: t });
    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("overloaded");
    expect(rows.map((r) => r.subjectPersonId)).toEqual([c.sumedh]);
    expect(rows[0]).toMatchObject({ title: "Sumedh Kudav is carrying 6 open promises, 2 overdue", severity: 2, department: "sales" });
    expect(rows[0].detail).toContain("Everyone else averages 4.0 open");

    // The same load, but everyone has it.
    const even = await company("Even Co");
    await db.update(people).set({ deactivatedAt: NOW }).where(eq(people.id, even.olu));
    const shared = await even.thread("Work", [even.sumedh, even.jash]);
    for (const owner of [even.sumedh, even.jash]) {
      for (let i = 0; i < 6; i++) await even.promise({ title: `do thing ${i}`, owner, status: i < 2 ? "overdue" : "open", in: shared });
    }
    await refreshInsights(db, even.orgId, NOW);
    expect(await even.of("overloaded")).toEqual([]);
  });

  it("flags outside people who are late on what they promised us, not ones still on time", async () => {
    const c = await company("Vendor Co");
    const t = await c.thread("Mill", [c.sumedh]);
    const late = await c.promise({ title: "send the test certificates", owner: c.ravi, to: c.sumedh, status: "overdue", dueAt: day("2026-11-12"), in: t });
    await c.promise({ title: "confirm the PO", owner: c.priya, to: c.sumedh, status: "open", in: t });
    await c.promise({ title: "pay the mill", owner: c.sumedh, to: c.ravi, status: "overdue", in: t });
    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("slipping_owner");
    expect(rows.map((r) => r.key)).toEqual([`slipping_owner:${c.ravi}`]);
    expect(rows[0]).toMatchObject({ title: "Ravi Mills is late on something they promised us", severity: 2, subjectPersonId: c.ravi, evidenceMessageIds: [late.sourceMessageId] });
    expect(rows[0].detail).toContain("12 Nov (4 days ago)");
  });
});

describe("facts, payments and procedures", () => {
  it("flags current facts that contradict each other, not a dispute already settled", async () => {
    const c = await company("Facts Co");
    const t = await c.thread("Deals", [c.sumedh]);
    const other = await c.thread("Finance", [c.jash]);
    const acme = await c.entity("Acme Steel", "company", t);
    const budget = await c.entity("Budget", "deal", t);
    const a = await c.say(t, c.priya, "Our budget is 40 lakh", day("2026-11-03"));
    const b = await c.say(other, c.jash, "Acme told me the budget is 25 lakh", day("2026-11-04"));
    const fact = (m: typeof a, text: string, disputeGroup: string, expiredAt?: Date) => ({ orgId: c.orgId, sourceEntityId: acme, targetEntityId: budget, relation: "has_budget", fact: text, sourceMessageIds: [m.id], acl: m.acl, disputeGroup, expiredAt });
    const open = "11111111-1111-4111-8111-111111111111";
    const settled = "22222222-2222-4222-8222-222222222222";
    await db.insert(edges).values([fact(a, "Acme's budget is 40 lakh", open), fact(b, "Acme's budget is 25 lakh", open), fact(a, "Acme pays in 30 days", settled), fact(b, "Acme pays in 60 days", settled, NOW)]);

    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("disputed_fact");
    expect(rows.map((r) => r.key)).toEqual([`disputed_fact:${open}`]);
    expect(rows[0]).toMatchObject({ title: "Sources disagree about Acme Steel (has budget)", subjectEntityId: acme, acl: [`t:${other}`, `t:${t}`].sort() });
    // Each side may see only one of the facts, so neither is quoted.
    expect(rows[0].detail).not.toContain("lakh");
  });

  it("flags receivables past due from a tracker, for its owner only", async () => {
    const c = await company("Cash Co");
    const preset = TRACKER_PRESETS.find((p) => p.name === "Receivables")!;
    const [tracker] = await db.insert(trackers).values({ orgId: c.orgId, personId: c.sumedh, ...preset }).returning();
    const row = (values: Record<string, string | number>, at: string) => ({ orgId: c.orgId, trackerId: tracker.id, personId: c.sumedh, values, at: day(at) });
    await db.insert(trackerRows).values([
      row({ Customer: "Acme Steel", Invoice: "INV-1", Amount: 12000, Due: "2026-10-20", Status: "raised" }, "2026-10-01"),
      // Raised and since paid.
      row({ Customer: "Beta Traders", Invoice: "INV-2", Amount: 8000, Due: "2026-10-01", Status: "raised" }, "2026-09-20"),
      row({ Customer: "Beta Traders", Invoice: "INV-2", Amount: 8000, Status: "paid" }, "2026-10-05"),
      // Not due yet.
      row({ Customer: "Gamma Infra", Invoice: "INV-3", Amount: 5000, Due: "2026-12-01", Status: "raised" }, "2026-11-01"),
    ]);
    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("receivable_late");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "1 payment past due, 12,000 in all", severity: 2, department: "finance", acl: [`p:${c.sumedh}`] });
    expect(rows[0].detail).toContain("Acme Steel INV-1, 12,000, due 20 Oct (27 days late)");
    expect((await visibleInsights(db, c.viewer(c.sumedh))).map((i) => i.kind)).toEqual(["receivable_late"]);
    expect(await visibleInsights(db, c.viewer(c.jash))).toEqual([]);
  });

  it("suggests automating rule-bound work no scheduled task covers yet", async () => {
    const c = await company("Routine Co");
    const procedure = (title: string, automationScore: number) => ({ orgId: c.orgId, personId: c.sumedh, title, summary: "How it's done", steps: ["Do it"], frequency: "daily", judgment: "low", minutes: 25, automationScore });
    await db.insert(procedures).values([procedure("Dispatch report to customers", 100), procedure("Chase overdue payments", 100), procedure("Negotiate annual contracts", 40)]);
    await db.insert(routines).values({ orgId: c.orgId, ownerPersonId: c.sumedh, title: "Chase overdue payments", instruction: "Find overdue invoices and draft chasers", schedule: { kind: "weekdays", time: "10:00" } });
    await refreshInsights(db, c.orgId, NOW);
    const rows = await c.of("automate");
    expect(rows.map((r) => r.title)).toEqual(["“Dispatch report to customers” could be handed to ALRO"]);
    expect(rows[0]).toMatchObject({ severity: 1, department: "sales", acl: [`p:${c.sumedh}`] });

    // Told no once, it doesn't come back.
    expect(await dismissInsight(db, c.viewer(c.sumedh), rows[0].id)).toBe(true);
    await refreshInsights(db, c.orgId, later(24));
    expect((await c.of("automate"))[0].status).toBe("dismissed");
  });
});
