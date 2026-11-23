import type { Db } from "@/db/client";
import { runDeadlines } from "./deadlines";
import { syncDocumentStatuses } from "./documents";
import { runLeads } from "./leads";
import { chaseReceivables, syncReceivables } from "./receivables";

/** The desk's part of the 15-minute tick for one company: what customers owe is read, and reminders that have come due are proposed. */
export async function runDesk(db: Db, orgId: string, now = new Date()) {
  const synced = await syncReceivables(db, orgId, now);
  const chased = await chaseReceivables(db, orgId, now);
  const leads = await runLeads(db, orgId, now);
  const documents = await syncDocumentStatuses(db, orgId, now);
  const dates = await runDeadlines(db, orgId, now);
  return { synced, chased, leads, documents, dates };
}
