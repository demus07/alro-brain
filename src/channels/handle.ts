import { generateText, type ModelMessage } from "ai";
import { and, desc, eq, gt } from "drizzle-orm";
import { openAgent } from "@/agent/answer";
import { plainAnswer } from "@/agent/plain";
import { recordRun, type Models } from "@/ai/models";
import type { Transcriber } from "@/ai/transcribe";
import type { Db } from "@/db/client";
import { channelMessages, people } from "@/db/schema";
import { CHANNELS, type ChannelId } from "./channels";
import { linkedViewer, redeemLinkCode } from "./links";

/** Earlier turns sent to the agent, so "and for last month?" makes sense. */
const HISTORY = 8;
const HISTORY_MS = 12 * 60 * 60 * 1000;

export interface Inbound {
  channel: ChannelId;
  /** Phone number, Telegram chat id or Slack user id: who to answer. */
  from: string;
  /** The app's id for this message, when it has one, so a redelivery is answered once. */
  id?: string;
  text?: string;
  /** A voice note, downloaded only if needed. */
  audio?: () => Promise<Uint8Array>;
}

export interface InboundDeps {
  models: Models;
  transcribe: Transcriber;
  send: (text: string) => Promise<void>;
  now?: Date;
}

export type InboundOutcome = "answered" | "linked" | "unlinked" | "duplicate" | "empty" | "error";

/**
 * One incoming message from a messaging app. A linked member gets an answer from the
 * same agent as the web app, with their access; a voice note is transcribed first.
 * An unknown sender is only ever told how to link, and can link with a one-time code.
 */
export async function handleInbound(db: Db, msg: Inbound, deps: InboundDeps): Promise<InboundOutcome> {
  const now = deps.now ?? new Date();
  const label = CHANNELS[msg.channel].label;
  let viewer = await linkedViewer(db, msg.channel, msg.from);

  if (!viewer) {
    const code = msg.text?.replace(/\D/g, "");
    viewer = code?.length === 8 ? await redeemLinkCode(db, msg.channel, msg.from, code, now) : undefined;
    if (!viewer) {
      await deps.send(`I don't know this ${label} account yet. In ALRO, open Settings → Messaging, get a code and send it here.`);
      return "unlinked";
    }
    const [person] = await db.select({ name: people.displayName }).from(people).where(eq(people.id, viewer.personId));
    await deps.send(`Linked. Hi ${person?.name.split(/\s+/)[0] ?? "there"}, ask me anything about the company, or send a voice note.`);
    return "linked";
  }

  const [person] = await db.select({ displayName: people.displayName, isMember: people.isMember }).from(people).where(eq(people.id, viewer.personId));
  if (!person?.isMember) {
    await deps.send("This account is no longer a member of an ALRO workspace.");
    return "unlinked";
  }
  if (!msg.text?.trim() && !msg.audio) return "empty";

  // Recorded first: a redelivered webhook hits the unique id and stops here, before any model call.
  const [stored] = await db
    .insert(channelMessages)
    .values({ orgId: viewer.orgId, personId: viewer.personId, channel: msg.channel, role: "user", text: msg.text?.trim() || "(voice note)", externalId: msg.id, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: channelMessages.id });
  if (!stored) return "duplicate";

  try {
    let text = msg.text?.trim() ?? "";
    if (!text && msg.audio) {
      text = await deps.transcribe(await msg.audio());
      if (!text) {
        await deps.send("I couldn't make out that voice note. Try again or type it.");
        return "empty";
      }
      await db.update(channelMessages).set({ text: `(voice note) ${text}` }).where(eq(channelMessages.id, stored.id));
    }

    const earlier = await db
      .select({ id: channelMessages.id, role: channelMessages.role, text: channelMessages.text })
      .from(channelMessages)
      .where(and(eq(channelMessages.personId, viewer.personId), eq(channelMessages.channel, msg.channel), gt(channelMessages.createdAt, new Date(now.getTime() - HISTORY_MS))))
      .orderBy(desc(channelMessages.createdAt))
      .limit(HISTORY + 1);
    const history: ModelMessage[] = earlier
      .filter((m) => m.id !== stored.id)
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));

    const { agent, close } = await openAgent(db, { ...viewer, displayName: person.displayName }, deps.models, { now, channel: label });
    let reply: string;
    try {
      const result = await generateText({ ...agent, messages: [...history, { role: "user", content: msg.audio && !msg.text ? `(voice note) ${text}` : text }] });
      await recordRun(db, { orgId: viewer.orgId, stage: "answer", model: deps.models.answer, inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens });
      reply = plainAnswer(result.text, result.steps.flatMap((s) => s.toolResults.map((r) => r.output))) || "I don't have an answer for that.";
    } finally {
      await close();
    }
    await db.insert(channelMessages).values({ orgId: viewer.orgId, personId: viewer.personId, channel: msg.channel, role: "assistant", text: reply });
    await deps.send(reply);
    return "answered";
  } catch (e) {
    console.error(`${msg.channel} message from ${viewer.personId} failed`, e);
    await deps.send("Something went wrong on my side. Try again in a minute.").catch(() => undefined);
    return "error";
  }
}
