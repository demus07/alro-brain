import { and, eq, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { messages } from "@/db/schema";
import { currentViewer } from "@/lib/viewer";

/** Sidebar footer: whether processing has caught up with everything ingested. */
export async function SyncStatus() {
  await connection();
  // Rendered in the layout, so also on pages where nobody is signed in yet.
  const viewer = await currentViewer().catch(() => undefined);
  if (!viewer) return null;
  const backlog = await countBacklog(viewer.orgId).catch(() => undefined);
  const [state, text] = backlog === undefined ? ["bad", "Database unreachable"] : backlog ? ["stale", `${backlog} to process`] : ["ok", "Memory up to date"];
  return (
    <span className="small">
      <span className={`dot ${state}`} /> {text}
    </span>
  );
}

async function countBacklog(orgId: string): Promise<number> {
  // A count only, no content, so it's read as the owner, filtered by org.
  const [{ backlog }] = await getDb()
    .select({ backlog: sql<number>`count(*) filter (where ${messages.screenResult} is null or (${messages.screenResult} = 'extract' and ${messages.extractedAt} is null))::int` })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), isNull(messages.deletedAt)));
  return backlog;
}
