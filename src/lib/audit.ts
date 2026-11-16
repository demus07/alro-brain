import type { Db } from "@/db/client";
import { auditLog } from "@/db/schema";

export interface AuditEntry {
  orgId: string;
  /** Leave out for the system, or for a sign-in that failed. */
  personId?: string | null;
  /** Dotted: auth.sign_in, ask, approval.approve, member.invite, source.connect, data.export ... */
  action: string;
  target?: string | null;
  /** Small and free of secrets: never a password, a token or a message body. */
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/** Records who did what. Never throws: a failed audit write must not break the action it describes. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({ orgId: entry.orgId, personId: entry.personId ?? null, action: entry.action, target: entry.target?.slice(0, 300) ?? null, detail: entry.detail, ip: entry.ip ?? null });
  } catch (e) {
    console.error("audit write failed", entry.action, e instanceof Error ? e.message : e);
  }
}
