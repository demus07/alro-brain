import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { fileReader } from "@/ai/read-file";
import { transcribeAudio } from "@/ai/transcribe";
import { telegram, telegramFile } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { getDb } from "@/db/client";

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
    const photo = m.photo?.at(-1);
    const file = photo
      ? { mediaType: "image/jpeg", download: () => telegramFile(photo.file_id) }
      : m.document
        ? { mediaType: m.document.mime_type ?? "application/octet-stream", name: m.document.file_name, download: () => telegramFile(m.document!.file_id) }
        : undefined;
    const models = defaultModels();
    after(() =>
      handleInbound(
        getDb(),
        { channel: "telegram", from, id: `${from}:${m.message_id}`, text: m.text ?? m.caption, audio: fileId ? () => telegramFile(fileId) : undefined, file },
        { models, transcribe: transcribeAudio, readFile: fileReader(models), send: (text) => telegram.send(from, text) },
      ),
    );
  }
  return Response.json({ ok: true });
}
