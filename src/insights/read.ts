import { aliasedTable, and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { entities, insights, people } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { audit } from "@/lib/audit";
import type { InsightKind } from "./compute";

export const KIND_LABEL: Record<InsightKind, string> = {
  waiting_on_us: "waiting on us",
  gone_quiet: "gone quiet",
  at_risk: "at risk",
  overloaded: "overloaded",
  slipping_owner: "late on us",
  disputed_fact: "conflicting facts",
  receivable_late: "payment late",
  automate: "could be automated",
};

export const SEVERITY_LABEL: Record<number, string> = { 3: "act today", 2: "this week", 1: "worth knowing" };

export interface InsightFilter {
  kinds?: string[];
  department?: string;
  subjectEntityId?: string;
  subjectPersonId?: string;
  /** Words in the title, or the name of the person or company it is about. */
  about?: string;
  limit?: number;
}

/**
 * What needs attention right now, most urgent first. Call it inside withScope(): row-level
 * security then leaves out every insight whose evidence the person can't see.
 */
export async function openInsights(tx: Db, filter: InsightFilter = {}) {
  const person = aliasedTable(people, "subject_person");
  const about = filter.about?.trim();
  return tx
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      detail: insights.detail,
      suggestion: insights.suggestion,
      severity: insights.severity,
      department: insights.department,
      subjectEntityId: insights.subjectEntityId,
      subjectPersonId: insights.subjectPersonId,
      evidenceMessageIds: insights.evidenceMessageIds,
      firstSeenAt: insights.firstSeenAt,
    })
    .from(insights)
    .leftJoin(entities, eq(entities.id, insights.subjectEntityId))
    .leftJoin(person, eq(person.id, insights.subjectPersonId))
    .where(
      and(
        eq(insights.status, "new"),
        filter.kinds?.length ? inArray(insights.kind, filter.kinds) : undefined,
        filter.department ? eq(insights.department, filter.department) : undefined,
        filter.subjectEntityId || filter.subjectPersonId
          ? or(filter.subjectEntityId ? eq(insights.subjectEntityId, filter.subjectEntityId) : undefined, filter.subjectPersonId ? eq(insights.subjectPersonId, filter.subjectPersonId) : undefined)
          : undefined,
        about ? or(ilike(insights.title, `%${about}%`), ilike(entities.name, `%${about}%`), ilike(person.displayName, `%${about}%`)) : undefined,
      ),
    )
    .orderBy(desc(insights.severity), desc(insights.firstSeenAt), insights.id)
    .limit(filter.limit ?? 50);
}

export type Insight = Awaited<ReturnType<typeof openInsights>>[number];

/** The insights one person can see. */
export const visibleInsights = (db: Db, viewer: Viewer, filter: InsightFilter = {}) => withScope(db, viewer, (tx) => openInsights(tx as unknown as Db, filter));

/** Where an insight's subject is shown. */
export const subjectHref = (i: { subjectEntityId: string | null; subjectPersonId: string | null }) => (i.subjectEntityId ?? i.subjectPersonId ? `/people/${i.subjectEntityId ?? i.subjectPersonId}` : undefined);

/** Opens the agent with a suggestion already asked. */
export const askHref = (suggestion: string) => `/?ask=${encodeURIComponent(suggestion)}`;

/**
 * Hides an insight for everyone who could see it, until it changes materially. Only someone
 * who can see it may dismiss it. Returns false when there was nothing to dismiss.
 */
export async function dismissInsight(db: Db, viewer: Viewer, id: string): Promise<boolean> {
  const [seen] = await withScope(db, viewer, (tx) => tx.select({ id: insights.id }).from(insights).where(eq(insights.id, id)));
  if (!seen) return false;
  const [row] = await db
    .update(insights)
    .set({ status: "dismissed", dismissedBy: viewer.personId })
    .where(and(eq(insights.id, id), eq(insights.orgId, viewer.orgId), eq(insights.status, "new")))
    .returning({ kind: insights.kind, key: insights.key });
  if (!row) return false;
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "insight.dismiss", target: id, detail: row });
  return true;
}
