import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";

export type Verdict = "done" | "not_a_promise" | "reopen";

/**
 * A person's own judgement on a commitment: they kept it, it was never a real
 * promise, or it was closed by mistake. Only the owner or the person it was
 * promised to may do this, and it runs under their scope, so they can only
 * touch commitments they can see. Every verdict is logged with who gave it.
 */
export async function recordVerdict(db: Db, viewer: Viewer, commitmentId: string, verdict: Verdict): Promise<void> {
  await withScope(db, viewer, async (tx) => {
    const [c] = await tx.select().from(commitments).where(eq(commitments.id, commitmentId));
    if (!c) throw new Error("Commitment not found");
    if (c.ownerPersonId !== viewer.personId && c.counterpartyPersonId !== viewer.personId) {
      throw new Error("Only the people a commitment is between can change it");
    }
    const now = new Date();
    const change =
      verdict === "done"
        ? { status: "done" as const, closedAt: now, userVerdict: "confirmed" as const }
        : verdict === "not_a_promise"
          ? { status: "dismissed" as const, closedAt: now, userVerdict: "rejected" as const }
          : { status: "open" as const, closedAt: null, fulfilledByMessageId: null, userVerdict: null };
    // The watcher moves a reopened promise to due_soon / overdue on its next run.
    await tx
      .update(commitments)
      .set({ ...change, verdictByPersonId: viewer.personId })
      .where(eq(commitments.id, commitmentId));
    await tx.insert(commitmentEvents).values({
      orgId: viewer.orgId,
      commitmentId,
      type: "verdict",
      fromStatus: c.status,
      toStatus: change.status,
      actor: `person:${viewer.personId}`,
      detail: { verdict },
    });
  });
}
