"use server";

import { and, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { entities, entityAliases } from "@/db/schema";
import { withScope } from "@/db/scope";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/viewer";
import * as facts from "@/memory/facts";
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
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "entity.rename", target: id });
  refresh();
}

/** Hides an entity from the graph, search and the agent (row-level security skips hidden ones). */
export async function hideEntity(id: string) {
  const { viewer } = await visible([id]);
  await getDb().update(entities).set({ hiddenAt: new Date() }).where(and(eq(entities.id, id), eq(entities.orgId, viewer.orgId)));
  await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "entity.hide", target: id });
  refresh();
}

/** Folds one entity into another (the same thing under two names): its facts, mentions and names move over. */
export async function mergeEntity(fromId: string, intoId: string) {
  if (fromId === intoId) return;
  const { viewer } = await visible([fromId, intoId]);
  await mergeEntities(getDb(), viewer.orgId, intoId, [fromId]);
  await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "entity.merge", target: intoId, detail: { from: fromId } });
  refresh();
}

/** The signed-in person says a fact is right. Anything it was in dispute with becomes history. */
export async function verifyFact(id: string) {
  await facts.verifyFact(getDb(), await getViewer(), id);
  refresh();
}

/** The signed-in person says a fact is wrong: it becomes history. */
export async function markFactWrong(id: string) {
  await facts.markFactWrong(getDb(), await getViewer(), id);
  refresh();
}

/** Settles a dispute in favour of the side the signed-in person picked. */
export async function resolveDispute(id: string) {
  await facts.resolveDispute(getDb(), await getViewer(), id);
  refresh();
}
