import { aliasedTable, and, count, desc, eq, gte, ilike, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { approvals, chunks, commitmentEvents, commitments, edges, entities, entityMentions, events, messages, people, procedures, routines, teamAgents, teamRuns, trackerRows, trackers } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { startOfLocalDay } from "@/lib/time";
import { departmentLabel } from "@/team/presets";
import { totals } from "@/work/trackers";
import { openInsights } from "./read";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["open", "due_soon", "overdue"] as const;
/** Customers and deals are listed when they came up in this many days, ranked by the last `RECENT_DAYS`. */
const ACTIVITY_DAYS = 60;
const RECENT_DAYS = 14;

/** Open and overdue promises per owner, counting only promises the person can see. */
async function loadByOwner(tx: Db) {
  const rows = await tx.select({ ownerId: commitments.ownerPersonId, status: commitments.status, n: count() }).from(commitments).where(inArray(commitments.status, OPEN)).groupBy(commitments.ownerPersonId, commitments.status);
  const load = new Map<string | null, { open: number; overdue: number }>();
  for (const r of rows) {
    const l = load.get(r.ownerId) ?? { open: 0, overdue: 0 };
    l.open += r.n;
    if (r.status === "overdue") l.overdue += r.n;
    load.set(r.ownerId, l);
  }
  return load;
}

const activeMembers = (tx: Db) =>
  tx.select({ id: people.id, name: people.displayName, department: people.department }).from(people).where(and(eq(people.isMember, true), isNull(people.deactivatedAt))).orderBy(people.displayName);

/** Monday 00:00 of the current local week. */
function startOfLocalWeek(now: Date, timeZone: string): Date {
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now));
  return startOfLocalDay(new Date(startOfLocalDay(now, timeZone).getTime() - weekday * DAY_MS + DAY_MS / 2), timeZone);
}

/**
 * The state of the business as one person can see it: headline numbers, what needs
 * attention, who is carrying what, what changed this week, the busiest customers and deals,
 * and their trackers. Plain queries in their scope; no model call.
 */
export async function companyState(db: Db, viewer: Viewer, timeZone: string, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const weekStart = startOfLocalWeek(now, timeZone);
  return withScope(db, viewer, async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [anything] = await tx.select({ id: messages.id }).from(messages).limit(1);
    const load = await loadByOwner(tx);
    const all = await openInsights(tx, { limit: 200 });
    const [{ pending }] = await tx.select({ pending: count() }).from(approvals).where(and(eq(approvals.personId, viewer.personId), eq(approvals.status, "pending")));
    const [{ meetings }] = await tx
      .select({ meetings: count() })
      .from(events)
      .where(and(eq(events.ownerPersonId, viewer.personId), eq(events.cancelled, false), eq(events.allDay, false), gte(events.startsAt, weekStart), lt(events.startsAt, new Date(weekStart.getTime() + 7 * DAY_MS))));

    const members = (await activeMembers(tx)).map((m) => ({ ...m, ...(load.get(m.id) ?? { open: 0, overdue: 0 }) }));
    const agentDepartments = await tx.selectDistinct({ department: teamAgents.department }).from(teamAgents);
    const slugs = [...new Set([...members.flatMap((m) => (m.department ? [m.department] : [])), ...agentDepartments.map((a) => a.department)])].sort();
    const departments = slugs.map((slug) => {
      const theirs = members.filter((m) => m.department === slug);
      return {
        slug,
        label: departmentLabel(slug),
        members: theirs.length,
        open: theirs.reduce((n, m) => n + m.open, 0),
        overdue: theirs.reduce((n, m) => n + m.overdue, 0),
        attention: all.filter((i) => i.department === slug).length,
      };
    });

    // This week: decisions, facts that changed, promises kept and slipped.
    const newer = alias(edges, "newer");
    const decisions = await tx
      .select({ id: edges.id, fact: edges.fact, at: edges.createdAt, messageId: sql<string | null>`${edges.sourceMessageIds}[1]` })
      .from(edges)
      .where(and(gte(edges.createdAt, weekAgo), ilike(edges.relation, "decid%")))
      .orderBy(desc(edges.createdAt))
      .limit(6);
    const changed = await tx
      .select({ id: edges.id, was: edges.fact, became: newer.fact, at: edges.expiredAt, messageId: sql<string | null>`coalesce(${newer.sourceMessageIds}[1], ${edges.sourceMessageIds}[1])` })
      .from(edges)
      .leftJoin(newer, eq(newer.id, edges.invalidatedBy))
      .where(gte(edges.expiredAt, weekAgo))
      .orderBy(desc(edges.expiredAt))
      .limit(6);
    const [{ newFacts }] = await tx.select({ newFacts: count() }).from(edges).where(gte(edges.createdAt, weekAgo));
    const [{ changedFacts }] = await tx.select({ changedFacts: count() }).from(edges).where(gte(edges.expiredAt, weekAgo));
    const moved = await tx
      .selectDistinctOn([commitmentEvents.commitmentId, commitmentEvents.toStatus], { id: commitments.id, to: commitmentEvents.toStatus, title: commitments.title, owner: people.displayName, at: commitmentEvents.createdAt })
      .from(commitmentEvents)
      .innerJoin(commitments, eq(commitments.id, commitmentEvents.commitmentId))
      .leftJoin(people, eq(people.id, commitments.ownerPersonId))
      .where(and(eq(commitmentEvents.type, "status_changed"), inArray(commitmentEvents.toStatus, ["done", "overdue"]), gte(commitmentEvents.createdAt, weekAgo)))
      .orderBy(commitmentEvents.commitmentId, commitmentEvents.toStatus, desc(commitmentEvents.createdAt));
    const newest = (to: string) => moved.filter((m) => m.to === to).sort((a, b) => b.at.getTime() - a.at.getTime());

    // Customers and deals by how much they came up lately.
    const recent = sql<number>`count(distinct ${chunks.id}) filter (where ${chunks.endAt} >= ${new Date(now.getTime() - RECENT_DAYS * DAY_MS).toISOString()}::timestamptz)`.mapWith(Number);
    const busiest = await tx
      .select({ id: entities.id, name: entities.name, type: entities.type, lastAt: max(chunks.endAt), recent })
      .from(entities)
      .innerJoin(entityMentions, eq(entityMentions.entityId, entities.id))
      .innerJoin(chunks, eq(chunks.id, entityMentions.chunkId))
      .where(and(inArray(entities.type, ["company", "deal"]), gte(chunks.endAt, new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS))))
      .groupBy(entities.id)
      .orderBy(desc(recent), desc(max(chunks.endAt)), entities.name)
      .limit(8);
    const owed = busiest.length
      ? await tx
          .select({ entityId: commitments.relatedEntityId, status: commitments.status, n: count() })
          .from(commitments)
          .where(and(inArray(commitments.relatedEntityId, busiest.map((b) => b.id)), inArray(commitments.status, OPEN)))
          .groupBy(commitments.relatedEntityId, commitments.status)
      : [];
    const customers = busiest.map((b) => ({
      ...b,
      open: owed.filter((o) => o.entityId === b.id).reduce((n, o) => n + o.n, 0),
      overdue: owed.filter((o) => o.entityId === b.id && o.status === "overdue").reduce((n, o) => n + o.n, 0),
      flags: [...new Set(all.filter((i) => i.subjectEntityId === b.id).map((i) => i.kind))],
    }));

    const own = await tx.select().from(trackers).orderBy(trackers.name);
    const rows = own.length ? await tx.select({ trackerId: trackerRows.trackerId, values: trackerRows.values }).from(trackerRows).where(inArray(trackerRows.trackerId, own.map((t) => t.id))).limit(5000) : [];
    const tables = own.map((t) => {
      const theirs = rows.filter((r) => r.trackerId === t.id);
      return { id: t.id, name: t.name, rows: theirs.length, totals: totals(t.columns, theirs) };
    });

    const everyone = [...load.values()];
    return {
      /** False until any source is connected (or anything is visible to this person). */
      connected: !!anything,
      tiles: {
        open: everyone.reduce((n, l) => n + l.open, 0),
        overdue: everyone.reduce((n, l) => n + l.overdue, 0),
        waitingOnUs: all.filter((i) => i.kind === "waiting_on_us").length,
        atRisk: all.filter((i) => i.kind === "at_risk").length,
        approvals: pending,
        meetings,
      },
      attention: all.slice(0, 8),
      attentionTotal: all.length,
      members,
      departments,
      week: { decisions, changed, newFacts, changedFacts, kept: newest("done"), slipped: newest("overdue") },
      customers,
      trackers: tables,
    };
  });
}

export type CompanyState = Awaited<ReturnType<typeof companyState>>;

/**
 * One department as one person can see it: its members and what they owe, what needs
 * attention there, its specialists, and the person's own scheduled tasks, team runs and
 * procedures that belong to it.
 */
export async function departmentState(db: Db, viewer: Viewer, slug: string) {
  return withScope(db, viewer, async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const load = await loadByOwner(tx);
    const members = (await activeMembers(tx)).filter((m) => m.department === slug).map((m) => ({ ...m, ...(load.get(m.id) ?? { open: 0, overdue: 0 }) }));
    const specialists = await tx.select({ id: teamAgents.id, name: teamAgents.name, job: teamAgents.job, enabled: teamAgents.enabled }).from(teamAgents).where(eq(teamAgents.department, slug)).orderBy(teamAgents.createdAt);
    if (!members.length && !specialists.length) return undefined;

    const counterparty = aliasedTable(people, "counterparty");
    const promises = members.length
      ? await tx
          .select({
            id: commitments.id,
            ownerId: commitments.ownerPersonId,
            title: commitments.title,
            status: commitments.status,
            dueAt: commitments.dueAt,
            dueText: commitments.dueText,
            to: sql<string | null>`coalesce(${counterparty.displayName}, ${commitments.counterpartyText})`,
          })
          .from(commitments)
          .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
          .where(and(inArray(commitments.ownerPersonId, members.map((m) => m.id)), inArray(commitments.status, OPEN)))
          .orderBy(sql`${commitments.dueAt} asc nulls last`)
      : [];
    // Scheduled tasks, team runs and procedures are personal: these are the viewer's own.
    const tasks = await tx.select({ id: routines.id, title: routines.title, schedule: routines.schedule, enabled: routines.enabled, nextRunAt: routines.nextRunAt, lastRunAt: routines.lastRunAt }).from(routines).where(eq(routines.team, slug)).orderBy(desc(routines.createdAt));
    const runs = await tx.select({ id: teamRuns.id, task: teamRuns.task, status: teamRuns.status, answer: teamRuns.answer, error: teamRuns.error, startedAt: teamRuns.startedAt }).from(teamRuns).where(eq(teamRuns.department, slug)).orderBy(desc(teamRuns.startedAt)).limit(8);
    const written = await tx.select({ id: procedures.id, title: procedures.title, summary: procedures.summary, owners: procedures.owners, frequency: procedures.frequency, automationScore: procedures.automationScore }).from(procedures).orderBy(desc(procedures.automationScore));
    // A procedure belongs here when the people who do it are named in it, or the department is.
    const names = [slug, departmentLabel(slug), ...members.flatMap((m) => [m.name, m.name.split(/\s+/)[0]])].map((n) => n.toLowerCase()).filter((n) => n.length > 2);
    return {
      slug,
      label: departmentLabel(slug),
      members,
      promises,
      attention: await openInsights(tx, { department: slug, limit: 20 }),
      specialists,
      tasks,
      runs,
      procedures: written.filter((p) => names.some((n) => (p.owners ?? "").toLowerCase().includes(n))),
    };
  });
}

export type DepartmentState = NonNullable<Awaited<ReturnType<typeof departmentState>>>;
