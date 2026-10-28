import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { commitments, edges, entities, messages, people, threads } from "@/db/schema";
import { unionAcl, type Viewer } from "@/db/scope";
import { createTestDb } from "@/db/test-db";
import { loadFounderFixtures } from "@/ingest/fixtures";
import { chunkPending } from "@/memory/chunks";
import { agentInstructions } from "./agent";
import { agentTools } from "./tools";

const models = testModels();
let db: Db;
let close: () => Promise<void>;
let orgId: string;
let rohan: Viewer;
let ananya: Viewer;
let newHire: Viewer;

type Tools = ReturnType<typeof agentTools>;
const run = <K extends keyof Tools>(tools: Tools, name: K, input: Parameters<NonNullable<Tools[K]["execute"]>>[0]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tools[name].execute as any)(input, { toolCallId: "t", messages: [] });
const toolsFor = (viewer: Viewer) => agentTools(db, viewer, models, "Asia/Kolkata");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ orgId } = await loadFounderFixtures(db));
  await chunkPending(db, orgId, models);
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.primaryEmail, email)))[0].id;
  rohan = { orgId, personId: await id("rohan@alro.ai") };
  ananya = { orgId, personId: await id("ananya@alro.ai") };
  const [n] = await db.insert(people).values({ orgId, displayName: "New Hire", isMember: true }).returning();
  newHire = { orgId, personId: n.id };

  // C26 from the gold set: Rohan promised Ananya on WhatsApp to send Kabir the offer letter.
  const [promise] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.authorPersonId, rohan.personId), like(messages.text, "%offer letter%")))
    .limit(1);
  await db.insert(commitments).values({
    orgId,
    ownerPersonId: rohan.personId,
    counterpartyPersonId: ananya.personId,
    title: "Send Kabir the offer letter",
    quote: promise.text.slice(0, 60),
    dueAt: new Date("2026-10-26T18:29:00Z"),
    dueKind: "hard",
    status: "overdue",
    confidence: 0.9,
    sourceMessageId: promise.id,
    acl: unionAcl(promise.acl, [`p:${rohan.personId}`, `p:${ananya.personId}`]),
  });

  // Price changed: $49 → $39, both facts kept. Learned in a public channel.
  const [general] = await db.select().from(threads).where(eq(threads.title, "#general"));
  const [evidence] = await db.select().from(messages).where(eq(messages.threadId, general.id)).limit(1);
  const [alro, plan] = await db
    .insert(entities)
    .values([
      { orgId, type: "company", name: "ALRO", acl: ["org"] },
      { orgId, type: "product", name: "Team plan", acl: ["org"] },
    ])
    .returning();
  const [newer] = await db
    .insert(edges)
    .values({ orgId, sourceEntityId: alro.id, targetEntityId: plan.id, relation: "prices_at", fact: "Team plan costs $39/user/month", validFrom: new Date("2026-09-29T06:00:00Z"), sourceMessageIds: [evidence.id], acl: ["org"] })
    .returning();
  await db.insert(edges).values({
    orgId,
    sourceEntityId: alro.id,
    targetEntityId: plan.id,
    relation: "prices_at",
    fact: "Team plan costs $49/user/month",
    validFrom: new Date("2026-09-01T06:00:00Z"),
    validTo: new Date("2026-09-29T06:00:00Z"),
    expiredAt: new Date(),
    invalidatedBy: newer.id,
    sourceMessageIds: [evidence.id],
    acl: ["org"],
  });
}, 120_000);

afterAll(() => close());

describe("agent tools", () => {
  it("searches with numbered sources", async () => {
    const tools = toolsFor(rohan);
    const { results } = await run(tools, "searchMemory", { query: "CASA application submitted", limit: 3 });
    expect(results.map((r: { ref: string }) => r.ref)).toEqual(["S1", "S2", "S3"]);
    expect(results[0]).toMatchObject({ thread: "#eng", kind: "channel" });
    // Refs keep counting across calls in one conversation, so they never collide.
    const again = await run(tools, "searchMemory", { query: "Brightdesk demo", limit: 1 });
    expect(again.results[0].ref).toBe("S4");
  });

  it("lists my overdue promises, hidden from people who can't see the source", async () => {
    const mine = await run(toolsFor(rohan), "listCommitments", { person: "me", role: "owner" });
    expect(mine.commitments).toEqual([
      expect.objectContaining({ title: "Send Kabir the offer letter", owner: "Rohan Kulkarni", to: "Ananya Desai", status: "overdue" }),
    ]);
    expect(mine.commitments[0].source.thread).toBe("Ananya Desai");

    const waiting = await run(toolsFor(ananya), "listCommitments", { person: "me", role: "counterparty" });
    expect(waiting.commitments).toHaveLength(1);
    expect((await run(toolsFor(newHire), "listCommitments", {})).commitments).toEqual([]);
  });

  it("gives current facts, and history on request", async () => {
    const now = await run(toolsFor(newHire), "lookupEntity", { name: "team plan" });
    expect(now.facts.map((f: { fact: string }) => f.fact)).toEqual(["Team plan costs $39/user/month"]);

    const history = await run(toolsFor(newHire), "lookupEntity", { name: "ALRO", includeHistory: true });
    expect(history.facts.map((f: { fact: string; current: boolean }) => [f.fact, f.current])).toEqual([
      ["Team plan costs $49/user/month", false],
      ["Team plan costs $39/user/month", true],
    ]);
    expect(history.facts[0].source.ref).toMatch(/^S\d+$/);
  });

  it("reads a thread around a time, only if the asker can see it", async () => {
    const eng = await run(toolsFor(newHire), "readThread", { thread: "#eng", around: "2026-09-07T05:00:00Z", limit: 6 });
    expect(eng.messages).toHaveLength(6);
    expect(eng.messages.some((m: { text: string }) => m.text.includes("CASA application"))).toBe(true);

    const dm = await run(toolsFor(newHire), "readThread", { thread: "Ananya Desai" });
    expect(dm.error).toMatch(/No thread/);
  });

  it("runs a tool loop end to end and answers with citations", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        call++;
        const usage = {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        };
        if (call === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "1", toolName: "listCommitments", input: JSON.stringify({ person: "me", status: ["overdue"] }) }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        const toolResult = JSON.stringify(prompt.at(-1));
        expect(toolResult).toContain("Send Kabir the offer letter");
        return { content: [{ type: "text", text: "You owe Ananya the offer letter for Kabir; it was due Monday [S1]." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    const result = await generateText({
      model,
      instructions: agentInstructions({ askerName: "Rohan Kulkarni", now: new Date("2026-10-27T10:00:00Z"), timeZone: "Asia/Kolkata" }),
      prompt: "What's overdue?",
      tools: toolsFor(rohan),
      stopWhen: isStepCount(4),
    });
    expect(result.text).toContain("[S1]");
    expect(call).toBe(2);
  });
});
