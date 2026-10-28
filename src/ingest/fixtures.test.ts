import { eq, sql } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { messages, people, threads } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { FIXTURE_DIR, loadFounderFixtures } from "./fixtures";

interface Label {
  commitment_id?: string;
  file: string;
  speaker?: string;
  quote: string;
}

const labels = readdirSync(path.join(FIXTURE_DIR, "labels"))
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => {
    const data = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "labels", f), "utf8")) as {
      items: Label[];
      distractors: Label[];
    };
    return [...data.items, ...data.distractors];
  });

let db: Db;
let close: () => Promise<void>;
let orgId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ orgId } = await loadFounderFixtures(db));
}, 120_000);

afterAll(() => close());

describe("founder fixtures", () => {
  it("resolves every identity to the two founders", async () => {
    const rows = await db.select({ name: people.displayName }).from(people).where(eq(people.orgId, orgId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Ananya Desai", "Rohan Kulkarni"]);
  });

  it("ingests every source with the right visibility", async () => {
    const rows = await db
      .select({ kind: threads.kind, visibility: threads.visibility, count: sql<number>`count(*)::int` })
      .from(threads)
      .groupBy(threads.kind, threads.visibility);
    const byKind = Object.fromEntries(rows.map((r) => [`${r.kind}/${r.visibility}`, r.count]));
    expect(byKind["channel/org"]).toBe(3);
    expect(byKind["dm/members"]).toBe(1);
    expect(byKind["meeting/members"]).toBe(5);
    expect(byKind["whatsapp/members"]).toBe(3);
    expect(byKind["email/members"]).toBeGreaterThanOrEqual(1);

    const perThread = await db
      .select({ title: threads.title, kind: threads.kind, count: sql<number>`count(${messages.id})::int` })
      .from(threads)
      .leftJoin(messages, eq(messages.threadId, threads.id))
      .groupBy(threads.title, threads.kind);
    for (const t of perThread.filter((t) => t.kind === "whatsapp")) expect(t.count).toBeGreaterThanOrEqual(90);
    for (const t of perThread.filter((t) => t.kind === "meeting")) expect(t.count).toBeGreaterThanOrEqual(60);
  });

  it("is idempotent", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
    const { results } = await loadFounderFixtures(db);
    for (const r of Object.values(results)) expect(r.messages.inserted).toBe(0);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
    expect(after[0].n).toBe(before[0].n);
  });

  it.each(labels.map((l) => [`${l.commitment_id ?? "distractor"} ${l.file}: ${l.quote.slice(0, 50)}`, l] as const))(
    "finds labelled quote %s",
    async (_, label) => {
      const rows = await db
        .select({ text: messages.text, author: people.displayName })
        .from(messages)
        .leftJoin(people, eq(people.id, messages.authorPersonId))
        .where(sql`strpos(${messages.text}, ${label.quote}) > 0`);
      expect(rows.length, `quote not found in any message`).toBeGreaterThan(0);
      if (label.speaker) expect(rows.map((r) => r.author)).toContain(label.speaker);
    },
  );
});
