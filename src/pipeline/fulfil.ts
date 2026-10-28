import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments } from "@/db/schema";
import { unionAcl } from "@/db/scope";

export type UpdateKind = "done" | "cancelled" | "rescheduled" | "partial" | "reaffirmed";

export interface CommitmentUpdate {
  kind: UpdateKind;
  /** The message that is the evidence. Its words must contain `quote`. */
  message: { id: string; acl: string[]; sentAt: Date };
  quote: string;
  newDueAt?: Date;
  newDueText?: string;
  confidence: number;
  actor: string;
}

const OPEN = ["open", "due_soon", "overdue"] as const;
type Status = (typeof commitments.$inferSelect)["status"];

/**
 * Applies one piece of evidence to a commitment. Status only changes here,
 * and every change is logged with the message that justified it. Evidence
 * makes the commitment visible to anyone who can see that evidence.
 * Returns false when the update doesn't apply (already closed, or no change).
 */
export async function applyUpdate(tx: Db, commitmentId: string, update: CommitmentUpdate): Promise<boolean> {
  const [c] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId));
  if (!c) return false;
  if (!(OPEN as readonly Status[]).includes(c.status)) return false;
  if (c.evidenceMessageIds.includes(update.message.id) || c.sourceMessageId === update.message.id) return false;

  const base = {
    evidenceMessageIds: [...c.evidenceMessageIds, update.message.id],
    acl: unionAcl(c.acl, update.message.acl),
  };
  const event = { orgId: c.orgId, commitmentId, messageId: update.message.id, actor: update.actor };
  const detail = { quote: update.quote, confidence: update.confidence };

  switch (update.kind) {
    case "done":
    case "cancelled": {
      const toStatus = update.kind;
      await tx
        .update(commitments)
        .set({
          ...base,
          status: toStatus,
          closedAt: update.message.sentAt,
          fulfilledByMessageId: toStatus === "done" ? update.message.id : null,
        })
        .where(eq(commitments.id, commitmentId));
      await tx.insert(commitmentEvents).values({ ...event, type: "status_changed", fromStatus: c.status, toStatus, detail });
      return true;
    }
    case "rescheduled": {
      if (!update.newDueAt && !update.newDueText) return false;
      // A new deadline in the future reopens an overdue promise; the watcher sets due_soon/overdue again.
      const status: Status = update.newDueAt && c.status === "overdue" ? "open" : c.status;
      await tx
        .update(commitments)
        .set({
          ...base,
          dueAt: update.newDueAt ?? c.dueAt,
          dueText: update.newDueText ?? c.dueText,
          dueKind: update.newDueAt ? "hard" : c.dueKind,
          status,
        })
        .where(eq(commitments.id, commitmentId));
      await tx.insert(commitmentEvents).values({
        ...event,
        type: "due_changed",
        fromStatus: c.status,
        toStatus: status,
        detail: { ...detail, from: c.dueAt?.toISOString() ?? null, to: update.newDueAt?.toISOString() ?? null, dueText: update.newDueText },
      });
      return true;
    }
    case "partial":
    case "reaffirmed":
      await tx.update(commitments).set(base).where(eq(commitments.id, commitmentId));
      await tx.insert(commitmentEvents).values({ ...event, type: "evidence_added", detail: { ...detail, kind: update.kind } });
      return true;
  }
}
