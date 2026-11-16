import { aliasedTable, and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, edges, entities, insights, messages, orgs, people, procedures, records, routines, threadMembers, threads, trackerRows, trackers, type TrackerColumn } from "@/db/schema";
import { unionAcl } from "@/db/scope";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["open", "due_soon", "overdue"] as const;

/**
 * Every number that decides when a signal fires, in one place. Days are calendar days unless
 * they say "working" (Monday to Friday in the company's time zone).
 */
export const THRESHOLDS = {
  /** waiting_on_us: an outside person asked something and nobody here has answered for this long. */
  waitingWorkingDays: 2,
  /** ...and it becomes "act today" after this long. */
  waitingUrgentWorkingDays: 4,
  /** Unanswered messages older than this are history, not something to chase. */
  waitingMaxAgeDays: 45,
  /** gone_quiet: no contact for this long... */
  quietDays: 14,
  /** ...after contact in at least `activeWeeks` different weeks of the `activeWindowDays` before the last contact. */
  activeWeeks: 3,
  activeWindowDays: 42,
  /** A silence longer than this is no longer news. */
  quietMaxDays: 120,
  /** at_risk: this many overdue promises owed to one client, deal or project... */
  atRiskOverdue: 2,
  /** ...this many makes it "act today"... */
  atRiskUrgentOverdue: 3,
  /** ...or one promise that went overdue this many times (rescheduled, then missed again). */
  repeatSlips: 2,
  /** overloaded: at least this many open promises, this many of them overdue... */
  overloadOpen: 6,
  overloadOverdue: 2,
  /** ...and a load (open + overdue) this many times the average of the other members. */
  overloadRatio: 1.5,
  overloadUrgentOverdue: 5,
  /** slipping_owner: "act today" once an outside person is this many days late, or late on this many things. */
  slippingUrgentDays: 7,
  slippingUrgentCount: 3,
  /** receivable_late: "act today" once the oldest is this many days past due. */
  receivableUrgentDays: 30,
  /** automate: procedures scoring at least this (of 100) that no scheduled task covers. */
  automateScore: 70,
  /** Evidence messages kept per insight. */
  evidenceMax: 20,
} as const;

export const INSIGHT_KINDS = ["waiting_on_us", "gone_quiet", "at_risk", "overloaded", "slipping_owner", "disputed_fact", "receivable_late", "automate"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/** One thing worth attention, before it is saved. */
export interface Signal {
  kind: InsightKind;
  /** Stable per subject: the same situation always produces the same key. */
  key: string;
  title: string;
  detail: string;
  suggestion: string | null;
  severity: 1 | 2 | 3;
  subjectEntityId?: string;
  subjectPersonId?: string;
  department?: string | null;
  evidenceMessageIds: string[];
  /** Union of the evidence's ACLs: whoever can see the evidence sees the insight. */
  acl: string[];
  /** What brings it back after someone dismissed it: new evidence (or a higher severity), or only a higher severity. */
  renews: "evidence" | "severity";
}

interface Ctx {
  db: Db;
  orgId: string;
  now: Date;
  timeZone: string;
  /** Active members by id. */
  members: Map<string, { name: string; department: string | null }>;
  /** "3 Nov" in the company's time zone. */
  day: (d: Date) => string;
}

/**
 * Recomputes what needs attention from what memory already holds (no model call) and saves it:
 * a signal that is still true updates its row, one that stopped being true is resolved, and one
 * a person dismissed stays dismissed until it changes materially. Safe to rerun at any time.
 *
 * Signals built from several conversations state only counts, names and dates, never quoted
 * content, because someone who can see part of the evidence sees the insight.
 */
export async function refreshInsights(db: Db, orgId: string, now = new Date()): Promise<{ open: number; opened: number; resolved: number }> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { open: 0, opened: 0, resolved: 0 };
  const memberRows = await db
    .select({ id: people.id, name: people.displayName, department: people.department })
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isMember, true), isNull(people.deactivatedAt)));
  const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: org.timezone, day: "numeric", month: "short" });
  const ctx: Ctx = { db, orgId, now, timeZone: org.timezone, members: new Map(memberRows.map((m) => [m.id, m])), day: (d) => dayFormat.format(d) };

  const found = (await Promise.all([waitingOnUs(ctx), goneQuiet(ctx), promiseSignals(ctx), disputedFacts(ctx), lateReceivables(ctx), worthAutomating(ctx)])).flat();
  // An insight nobody could see is not worth a row.
  const signals = new Map(found.filter((s) => s.acl.length).map((s) => [s.key, s]));

  const existing = await db.select().from(insights).where(eq(insights.orgId, orgId));
  const known = new Map(existing.map((r) => [r.key, r]));
  let open = 0;
  let opened = 0;
  let resolved = 0;
  for (const s of signals.values()) {
    const values = {
      kind: s.kind,
      title: s.title,
      detail: s.detail,
      suggestion: s.suggestion,
      severity: s.severity,
      subjectEntityId: s.subjectEntityId ?? null,
      subjectPersonId: s.subjectPersonId ?? null,
      department: s.department ?? null,
      evidenceMessageIds: s.evidenceMessageIds,
      acl: s.acl,
      lastSeenAt: now,
    };
    const row = known.get(s.key);
    if (!row) {
      const added = await db.insert(insights).values({ orgId, key: s.key, ...values, firstSeenAt: now }).onConflictDoNothing().returning({ id: insights.id });
      opened += added.length;
      open++;
    } else if (row.status === "new") {
      await db.update(insights).set(values).where(eq(insights.id, row.id));
      open++;
    } else if (row.status === "resolved" || changedMaterially(row, s)) {
      // It is true again, or worse than when it was dismissed: a fresh occurrence.
      await db.update(insights).set({ ...values, status: "new", dismissedBy: null, firstSeenAt: now }).where(eq(insights.id, row.id));
      opened++;
      open++;
    } else {
      // Dismissed and unchanged: left as it was, so the next comparison is still against what the person dismissed.
      await db.update(insights).set({ acl: s.acl }).where(eq(insights.id, row.id));
    }
  }
  for (const row of existing) {
    if (row.status !== "new" || signals.has(row.key)) continue;
    await db.update(insights).set({ status: "resolved", lastSeenAt: now }).where(eq(insights.id, row.id));
    resolved++;
  }
  return { open, opened, resolved };
}

/** Whether a dismissed insight is different enough to show again. */
function changedMaterially(row: { severity: number; evidenceMessageIds: string[] }, s: Signal): boolean {
  if (s.severity > row.severity) return true;
  return s.renews === "evidence" && s.evidenceMessageIds.some((id) => !row.evidenceMessageIds.includes(id));
}

// ---------------------------------------------------------------------------
// waiting_on_us
// ---------------------------------------------------------------------------

/** Conversations with people, as opposed to documents, CRM timelines and transcripts. */
const CONVERSATIONS = ["channel", "dm", "group_dm", "email", "whatsapp"] as const;
/** One-to-one or addressed to us: an unanswered question counts even if nobody here has written yet. */
const DIRECT = new Set<string>(["dm", "email", "whatsapp"]);
const ASKS = /\?|\b(please|pls|kindly|can you|could you|would you|will you|let (me|us) know|any (update|news)|waiting|awaiting|when (can|will|do)|send (me|us|over|across)|confirm|revert|asap|urgent|reminder|follow(ing)? up|chasing)\b/i;
const AUTOMATED = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|newsletter|bounce/i;

/** Outside people whose question in a conversation has had no answer from any member for 2+ working days. */
async function waitingOnUs(ctx: Ctx): Promise<Signal[]> {
  const { db, orgId, now } = ctx;
  const T = THRESHOLDS;
  const live = and(
    eq(messages.orgId, orgId),
    isNull(messages.deletedAt),
    inArray(messages.kind, ["chat", "email"]),
    gte(messages.sentAt, new Date(now.getTime() - T.waitingMaxAgeDays * DAY_MS)),
    lte(messages.sentAt, now),
  );
  // Threads whose latest message is from someone outside the company.
  const latest = await db
    .selectDistinctOn([messages.threadId], { threadId: messages.threadId, authorPersonId: messages.authorPersonId, isMember: people.isMember })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(and(live, inArray(threads.kind, CONVERSATIONS)))
    .orderBy(messages.threadId, desc(messages.sentAt), desc(messages.id));
  const open = latest.filter((m) => m.authorPersonId && m.isMember === false).map((m) => m.threadId);
  if (!open.length) return [];

  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      sentAt: messages.sentAt,
      text: messages.text,
      subject: messages.subject,
      acl: messages.acl,
      authorPersonId: messages.authorPersonId,
      author: people.displayName,
      email: people.primaryEmail,
      isMember: people.isMember,
      title: threads.title,
      kind: threads.kind,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(and(live, inArray(messages.threadId, open)))
    .orderBy(messages.threadId, desc(messages.sentAt), desc(messages.id));
  const inThread = await db.select({ threadId: threadMembers.threadId, personId: threadMembers.personId }).from(threadMembers).where(inArray(threadMembers.threadId, open));

  const signals: Signal[] = [];
  for (const threadId of open) {
    const thread = rows.filter((m) => m.threadId === threadId);
    // Newest first: everything from outside since a member last wrote.
    const firstMember = thread.findIndex((m) => m.isMember);
    const unanswered = (firstMember < 0 ? thread : thread.slice(0, firstMember)).filter((m) => m.authorPersonId);
    const asks = unanswered.filter((m) => ASKS.test(`${m.subject ?? ""} ${m.text}`) && !AUTOMATED.test(m.email ?? ""));
    if (!asks.length) continue;
    const newest = asks[0];
    const oldest = asks.at(-1)!;
    const participants = [...new Set(thread.flatMap((m) => (m.isMember && m.authorPersonId ? [m.authorPersonId] : [])))];
    // A channel where nobody here has ever spoken isn't a conversation with us.
    if (!DIRECT.has(newest.kind) && !participants.length) continue;
    const waited = workingDaysBetween(oldest.sentAt, now, ctx.timeZone);
    if (waited < T.waitingWorkingDays) continue;

    const who = newest.author ?? "Someone";
    const where = newest.title && newest.title !== who ? newest.title : "a conversation with them";
    const said = clip(newest.text, 160);
    const concerned = participants.length ? participants : inThread.filter((m) => m.threadId === threadId).map((m) => m.personId);
    signals.push({
      kind: "waiting_on_us",
      key: `waiting_on_us:${threadId}`,
      title: `${who} has waited ${waited} working days for a reply`,
      detail: `Waiting since ${ctx.day(oldest.sentAt)} in ${where}. ${asks.length > 1 ? `${asks.length} messages unanswered; the latest` : "They wrote"}: “${said}”`,
      suggestion: newest.subject ? `Draft a reply to ${who} about ${clip(newest.subject.replace(/^((re|fwd?):\s*)+/i, ""), 80)}` : `Draft a reply to ${who}'s message in ${where}: “${clip(newest.text, 90)}”`,
      severity: waited >= T.waitingUrgentWorkingDays ? 3 : 2,
      subjectPersonId: newest.authorPersonId!,
      department: sharedDepartment(ctx, concerned),
      evidenceMessageIds: asks.slice(0, 5).map((m) => m.id),
      acl: unionAcl(...asks.map((m) => m.acl)),
      renews: "evidence",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// gone_quiet
// ---------------------------------------------------------------------------

const CLOSED_DEAL = /won|lost|closed|dead|cancel/i;
/** A CRM deal that isn't marked won, lost or closed in any stage or status field. */
const dealStillOpen = (fields: Record<string, unknown>) => !Object.entries(fields).some(([k, v]) => /stage|status/i.test(k) && typeof v === "string" && CLOSED_DEAL.test(v));

/** Companies and deals that came up most weeks and then stopped, while something with them is still open. */
async function goneQuiet(ctx: Ctx): Promise<Signal[]> {
  const { db, orgId, now } = ctx;
  const T = THRESHOLDS;
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  // Contact = a message in a conversation that mentions the entity.
  const quiet = rowsOf(
    await db.execute(sql`
      with contact as (
        select em.entity_id, m.id, m.sent_at
        from entity_mentions em
        join entities e on e.id = em.entity_id
        join chunks c on c.id = em.chunk_id
        join messages m on m.id = any(c.message_ids)
        where em.org_id = ${orgId} and e.type in ('company', 'deal') and e.hidden_at is null
          and m.deleted_at is null and m.sent_at <= ${now.toISOString()}::timestamptz
      ), latest as (
        select entity_id, max(sent_at) as last_at from contact group by entity_id
      )
      select l.entity_id, l.last_at,
        (select count(distinct date_trunc('week', c.sent_at)) from contact c
          where c.entity_id = l.entity_id and c.sent_at > l.last_at - ${sql.raw(`interval '${T.activeWindowDays} days'`)}) as weeks,
        (select c.id from contact c where c.entity_id = l.entity_id order by c.sent_at desc, c.id limit 1) as last_id
      from latest l
      where l.last_at <= ${at(T.quietDays)}::timestamptz and l.last_at >= ${at(T.quietMaxDays)}::timestamptz
    `),
  ) as { entity_id: string; last_at: string | Date; weeks: string | number; last_id: string }[];
  const active = quiet.filter((q) => Number(q.weeks) >= T.activeWeeks);
  if (!active.length) return [];

  const ids = active.map((q) => q.entity_id);
  const subjects = await db
    .select({ id: entities.id, name: entities.name, type: entities.type, fields: records.fields })
    .from(entities)
    .leftJoin(records, eq(records.id, entities.recordId))
    .where(inArray(entities.id, ids));
  const promises = await db
    .select({ entityId: commitments.relatedEntityId, sourceMessageId: commitments.sourceMessageId, acl: commitments.acl, ownerPersonId: commitments.ownerPersonId })
    .from(commitments)
    .where(and(eq(commitments.orgId, orgId), inArray(commitments.relatedEntityId, ids), inArray(commitments.status, OPEN)))
    .orderBy(sql`${commitments.dueAt} asc nulls last`);
  const lastMessages = await db.select({ id: messages.id, acl: messages.acl }).from(messages).where(inArray(messages.id, active.map((q) => q.last_id)));

  const signals: Signal[] = [];
  for (const q of active) {
    const subject = subjects.find((s) => s.id === q.entity_id);
    const last = lastMessages.find((m) => m.id === q.last_id);
    if (!subject || !last) continue;
    const open = promises.filter((p) => p.entityId === q.entity_id);
    const openDeal = subject.type === "deal" && !!subject.fields && dealStillOpen(subject.fields);
    if (!open.length && !openDeal) continue;
    const lastAt = new Date(q.last_at);
    const days = Math.floor((now.getTime() - lastAt.getTime()) / DAY_MS);
    const stake = [open.length ? `${plural(open.length, "promise")} to do with them ${open.length === 1 ? "is" : "are"} still open` : "", openDeal ? "the deal is still open" : ""].filter(Boolean).join(" and ");
    signals.push({
      kind: "gone_quiet",
      key: `gone_quiet:${q.entity_id}`,
      title: `${subject.name} has gone quiet`,
      detail: `No contact since ${ctx.day(lastAt)} (${days} days), after ${Number(q.weeks)} active weeks in the six before. ${stake.charAt(0).toUpperCase()}${stake.slice(1)}.`,
      suggestion: `Draft a short check-in to ${subject.name} that picks up where we left off`,
      severity: 2,
      subjectEntityId: q.entity_id,
      department: sharedDepartment(ctx, open.flatMap((p) => (p.ownerPersonId ? [p.ownerPersonId] : []))),
      evidenceMessageIds: capped([q.last_id, ...open.map((p) => p.sourceMessageId)]),
      acl: unionAcl(last.acl, ...open.map((p) => p.acl)),
      renews: "evidence",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// at_risk, overloaded, slipping_owner: all read from the open promises
// ---------------------------------------------------------------------------

async function promiseSignals(ctx: Ctx): Promise<Signal[]> {
  const { db, orgId, now } = ctx;
  const T = THRESHOLDS;
  const owner = aliasedTable(people, "owner");
  const counterparty = aliasedTable(people, "counterparty");
  const live = await db
    .select({
      id: commitments.id,
      status: commitments.status,
      dueAt: commitments.dueAt,
      sourceMessageId: commitments.sourceMessageId,
      acl: commitments.acl,
      entityId: commitments.relatedEntityId,
      ownerId: commitments.ownerPersonId,
      ownerName: owner.displayName,
      ownerIsMember: owner.isMember,
      counterpartyId: commitments.counterpartyPersonId,
      counterpartyName: counterparty.displayName,
      counterpartyIsMember: counterparty.isMember,
    })
    .from(commitments)
    .leftJoin(owner, eq(owner.id, commitments.ownerPersonId))
    .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
    .where(and(eq(commitments.orgId, orgId), inArray(commitments.status, OPEN)))
    .orderBy(sql`${commitments.dueAt} asc nulls last`, commitments.id);
  if (!live.length) return [];
  type OpenPromise = (typeof live)[number];
  const ours = live.filter((c) => c.ownerId && ctx.members.has(c.ownerId));
  const overdue = (list: OpenPromise[]) => list.filter((c) => c.status === "overdue");
  const lateDays = (c: OpenPromise) => (c.dueAt ? Math.floor((now.getTime() - c.dueAt.getTime()) / DAY_MS) : 0);
  const owners = (list: OpenPromise[]) => [...new Set(list.flatMap((c) => (c.ownerId ? [c.ownerId] : [])))];
  const signals: Signal[] = [];

  // at_risk: overdue promises we owe one client, deal or project, or promises to them that keep slipping.
  const slips = ours.length
    ? await db
        .select({ id: commitmentEvents.commitmentId, n: count() })
        .from(commitmentEvents)
        .where(and(eq(commitmentEvents.orgId, orgId), eq(commitmentEvents.type, "status_changed"), eq(commitmentEvents.toStatus, "overdue"), inArray(commitmentEvents.commitmentId, ours.map((c) => c.id))))
        .groupBy(commitmentEvents.commitmentId)
    : [];
  const repeat = new Set(slips.filter((s) => s.n >= T.repeatSlips).map((s) => s.id));
  const owedTo = new Map<string, OpenPromise[]>();
  for (const c of ours) {
    const subject = c.entityId ? `e:${c.entityId}` : c.counterpartyId && c.counterpartyIsMember === false ? `p:${c.counterpartyId}` : undefined;
    if (subject) owedTo.set(subject, [...(owedTo.get(subject) ?? []), c]);
  }
  const entityIds = [...owedTo.keys()].flatMap((k) => (k.startsWith("e:") ? [k.slice(2)] : []));
  const named = entityIds.length
    ? await db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(and(inArray(entities.id, entityIds), inArray(entities.type, ["company", "deal", "project", "person"]), isNull(entities.hiddenAt)))
    : [];
  for (const [subject, list] of owedTo) {
    const id = subject.slice(2);
    const name = subject.startsWith("e:") ? named.find((e) => e.id === id)?.name : list[0].counterpartyName;
    const late = overdue(list);
    const slipping = list.filter((c) => repeat.has(c.id));
    if (!name || (late.length < T.atRiskOverdue && !slipping.length)) continue;
    const evidence = [...new Set([...late, ...slipping])];
    const by = owners(evidence).map((o) => `${ctx.members.get(o)!.name.split(/\s+/)[0]} (${evidence.filter((c) => c.ownerId === o).length})`);
    signals.push({
      kind: "at_risk",
      key: `at_risk:${subject}`,
      title: late.length >= T.atRiskOverdue ? `${name} is at risk: ${plural(late.length, "promise")} to them ${late.length === 1 ? "is" : "are"} overdue` : `Promises to ${name} keep slipping`,
      detail: [
        late.length ? `${plural(late.length, "promise")} overdue, the oldest since ${late[0].dueAt ? ctx.day(late[0].dueAt) : "an unknown date"}.` : "",
        slipping.length ? `${slipping.length === 1 ? "One has" : `${slipping.length} have`} missed a deadline more than once.` : "",
        `Owned by ${by.join(", ")}.`,
      ]
        .filter(Boolean)
        .join(" "),
      suggestion: `List what we owe ${name} that is overdue and draft an update to them with new dates`,
      severity: late.length >= T.atRiskUrgentOverdue || (slipping.length && late.length) ? 3 : 2,
      ...(subject.startsWith("e:") ? { subjectEntityId: id } : { subjectPersonId: id }),
      department: sharedDepartment(ctx, owners(evidence)),
      evidenceMessageIds: capped(evidence.map((c) => c.sourceMessageId)),
      acl: unionAcl(...evidence.map((c) => c.acl)),
      renews: "evidence",
    });
  }

  // overloaded: a member carrying far more open and overdue promises than the others.
  const load = new Map([...ctx.members.keys()].map((id) => [id, { open: 0, overdue: 0 }]));
  for (const c of ours) {
    const l = load.get(c.ownerId!)!;
    l.open++;
    if (c.status === "overdue") l.overdue++;
  }
  for (const [personId, l] of load) {
    if (l.open < T.overloadOpen || l.overdue < T.overloadOverdue) continue;
    const others = [...load].filter(([id]) => id !== personId).map(([, o]) => o.open + o.overdue);
    const average = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    if (others.length && l.open + l.overdue < T.overloadRatio * average) continue;
    const member = ctx.members.get(personId)!;
    const late = overdue(ours.filter((c) => c.ownerId === personId));
    signals.push({
      kind: "overloaded",
      key: `overloaded:${personId}`,
      title: `${member.name} is carrying ${l.open} open promises, ${l.overdue} overdue`,
      detail: `${others.length ? `Everyone else averages ${average.toFixed(1)} open. ` : ""}The oldest overdue was due ${late[0].dueAt ? ctx.day(late[0].dueAt) : "a while ago"}.`,
      suggestion: `Show ${member.name}'s overdue promises and suggest which to hand over or move to a new date`,
      severity: l.overdue >= T.overloadUrgentOverdue ? 3 : 2,
      subjectPersonId: personId,
      department: member.department,
      evidenceMessageIds: capped(late.map((c) => c.sourceMessageId)),
      acl: unionAcl([`p:${personId}`], ...late.slice(0, T.evidenceMax).map((c) => c.acl)),
      renews: "evidence",
    });
  }

  // slipping_owner: outside people who are late on what they promised us.
  const theirs = new Map<string, OpenPromise[]>();
  for (const c of overdue(live)) {
    if (c.ownerId && c.ownerIsMember === false) theirs.set(c.ownerId, [...(theirs.get(c.ownerId) ?? []), c]);
  }
  for (const [personId, late] of theirs) {
    const name = late[0].ownerName ?? "Someone";
    const waiting = [...new Set(late.flatMap((c) => (c.counterpartyId && ctx.members.has(c.counterpartyId) ? [c.counterpartyId] : [])))];
    signals.push({
      kind: "slipping_owner",
      key: `slipping_owner:${personId}`,
      title: `${name} is late on ${late.length === 1 ? "something" : `${late.length} things`} they promised us`,
      detail: `The oldest was due ${late[0].dueAt ? `${ctx.day(late[0].dueAt)} (${plural(lateDays(late[0]), "day")} ago)` : "a while ago"}.${waiting.length ? ` Waiting on it: ${waiting.map((id) => ctx.members.get(id)!.name.split(/\s+/)[0]).join(", ")}.` : ""}`,
      suggestion: `Draft a nudge to ${name} about what they promised us and when it was due`,
      severity: late.length >= T.slippingUrgentCount || lateDays(late[0]) >= T.slippingUrgentDays ? 3 : 2,
      subjectPersonId: personId,
      department: sharedDepartment(ctx, waiting),
      evidenceMessageIds: capped(late.map((c) => c.sourceMessageId)),
      acl: unionAcl(...late.map((c) => c.acl)),
      renews: "evidence",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// disputed_fact
// ---------------------------------------------------------------------------

/** Current facts that contradict each other (they share a dispute group until someone picks). */
async function disputedFacts(ctx: Ctx): Promise<Signal[]> {
  const rows = await ctx.db
    .select({ group: edges.disputeGroup, relation: edges.relation, sourceEntityId: edges.sourceEntityId, name: entities.name, sourceMessageIds: edges.sourceMessageIds, acl: edges.acl })
    .from(edges)
    .innerJoin(entities, eq(entities.id, edges.sourceEntityId))
    .where(and(eq(edges.orgId, ctx.orgId), isNull(edges.expiredAt), isNotNull(edges.disputeGroup), isNull(entities.hiddenAt)))
    .orderBy(edges.createdAt, edges.id);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.group!, [...(groups.get(r.group!) ?? []), r]);
  return [...groups].flatMap(([group, facts]): Signal[] => {
    if (facts.length < 2) return [];
    const about = facts[0];
    const what = about.relation.replace(/_/g, " ");
    return [
      {
        kind: "disputed_fact",
        key: `disputed_fact:${group}`,
        title: `Sources disagree about ${about.name} (${what})`,
        // The facts themselves are not quoted: a person may be able to see only one side.
        detail: `ALRO holds ${facts.length} current facts about ${about.name} (${what}) that contradict each other. Until someone picks the right one, answers about it may be wrong.`,
        suggestion: `Show the conflicting facts about ${about.name} (${what}) and where each came from`,
        severity: 2,
        subjectEntityId: about.sourceEntityId,
        evidenceMessageIds: capped(facts.flatMap((f) => f.sourceMessageIds)),
        acl: unionAcl(...facts.map((f) => f.acl)),
        renews: "evidence",
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// receivable_late
// ---------------------------------------------------------------------------

const RECEIVABLES = /receivable|outstanding|owed|collection|invoice|dues/i;
const PAID = /^(payment )?(fully )?(paid|received|settled|cleared|cancelled|canceled|written off)\b/i;
const column = (columns: TrackerColumn[], type: TrackerColumn["type"], name: RegExp) => columns.find((c) => c.type === type && name.test(c.name))?.name;

/** Amounts past their due date in a receivables tracker. Visible to the tracker's owner, like the tracker. */
async function lateReceivables(ctx: Ctx): Promise<Signal[]> {
  const { db, orgId, now } = ctx;
  const all = await db.select().from(trackers).where(eq(trackers.orgId, orgId));
  const signals: Signal[] = [];
  for (const t of all) {
    const due = column(t.columns, "date", /due/i);
    const amount = column(t.columns, "number", /amount|value|balance|outstanding|total/i);
    if (!RECEIVABLES.test(t.name) || !due || !amount) continue;
    const status = column(t.columns, "text", /status|state/i);
    const customer = column(t.columns, "text", /customer|client|party|buyer|account|company|name/i);
    const invoice = column(t.columns, "text", /invoice|bill|ref|number/i);
    const rows = await db.select({ values: trackerRows.values, messageId: trackerRows.messageId }).from(trackerRows).where(eq(trackerRows.trackerId, t.id)).orderBy(desc(trackerRows.at), desc(trackerRows.createdAt)).limit(2000);

    // A tracker only grows: an invoice raised and later paid is two rows. The newest row about an invoice decides.
    const invoices = new Map<string, { customer: string; invoice: string; due?: Date; amount?: number; status?: string; messageIds: string[] }>();
    rows.forEach((r, i) => {
      const text = (name?: string) => (name && r.values[name] != null ? String(r.values[name]).trim() : "");
      const key = customer || invoice ? `${text(customer).toLowerCase()}|${text(invoice).toLowerCase()}` : String(i);
      const item = invoices.get(key) ?? { customer: text(customer), invoice: text(invoice), messageIds: [] };
      const dueAt = text(due) ? new Date(text(due)) : undefined;
      if (!item.due && dueAt && !Number.isNaN(dueAt.getTime())) item.due = dueAt;
      if (item.amount === undefined && typeof r.values[amount] === "number") item.amount = r.values[amount] as number;
      if (item.status === undefined && text(status)) item.status = text(status);
      if (r.messageId) item.messageIds.push(r.messageId);
      invoices.set(key, item);
    });
    const late = [...invoices.values()].filter((v) => v.due && v.due.getTime() < now.getTime() - DAY_MS && !PAID.test(v.status ?? "")).sort((a, b) => a.due!.getTime() - b.due!.getTime());
    if (!late.length) continue;
    const total = late.reduce((sum, v) => sum + (v.amount ?? 0), 0);
    const daysLate = (v: (typeof late)[number]) => Math.floor((now.getTime() - v.due!.getTime()) / DAY_MS);
    const line = (v: (typeof late)[number]) => `${[v.customer, v.invoice].filter(Boolean).join(" ") || "One"}${v.amount !== undefined ? `, ${money(v.amount)}` : ""}, due ${ctx.day(v.due!)} (${plural(daysLate(v), "day")} late)`;
    signals.push({
      kind: "receivable_late",
      key: `receivable_late:${t.id}`,
      title: `${plural(late.length, "payment")} past due${total ? `, ${money(total)} in all` : ""}`,
      detail: `From your ${t.name} tracker. Oldest: ${line(late[0])}.${late.length > 1 ? ` Then: ${late.slice(1, 3).map(line).join("; ")}.` : ""}`,
      suggestion: `Draft payment reminders for the overdue invoices in my ${t.name} tracker`,
      severity: daysLate(late[0]) >= THRESHOLDS.receivableUrgentDays ? 3 : 2,
      department: "finance",
      evidenceMessageIds: capped(late.flatMap((v) => v.messageIds)),
      acl: [`p:${t.personId}`],
      renews: "evidence",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// automate
// ---------------------------------------------------------------------------

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

/** Rule-bound work done often that no scheduled task of the same person does yet. Visible to whoever wrote the procedure up. */
async function worthAutomating(ctx: Ctx): Promise<Signal[]> {
  const { db, orgId } = ctx;
  const list = await db.select().from(procedures).where(and(eq(procedures.orgId, orgId), gte(procedures.automationScore, THRESHOLDS.automateScore)));
  if (!list.length) return [];
  const tasks = await db.select({ personId: routines.ownerPersonId, title: routines.title, instruction: routines.instruction }).from(routines).where(and(eq(routines.orgId, orgId), eq(routines.enabled, true)));
  return list.flatMap((p): Signal[] => {
    const title = [...words(p.title)];
    // Covered when a task of theirs talks about most of what the procedure is called.
    const covered = tasks.some((t) => {
      if (t.personId !== p.personId) return false;
      const task = words(`${t.title} ${t.instruction}`);
      return title.length > 0 && title.filter((w) => task.has(w)).length >= Math.max(1, Math.ceil(title.length / 2));
    });
    if (covered) return [];
    return [
      {
        kind: "automate",
        key: `automate:${p.id}`,
        title: `“${p.title}” could be handed to ALRO`,
        detail: `Done ${p.frequency === "occasional" ? "now and then" : p.frequency}${p.minutes ? `, about ${p.minutes} minutes each time` : ""}${p.owners ? `, by ${p.owners}` : ""}, and it takes ${p.judgment} judgment (${p.automationScore}/100 for handing over). No scheduled task does it yet.`,
        suggestion: `Set up a scheduled task that does “${p.title}” the way the procedure describes`,
        severity: 1,
        department: ctx.members.get(p.personId)?.department,
        evidenceMessageIds: capped(p.messageIds),
        acl: [`p:${p.personId}`],
        // Once someone says no, it only comes back if it ever matters more.
        renews: "severity",
      },
    ];
  });
}

// ---------------------------------------------------------------------------

/** The one department all of these members belong to, if there is one. */
function sharedDepartment(ctx: Ctx, personIds: string[]): string | null {
  const departments = new Set(personIds.flatMap((id) => (ctx.members.has(id) ? [ctx.members.get(id)!.department] : [])));
  const [only] = [...departments];
  return departments.size === 1 && only ? only : null;
}

/** Whole working days (Monday to Friday, local) that have started since `from`. */
export function workingDaysBetween(from: Date, to: Date, timeZone: string): number {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (d: Date) => Date.parse(`${local.format(d)}T00:00:00Z`);
  let n = 0;
  for (let d = day(from) + DAY_MS; d <= day(to); d += DAY_MS) {
    const weekday = new Date(d).getUTCDay();
    if (weekday !== 0 && weekday !== 6) n++;
  }
  return n;
}

const capped = (ids: string[]) => [...new Set(ids)].slice(0, THRESHOLDS.evidenceMax);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
/** node-postgres and PGlite both return { rows }, but drizzle's types differ per driver. */
const rowsOf = (result: unknown): unknown[] => (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []));
