import { generateText, type ModelMessage } from "ai";
import { and, desc, eq, gt } from "drizzle-orm";
import { openAgent } from "@/agent/answer";
import { plainAnswer } from "@/agent/plain";
import { recordRun, type Models } from "@/ai/models";
import type { FileReader } from "@/ai/read-file";
import type { Transcriber } from "@/ai/transcribe";
import { decideFromReply } from "@/approvals/approvals";
import type { Db } from "@/db/client";
import { channelMessages, people } from "@/db/schema";
import { handleCustomer } from "@/business/assistant";
import { saveNote } from "@/memory/notes";
import { LimitError } from "@/platform/usage";
import { errorText, log } from "@/ops/log";
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
  /** Kept with the link so ALRO can message them later (Teams' service URL and conversation). */
  address?: Record<string, string>;
  /** A photo or document (a weighment slip, an invoice), downloaded only if needed. */
  file?: { mediaType: string; name?: string; download: () => Promise<Uint8Array> };
  /** A stored event being handled again after it failed: the message recorded the first time is reused instead of counting as a duplicate. */
  replay?: boolean;
}

export interface InboundDeps {
  models: Models;
  transcribe: Transcriber;
  /** Reads photos and documents; without it they're declined politely. */
  readFile?: FileReader;
  send: (text: string) => Promise<void>;
  now?: Date;
  /** Let a failure reach the caller, which keeps the event and replays it, instead of telling the person to try again. */
  rethrow?: boolean;
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
    viewer = code?.length === 8 ? await redeemLinkCode(db, msg.channel, msg.from, code, now, msg.address) : undefined;
    if (!viewer) {
      // A customer (not a member) writing to the company's WhatsApp number: the assistant answers from approved answers, if the company turned it on.
      if (msg.channel === "whatsapp" && msg.text?.trim() && !msg.file) {
        const customer = await handleCustomer(db, deps.models, { from: msg.from, text: msg.text, id: msg.id, name: msg.address?.name }, deps.send, now);
        if (customer) return "answered";
      }
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
  if (!msg.text?.trim() && !msg.audio && !msg.file) return "empty";

  // Recorded first: a redelivered webhook hits the unique id and stops here, before any model call.
  const [fresh] = await db
    .insert(channelMessages)
    .values({ orgId: viewer.orgId, personId: viewer.personId, channel: msg.channel, role: "user", text: msg.text?.trim() || (msg.file ? "(file)" : "(voice note)"), externalId: msg.id, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: channelMessages.id, text: channelMessages.text });
  // A replay picks up the row its failed first attempt left behind.
  const [stored] = fresh || !msg.replay || !msg.id ? [fresh] : await db.select({ id: channelMessages.id, text: channelMessages.text }).from(channelMessages).where(and(eq(channelMessages.channel, msg.channel), eq(channelMessages.externalId, msg.id), eq(channelMessages.personId, viewer.personId)));
  if (!stored) return "duplicate";

  try {
    let text = msg.text?.trim() ?? "";
    // "yes K7QM": a decision on something waiting for approval, not a question.
    if (text && !msg.file) {
      const [lastSaid] = await db
        .select({ text: channelMessages.text })
        .from(channelMessages)
        .where(and(eq(channelMessages.personId, viewer.personId), eq(channelMessages.channel, msg.channel), eq(channelMessages.role, "assistant")))
        .orderBy(desc(channelMessages.createdAt))
        .limit(1);
      const decided = await decideFromReply(db, viewer, text, now, lastSaid?.text);
      if (decided) {
        await db.insert(channelMessages).values({ orgId: viewer.orgId, personId: viewer.personId, channel: msg.channel, role: "assistant", text: decided });
        await deps.send(decided);
        return "answered";
      }
    }
    if (msg.file) {
      if (!deps.readFile) {
        await deps.send("I can't read photos or documents here yet. Type what it says, or upload it in ALRO.");
        return "empty";
      }
      const what = msg.file.mediaType.startsWith("image/") ? "photo" : "document";
      const contents = await deps.readFile({ data: await msg.file.download(), mediaType: msg.file.mediaType, name: msg.file.name });
      // Kept in their notes, so it's searchable, cited and read into trackers like any message.
      // The row's text is rewritten right after the note is saved, so a replay can tell it already was.
      if (!stored.text.startsWith(`(${what})`)) {
        await saveNote(db, viewer, `${text ? `${text}\n\n` : ""}[${what}${msg.file.name ? `: ${msg.file.name}` : ""}]\n${contents}`, { title: text ? text.slice(0, 80) : `A ${what} sent on ${label}`, now });
      }
      text = `(sent a ${what}${text ? ` with the message "${text}"` : ""}; it has been saved to my notes) What it shows:\n${contents}\n\nAcknowledge it in a sentence or two: what it is and the key figures. If it relates to something open (a delivery, a payment, a promise), say so. If it is a receipt or a bill for something they paid, also record it with logExpense (vendor, date, total, GST included, the vendor's GSTIN and bill number if shown) and say you did.`;
      await db.update(channelMessages).set({ text: `(${what}) ${msg.text?.trim() ?? ""} ${contents.slice(0, 500)}`.trim() }).where(eq(channelMessages.id, stored.id));
    }
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
    // Over the plan's daily limit: say so plainly, and don't queue a retry that would hit the same limit.
    if (e instanceof LimitError) {
      await deps.send(e.message).catch(() => undefined);
      return "answered";
    }
    log.error("channel.message_failed", { channel: msg.channel, personId: viewer.personId, replay: msg.replay, error: errorText(e) });
    if (deps.rethrow) throw e;
    await deps.send("Something went wrong on my side. Try again in a minute.").catch(() => undefined);
    return "error";
  }
}
