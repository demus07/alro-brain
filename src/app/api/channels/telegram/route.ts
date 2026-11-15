import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { transcribeAudio } from "@/ai/transcribe";
import { telegram, telegramFile } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { getDb } from "@/db/client";

export const maxDuration = 120;

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; text?: string; voice?: { file_id: string }; audio?: { file_id: string } };
}

/** Incoming Telegram messages. Telegram sends the secret you gave setWebhook in a header. */
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!telegram.configured() || !secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("Forbidden", { status: 403 });
  const update = (await request.json()) as TelegramUpdate;
  const m = update.message;
  // Private chats only: in a group the bot would answer with one member's access for everyone to read.
  if (m && m.chat.type === "private") {
    const from = String(m.chat.id);
    const fileId = m.voice?.file_id ?? m.audio?.file_id;
    after(() =>
      handleInbound(
        getDb(),
        { channel: "telegram", from, id: `${from}:${m.message_id}`, text: m.text, audio: fileId ? () => telegramFile(fileId) : undefined },
        { models: defaultModels(), transcribe: transcribeAudio, send: (text) => telegram.send(from, text) },
      ),
    );
  }
  return Response.json({ ok: true });
}
