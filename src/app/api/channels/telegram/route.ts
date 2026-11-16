import { after } from "next/server";
import { telegram } from "@/channels/channels";
import { getDb } from "@/db/client";
import { liveWebhookDeps, processWebhook, storeWebhook } from "@/ops/webhooks";

export const maxDuration = 120;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    voice?: { file_id: string };
    audio?: { file_id: string };
    /** One entry per size, smallest first. */
    photo?: { file_id: string; width: number }[];
    document?: { file_id: string; mime_type?: string; file_name?: string };
  };
}

/**
 * Incoming Telegram messages. Telegram sends the secret you gave setWebhook in a header.
 * The message is stored first (a redelivery is acknowledged and ignored) and answered after
 * the 200; one that fails is replayed by the tick, with files fetched again by their id.
 */
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!telegram.configured() || !secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("Forbidden", { status: 403 });
  const update = (await request.json()) as TelegramUpdate;
  const m = update.message;
  // Private chats only: in a group the bot would answer with one member's access for everyone to read.
  if (m && m.chat.type === "private") {
    const from = String(m.chat.id);
    const photo = m.photo?.at(-1);
    const file = photo
      ? { ref: photo.file_id, mediaType: "image/jpeg" }
      : m.document
        ? { ref: m.document.file_id, mediaType: m.document.mime_type ?? "application/octet-stream", name: m.document.file_name }
        : undefined;
    const db = getDb();
    const event = await storeWebhook(db, "telegram", `${from}:${m.message_id}`, { from, text: m.text ?? m.caption, audio: m.voice?.file_id ?? m.audio?.file_id, file });
    if (event) after(() => processWebhook(db, event, liveWebhookDeps()));
  }
  return Response.json({ ok: true });
}
