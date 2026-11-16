"use server";

import { refresh } from "next/cache";
import { AccountError, changePassword } from "@/auth/accounts";
import { clientIp } from "@/auth/browser";
import { getDb } from "@/db/client";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/viewer";
import { endSessions, sessionsOf } from "@/platform/members";

export interface AccountState {
  error?: string;
  ok?: string;
}

export async function changePasswordAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const viewer = await getViewer();
  const db = getDb();
  try {
    await changePassword(db, viewer, String(form.get("current") ?? ""), String(form.get("password") ?? ""));
  } catch (e) {
    if (e instanceof AccountError) return { error: e.message };
    throw e;
  }
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "auth.password_changed", ip: await clientIp() });
  return { ok: "Password changed. Your other browsers were signed out." };
}

/** Signs out every browser except this one. */
export async function signOutOthers() {
  const viewer = await getViewer();
  const db = getDb();
  const others = (await sessionsOf(db, viewer.personId)).filter((s) => s.id !== viewer.sessionId).map((s) => s.id);
  await endSessions(db, viewer.personId, others);
  if (others.length) await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "auth.sessions_ended", detail: { count: others.length } });
  refresh();
}
