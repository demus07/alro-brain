"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { procedures } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { writeProcedures } from "@/work/procedures";

/** Reads the last 90 days in the background; it takes a minute or two. */
export async function writeUp() {
  const viewer = await getViewer();
  after(() => writeProcedures(getDb(), viewer, defaultModels()).catch((e) => console.error("procedures failed", e)));
  refresh();
}

export async function removeProcedure(formData: FormData) {
  const viewer = await getViewer();
  await getDb()
    .delete(procedures)
    .where(and(eq(procedures.id, String(formData.get("id") ?? "")), eq(procedures.personId, viewer.personId)));
  refresh();
}
