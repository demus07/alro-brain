"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { createConnectLink } from "@/connectors/nango";
import { adoptConnections, isLive, LIVE, syncConnection, tagsFor } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { connections } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { runPipeline } from "@/pipeline/run";

/** Opens Nango's connect screen for one source. */
export async function connectSource(formData: FormData) {
  const provider = String(formData.get("provider") ?? "");
  if (!isLive(provider)) throw new Error("Unknown source");
  const viewer = await getViewer();
  const link = await createConnectLink({ ...tagsFor(viewer), end_user_email: viewer.email }, [LIVE[provider].integration()]);
  redirect(link);
}

/** Imports sources connected in Nango, in the background (a first sync can take minutes), then processes them. */
export async function importConnected() {
  const viewer = await getViewer();
  const db = getDb();
  after(async () => {
    const outcomes = await adoptConnections(db, viewer);
    if (outcomes.some((o) => o.messages)) await runPipeline(db, viewer.orgId, defaultModels());
  });
  refresh();
}

/** Syncs one live connection now, in the background. */
export async function syncNow(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const viewer = await getViewer();
  const db = getDb();
  const [c] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.orgId, viewer.orgId)));
  if (!c?.nangoConnectionId || !isLive(c.provider)) throw new Error("Not a live connection");
  after(async () => {
    const r = await syncConnection(db, viewer.orgId, { provider: c.provider as keyof typeof LIVE, nangoConnectionId: c.nangoConnectionId!, ownerPersonId: c.ownerPersonId ?? undefined, connectionId: c.id, cursor: c.cursor ?? undefined });
    if (r.messages) await runPipeline(db, viewer.orgId, defaultModels());
  });
  refresh();
}
