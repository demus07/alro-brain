import { and, eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "@/db/client";
import { orgs, people } from "@/db/schema";
import { emailsToBatch } from "./parsers/email";
import { slackExportToBatch, unzipSlackExport } from "./parsers/slack-export";
import { transcriptsToBatch } from "./parsers/vtt";
import { whatsAppToBatch } from "./parsers/whatsapp";
import { writeBatch, type WriteResult } from "./writer";

export const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "alro-founders");

const read = (...p: string[]) => readFileSync(path.join(FIXTURE_DIR, ...p), "utf8");
const filesIn = (dir: string, ext: string) =>
  readdirSync(path.join(FIXTURE_DIR, dir))
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((name) => ({ name: `${dir}/${name}`, content: read(dir, name) }));

/**
 * Loads the two-founder ALRO dataset (Slack, email, meetings, WhatsApp) into
 * an org called "ALRO", creating it and its two members if needed. Idempotent.
 */
export async function loadFounderFixtures(db: Db): Promise<{ orgId: string; results: Record<string, WriteResult> }> {
  let [org] = await db.select().from(orgs).where(eq(orgs.name, "ALRO"));
  if (!org) [org] = await db.insert(orgs).values({ name: "ALRO", timezone: "Asia/Kolkata" }).returning();

  for (const p of [
    { displayName: "Rohan Kulkarni", primaryEmail: "rohan@alro.ai" },
    { displayName: "Ananya Desai", primaryEmail: "ananya@alro.ai" },
  ]) {
    const [existing] = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.orgId, org.id), eq(people.primaryEmail, p.primaryEmail)));
    if (!existing) await db.insert(people).values({ ...p, orgId: org.id, isMember: true, timezone: "Asia/Kolkata" });
  }

  const zip = readFileSync(path.join(FIXTURE_DIR, "slack-export.zip"));
  const whatsapp = (title: string, file: string[], exportedBy: string) => ({
    title,
    content: read("whatsapp", ...file),
    exportedBy,
    utcOffset: "+05:30",
  });

  const results: Record<string, WriteResult> = {};
  results.slack = await writeBatch(db, org.id, slackExportToBatch(unzipSlackExport(zip), { teamId: "T0ALRO001", domain: "alro" }));
  results.email = await writeBatch(db, org.id, emailsToBatch(filesIn("emails", ".eml"), "rohan@alro.ai"));
  results.meetings = await writeBatch(db, org.id, transcriptsToBatch(filesIn("meetings", ".vtt"), "google-meet"));
  results.whatsappRohan = await writeBatch(
    db,
    org.id,
    whatsAppToBatch(
      [
        whatsapp("Ananya Desai", ["WhatsApp Chat with Ananya Desai.txt"], "Rohan Kulkarni"),
        whatsapp("ALRO Build 🚀", ["WhatsApp Chat with ALRO Build 🚀.txt"], "Rohan Kulkarni"),
      ],
      "whatsapp:Rohan Kulkarni",
    ),
  );
  results.whatsappAnanya = await writeBatch(
    db,
    org.id,
    whatsAppToBatch([whatsapp("ALRO Money & Admin", ["ALRO Money & Admin", "_chat.txt"], "Ananya Desai")], "whatsapp:Ananya Desai"),
  );
  return { orgId: org.id, results };
}
