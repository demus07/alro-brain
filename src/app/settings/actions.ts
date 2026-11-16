"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { ProviderError } from "@/connectors/api";
import { providerOf } from "@/connectors/registry";
import { connectAccount, syncConnection } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { connections } from "@/db/schema";
import { audit } from "@/lib/audit";
import { sourceOf } from "@/lib/sources";
import { getViewer } from "@/lib/viewer";
import { forgetConnection } from "@/memory/forget";
import { processAndRepair } from "@/ops/repair";
import { isAdmin } from "@/platform/roles";
import { assertWithin, LimitError } from "@/platform/usage";

export interface ConnectState {
  error?: string;
  ok?: boolean;
}

/** First sync in the background (it can take minutes), then process what arrived. */
function syncSoon(orgId: string, connectionId: string) {
  after(async () => {
    const db = getDb();
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    if (!c || !providerOf(c.provider)?.sync) return;
    const r = await syncConnection(db, c);
    if (r.messages) await processAndRepair(db, orgId, defaultModels());
  });
}

/** Connects a paste-a-token source: checks the token against the app, stores it encrypted, starts the first sync. */
export async function connectWithToken(_prev: ConnectState, formData: FormData): Promise<ConnectState> {
  const provider = providerOf(String(formData.get("provider") ?? ""));
  if (!provider || provider.auth.kind !== "token") return { error: "Unknown source" };
  const values: Record<string, string> = {};
  for (const f of provider.auth.fields) {
    const v = String(formData.get(f.name) ?? "").trim();
    if (!v && !f.optional) return { error: `${f.label} is required.` };
    if (v) values[f.name] = v;
  }
  try {
    const viewer = await getViewer();
    // A team source feeds everyone's answers, so an admin decides what's connected.
    if (provider.scope === "org" && !isAdmin(viewer)) return { error: "Only an admin can connect a source for the whole team." };
    await assertWithin(getDb(), viewer.orgId, ["sources"]);
    const id = await connectAccount(getDb(), viewer, provider, { kind: "token", values });
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "source.connect", target: sourceOf(provider.id).label });
    syncSoon(viewer.orgId, id);
  } catch (e) {
    if (e instanceof LimitError) return { error: e.message };
    // Apps word a refused token in many ways; say it once, plainly.
    const refused = e instanceof ProviderError && (e.status === 401 || e.status === 403 || /auth_failed|unauthori[sz]ed/i.test(e.message));
    if (refused) return { error: `${sourceOf(provider.id).label} didn't accept that. Check it was copied in full and hasn't expired.` };
    return { error: e instanceof Error ? e.message : "Couldn't connect." };
  }
  refresh();
  return { ok: true };
}

/** Syncs one connection now, in the background. */
export async function syncNow(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const viewer = await getViewer();
  const [c] = await getDb().select({ id: connections.id }).from(connections).where(and(eq(connections.id, id), eq(connections.orgId, viewer.orgId)));
  if (!c) throw new Error("Not found");
  syncSoon(viewer.orgId, c.id);
  refresh();
}

/** Deletes a source and everything derived only from it. Personal sources: only their owner. */
export async function deleteSource(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const viewer = await getViewer();
  const db = getDb();
  const [c] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.orgId, viewer.orgId)));
  if (!c) throw new Error("Not found");
  if (c.scope === "personal" && c.ownerPersonId !== viewer.personId) throw new Error("Only the person who connected this source can delete it");
  if (c.scope === "org" && !isAdmin(viewer) && c.ownerPersonId !== viewer.personId) throw new Error("Only an admin can delete a team source");
  await forgetConnection(db, viewer.orgId, id);
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "source.delete", target: sourceOf(c.provider).label });
  refresh();
}
