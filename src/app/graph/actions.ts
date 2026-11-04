"use server";

import { and, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { entities, entityAliases } from "@/db/schema";
import { withScope } from "@/db/scope";
import { getViewer } from "@/lib/viewer";
import { mergeEntities } from "@/pipeline/graph";

const UUID = /^[0-9a-f-]{36}$/;

/** The entities, if the asker can see every one of them; edits go through the owner connection after this check. */
async function visible(ids: string[]) {
  if (!ids.every((id) => UUID.test(id))) throw new Error("Bad request");
  const viewer = await getViewer();
  const rows = await withScope(getDb(), viewer, (tx) => tx.select({ id: entities.id, name: entities.name }).from(entities).where(inArray(entities.id, ids)));
  if (rows.length !== new Set(ids).size) throw new Error("Not found");
  return { viewer, rows };
}

/** Renames an entity; the old name stays as an alias, so search and extraction still recognise it. */
export async function renameEntity(id: string, name: string) {
  const clean = name.trim();
  if (!clean || clean.length > 120) throw new Error("Bad name");
  const { viewer, rows } = await visible([id]);
  const db = getDb();
  await db.update(entities).set({ name: clean, updatedAt: new Date() }).where(and(eq(entities.id, id), eq(entities.orgId, viewer.orgId)));
  if (rows[0].name !== clean) await db.insert(entityAliases).values({ orgId: viewer.orgId, entityId: id, alias: rows[0].name }).onConflictDoNothing();
  refresh();
}

/** Hides an entity from the graph, search and the agent (row-level security skips hidden ones). */
export async function hideEntity(id: string) {
  const { viewer } = await visible([id]);
  await getDb().update(entities).set({ hiddenAt: new Date() }).where(and(eq(entities.id, id), eq(entities.orgId, viewer.orgId)));
  refresh();
}

/** Folds one entity into another (the same thing under two names). */
export async function mergeEntity(fromId: string, intoId: string) {
  if (fromId === intoId) return;
  const { viewer } = await visible([fromId, intoId]);
  await mergeEntities(getDb(), viewer.orgId, intoId, [fromId]);
  refresh();
}
