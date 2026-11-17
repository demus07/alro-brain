import { eq } from "drizzle-orm";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { withScope } from "@/db/scope";
import { getViewer } from "@/lib/viewer";
import { recall, type SearchHit } from "@/memory/search";

/** Searches everything the signed-in person can see: the Search page and the ⌘K search share this. */
export async function runSearch(q: string) {
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const found = await withScope(db, viewer, (tx) => recall(tx as unknown as typeof db, defaultModels(), q, { limit: 20 }));
  return { ...found, timeZone: org.timezone, viewer };
}

/** A match's text without its first line (the thread header) or per-line timestamps, kept short. */
export const excerpt = (hit: SearchHit, max = 320) => {
  const body = hit.text.split("\n").slice(1).join("\n").replace(/^\[[^\]]+\]\s*/gm, "");
  return body.length > max ? `${body.slice(0, max)}…` : body;
};
