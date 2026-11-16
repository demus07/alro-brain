import { and, count, eq, gte, isNull, ne, notLike, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { connections, messages, orgs, people, routines, trackers, usageDaily } from "@/db/schema";

/** What a company may use. Daily limits reset at midnight UTC. */
export interface Limits {
  members: number;
  sources: number;
  routines: number;
  trackers: number;
  questionsPerDay: number;
  /** Model tokens (in and out) across answering, processing and scheduled work. */
  tokensPerDay: number;
  teamRunsPerDay: number;
}

export const PLANS: Record<string, { label: string; limits: Limits }> = {
  pilot: { label: "Pilot", limits: { members: 10, sources: 10, routines: 15, trackers: 8, questionsPerDay: 300, tokensPerDay: 3_000_000, teamRunsPerDay: 30 } },
  team: { label: "Team", limits: { members: 50, sources: 25, routines: 60, trackers: 30, questionsPerDay: 2_000, tokensPerDay: 20_000_000, teamRunsPerDay: 200 } },
  business: { label: "Business", limits: { members: 500, sources: 100, routines: 400, trackers: 200, questionsPerDay: 20_000, tokensPerDay: 200_000_000, teamRunsPerDay: 2_000 } },
};

export const LIMIT_LABEL: Record<keyof Limits, string> = {
  members: "Members",
  sources: "Connected sources",
  routines: "Scheduled tasks",
  trackers: "Trackers",
  questionsPerDay: "Questions today",
  tokensPerDay: "Model usage today (tokens)",
  teamRunsPerDay: "Agent-team runs today",
};

/** Daily counters kept in usage_daily; the rest are counted from their own tables. */
const DAILY: Partial<Record<keyof Limits, string>> = { questionsPerDay: "questions", tokensPerDay: "tokens", teamRunsPerDay: "team_runs" };
export type DailyMetric = "questions" | "tokens" | "team_runs" | "routine_runs";

const today = (now: Date) => now.toISOString().slice(0, 10);

/** A plan limit was reached. The message is fit to show the person. */
export class LimitError extends Error {
  constructor(
    readonly limit: keyof Limits,
    message: string,
  ) {
    super(message);
  }
}

export async function limitsFor(db: Db, orgId: string): Promise<{ plan: string; limits: Limits }> {
  const [org] = await db.select({ plan: orgs.plan, settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const plan = org && PLANS[org.plan] ? org.plan : "pilot";
  return { plan, limits: { ...PLANS[plan].limits, ...(org?.settings.limits as Partial<Limits> | undefined) } };
}

/** Adds to a company's counter for today. Never throws: metering must not break the work it measures. */
export async function bump(db: Db, orgId: string, metric: DailyMetric, amount = 1, now = new Date()) {
  if (amount <= 0) return;
  try {
    await db
      .insert(usageDaily)
      .values({ orgId, day: today(now), metric, amount: Math.round(amount) })
      .onConflictDoUpdate({ target: [usageDaily.orgId, usageDaily.day, usageDaily.metric], set: { amount: sql`${usageDaily.amount} + ${Math.round(amount)}` } });
  } catch (e) {
    console.error("usage metering failed", metric, e instanceof Error ? e.message : e);
  }
}

async function used(db: Db, orgId: string, limit: keyof Limits, now: Date): Promise<number> {
  const metric = DAILY[limit];
  if (metric) {
    const [row] = await db.select({ amount: usageDaily.amount }).from(usageDaily).where(and(eq(usageDaily.orgId, orgId), eq(usageDaily.day, today(now)), eq(usageDaily.metric, metric)));
    return row?.amount ?? 0;
  }
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
  switch (limit) {
    case "members":
      return n(db.select({ n: count() }).from(people).where(and(eq(people.orgId, orgId), eq(people.isMember, true), isNull(people.deactivatedAt))));
    case "sources":
      // Uploads and the built-in notes aren't connections anyone chose to add.
      return n(db.select({ n: count() }).from(connections).where(and(eq(connections.orgId, orgId), ne(connections.status, "revoked"), notLike(connections.provider, "upload:%"), ne(connections.provider, "notes"))));
    case "routines":
      return n(db.select({ n: count() }).from(routines).where(and(eq(routines.orgId, orgId), eq(routines.enabled, true))));
    case "trackers":
      return n(db.select({ n: count() }).from(trackers).where(eq(trackers.orgId, orgId)));
    default:
      return 0;
  }
}

const REACHED: Record<keyof Limits, string> = {
  members: "Your plan's member limit is reached. Remove someone or ask ALRO to raise it.",
  sources: "Your plan's limit on connected sources is reached. Remove one or ask ALRO to raise it.",
  routines: "Your plan's limit on scheduled tasks is reached. Pause or delete one first.",
  trackers: "Your plan's limit on trackers is reached. Delete one first.",
  questionsPerDay: "Your company has reached today's limit on questions. It resets at midnight UTC.",
  tokensPerDay: "Your company has used today's model allowance. It resets at midnight UTC.",
  teamRunsPerDay: "Your company has reached today's limit on agent-team runs. It resets at midnight UTC.",
};

/** Throws a LimitError when a company is at (or over) one of its limits. Call it before doing the thing. */
export async function assertWithin(db: Db, orgId: string, which: (keyof Limits)[], now = new Date()) {
  const { limits } = await limitsFor(db, orgId);
  for (const limit of which) {
    if ((await used(db, orgId, limit, now)) >= limits[limit]) throw new LimitError(limit, REACHED[limit]);
  }
}

export const withinLimit = (db: Db, orgId: string, limit: keyof Limits, now = new Date()) =>
  assertWithin(db, orgId, [limit], now).then(
    () => true,
    (e) => (e instanceof LimitError ? false : Promise.reject(e)),
  );

/** Everything for the usage page: each limit with what's used, plus this month's totals. */
export async function usageReport(db: Db, orgId: string, now = new Date()) {
  const { plan, limits } = await limitsFor(db, orgId);
  const rows = await Promise.all((Object.keys(limits) as (keyof Limits)[]).map(async (limit) => ({ limit, label: LIMIT_LABEL[limit], used: await used(db, orgId, limit, now), max: limits[limit] })));
  const monthStart = `${today(now).slice(0, 7)}-01`;
  const month = await db
    .select({ metric: usageDaily.metric, amount: sql<number>`sum(${usageDaily.amount})::int` })
    .from(usageDaily)
    .where(and(eq(usageDaily.orgId, orgId), gte(usageDaily.day, monthStart)))
    .groupBy(usageDaily.metric);
  const [stored] = await db.select({ n: count() }).from(messages).where(eq(messages.orgId, orgId));
  const [recent] = await db.select({ n: count() }).from(messages).where(and(eq(messages.orgId, orgId), gte(messages.ingestedAt, new Date(`${monthStart}T00:00:00Z`))));
  return { plan, planLabel: PLANS[plan].label, rows, month: Object.fromEntries(month.map((m) => [m.metric, m.amount])) as Partial<Record<DailyMetric, number>>, messagesStored: stored.n, messagesThisMonth: recent.n };
}
