import { and, eq, gte, lt, or } from "drizzle-orm";
import { defaultModels, type Models } from "@/ai/models";
import { fileReader, type FileReader } from "@/ai/read-file";
import { transcribeAudio, type Transcriber } from "@/ai/transcribe";
import { CHANNELS, slackFile, telegramFile, whatsappMedia, type ChannelId } from "@/channels/channels";
import { handleInbound, type Inbound, type InboundOutcome } from "@/channels/handle";
import { linkedViewer, rememberAddress } from "@/channels/links";
import { teamsAttachment } from "@/channels/teams-bot";
import type { Db } from "@/db/client";
import { approvals, webhookEvents } from "@/db/schema";
import { errorText, log } from "./log";
import { deadLetter, type RetryContext } from "./retry";

export type WebhookEvent = typeof webhookEvents.$inferSelect;

/** How the app refers to a file or voice note, so it can be fetched again: an id, a link, or (Teams) the attachment. */
export type MediaRef = string | Record<string, unknown>;

/**
 * What is kept of an incoming message until it has been handled: only what's needed to
 * handle it again. It includes the message text, so it's cleared as soon as the message is
 * answered and the row itself is deleted a week later.
 */
export interface StoredMessage {
  from: string;
  text?: string;
  audio?: MediaRef;
  file?: { ref: MediaRef; mediaType: string; name?: string };
  /** Where to answer when the sender's id isn't enough (Teams). */
  address?: Record<string, string>;
}

export interface WebhookDeps {
  models: Models;
  transcribe: Transcriber;
  readFile?: FileReader;
  send(channel: ChannelId, to: string, text: string, address?: Record<string, string>): Promise<void>;
  /** Downloads a voice note or file from the app it was sent in. */
  media(channel: ChannelId, ref: MediaRef): Promise<Uint8Array>;
  now?: Date;
}

const DOWNLOAD: Record<ChannelId, (ref: MediaRef) => Promise<Uint8Array>> = {
  whatsapp: (ref) => whatsappMedia(String(ref)),
  telegram: (ref) => telegramFile(String(ref)),
  slack: (ref) => slackFile(String(ref)),
  teams: (ref) => teamsAttachment(ref as Parameters<typeof teamsAttachment>[0]),
};

/** The real models, senders and downloads. */
export function liveWebhookDeps(): WebhookDeps {
  const models = defaultModels();
  return {
    models,
    transcribe: transcribeAudio,
    readFile: fileReader(models),
    send: (channel, to, text, address) => CHANNELS[channel].send(to, text, address),
    media: (channel, ref) => DOWNLOAD[channel](ref),
  };
}

/** A processed event is kept this long (so a late redelivery is still recognised), then deleted. */
const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed one is kept longer, for whoever looks into it. */
const KEEP_FAILED_MS = 30 * 24 * 60 * 60 * 1000;
/** Longer than a webhook route may run (120s): an event still "received" after this was dropped mid-way. */
const STUCK_MS = 10 * 60 * 1000;

/**
 * Stores an incoming event before anything is done with it. Returns undefined when the
 * app has delivered this event before (same channel and id): acknowledge it and do nothing.
 */
export async function storeWebhook(db: Db, channel: ChannelId, externalId: string, message: StoredMessage, now = new Date()): Promise<WebhookEvent | undefined> {
  const payload = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const [row] = await db.insert(webhookEvents).values({ channel, externalId, payload, receivedAt: now }).onConflictDoNothing().returning();
  if (!row) log.info("webhook.redelivery_ignored", { channel, externalId });
  return row;
}

/** The file or voice note could not be fetched again when replaying: its link has expired. */
class MediaGone extends Error {}

function inboundOf(event: WebhookEvent, deps: WebhookDeps, replay: boolean): Inbound {
  const channel = event.channel as ChannelId;
  const m = event.payload as unknown as StoredMessage;
  const fetch = (ref: MediaRef) => async () => {
    try {
      return await deps.media(channel, ref);
    } catch (e) {
      // The first time, a failed download may be a blip. The second time, the link is gone.
      throw replay ? new MediaGone(errorText(e)) : e;
    }
  };
  return {
    channel,
    from: m.from,
    id: event.externalId,
    text: m.text,
    audio: m.audio ? fetch(m.audio) : undefined,
    file: m.file ? { mediaType: m.file.mediaType, name: m.file.name, download: fetch(m.file.ref) } : undefined,
    address: m.address,
    replay,
  };
}

const finish = (db: Db, event: WebhookEvent, set: { status: "done" | "failed"; error?: string | null }, now: Date) =>
  db
    .update(webhookEvents)
    // The text isn't needed once it's answered: the conversation is kept in channel_messages.
    .set({ ...set, error: set.error?.slice(0, 1000) ?? null, attempts: event.attempts + 1, processedAt: now, ...(set.status === "done" ? { payload: {} } : {}) })
    .where(eq(webhookEvents.id, event.id));

/**
 * Handles a stored event for the first time. If it fails, the event is marked failed and
 * queued for replay, and the sender is told once that ALRO will try again. Never throws:
 * the webhook has already been acknowledged.
 */
export async function processWebhook(db: Db, event: WebhookEvent, deps: WebhookDeps): Promise<InboundOutcome> {
  const channel = event.channel as ChannelId;
  const m = event.payload as unknown as StoredMessage;
  const now = deps.now ?? new Date();
  const send = (text: string) => deps.send(channel, m.from, text, m.address);
  try {
    if (m.address) await rememberAddress(db, channel, m.from, m.address);
    const outcome = await handleInbound(db, inboundOf(event, deps, false), { models: deps.models, transcribe: deps.transcribe, readFile: deps.readFile, send, now, rethrow: true });
    await finish(db, event, { status: "done" }, now);
    return outcome;
  } catch (e) {
    const error = errorText(e);
    log.error("webhook.failed", { channel, eventId: event.id, error });
    try {
      await finish(db, event, { status: "failed", error }, now);
      const viewer = await linkedViewer(db, channel, m.from);
      await deadLetter(db, { orgId: viewer?.orgId, kind: "webhook", ref: event.id, payload: { channel }, error, now });
      await send("Something went wrong on my side. I'll try again in a few minutes, no need to send it again.").catch(() => undefined);
    } catch (again) {
      // Still "received": the tick's sweep will find it and queue it.
      log.error("webhook.not_queued", { channel, eventId: event.id, error: errorText(again) });
    }
    return "error";
  }
}

/**
 * Handles a failed event again (the retry handler for kind "webhook"). Returning means there
 * is nothing more to do; throwing means try again later. Three cases end it without re-running:
 * it was handled meanwhile; the file's link has expired (the sender is told once); or the first
 * attempt had already put something under Approvals (running the agent again could propose it
 * twice, so the sender is pointed at Approvals instead).
 */
export async function replayWebhook(db: Db, eventId: string, deps: WebhookDeps, ctx: Pick<RetryContext, "last" | "now">): Promise<void> {
  const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  if (!event || event.status === "done") return;
  const channel = event.channel as ChannelId;
  const m = event.payload as unknown as StoredMessage;
  const send = (text: string) => deps.send(channel, m.from, text, m.address).catch(() => undefined);

  const viewer = await linkedViewer(db, channel, m.from);
  if (viewer) {
    const [proposed] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), eq(approvals.origin, "messaging"), gte(approvals.createdAt, event.receivedAt)))
      .limit(1);
    if (proposed) {
      await finish(db, event, { status: "failed", error: "Not tried again: something was already waiting under Approvals from the first attempt." }, ctx.now);
      await send("I hit a problem part-way through your earlier message, after putting something under Approvals. I haven't redone it: check Approvals, and ask again if something is missing.");
      return;
    }
  }
  try {
    await handleInbound(db, inboundOf(event, deps, true), { models: deps.models, transcribe: deps.transcribe, readFile: deps.readFile, send: (text) => deps.send(channel, m.from, text, m.address), now: ctx.now, rethrow: true });
    await finish(db, event, { status: "done" }, ctx.now);
  } catch (e) {
    if (e instanceof MediaGone) {
      await finish(db, event, { status: "failed", error: "The file could not be fetched again: its link had expired. The sender was asked to send it again." }, ctx.now);
      await send("I couldn't open the file or voice note you sent earlier: its link has expired. Please send it again.");
      return;
    }
    await finish(db, event, { status: "failed", error: errorText(e) }, ctx.now);
    if (ctx.last) await send("I couldn't get to your earlier message. Please send it again.");
    throw e;
  }
}

/**
 * Events that were stored but never finished (the server stopped mid-way) are marked failed
 * and queued for replay. Called from the tick.
 */
export async function sweepStuckWebhooks(db: Db, now = new Date()): Promise<number> {
  const stuck = await db
    .update(webhookEvents)
    .set({ status: "failed", error: "Stopped before it finished." })
    .where(and(eq(webhookEvents.status, "received"), lt(webhookEvents.receivedAt, new Date(now.getTime() - STUCK_MS))))
    .returning();
  for (const event of stuck) {
    const viewer = await linkedViewer(db, event.channel as ChannelId, (event.payload as unknown as StoredMessage).from);
    await deadLetter(db, { orgId: viewer?.orgId, kind: "webhook", ref: event.id, payload: { channel: event.channel }, error: "Stopped before it finished.", now });
  }
  return stuck.length;
}

/** Deletes handled events after a week and anything else after a month. */
export async function pruneWebhooks(db: Db, now = new Date()): Promise<number> {
  const gone = await db
    .delete(webhookEvents)
    .where(or(and(eq(webhookEvents.status, "done"), lt(webhookEvents.receivedAt, new Date(now.getTime() - KEEP_DONE_MS))), lt(webhookEvents.receivedAt, new Date(now.getTime() - KEEP_FAILED_MS))))
    .returning({ id: webhookEvents.id });
  return gone.length;
}
