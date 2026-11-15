import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { transcribeAudio } from "@/ai/transcribe";
import { validWhatsAppSignature, whatsapp, whatsappMedia } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { getDb } from "@/db/client";

export const maxDuration = 120;

interface WhatsAppMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  audio?: { id: string };
}

/** Meta checks the webhook once with a challenge when you set it up. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ok = q.get("hub.mode") === "subscribe" && !!process.env.WHATSAPP_VERIFY_TOKEN && q.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(q.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
}

/** Incoming WhatsApp messages. Answered after the 200, since Meta retries anything slow. */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!whatsapp.configured() || !validWhatsAppSignature(raw, request.headers.get("x-hub-signature-256"))) return new Response("Forbidden", { status: 403 });
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { messages?: WhatsAppMessage[] } }[] }[] };
  const messages = (body.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  after(async () => {
    for (const m of messages) {
      if (m.type !== "text" && m.type !== "audio") continue;
      await handleInbound(
        getDb(),
        { channel: "whatsapp", from: m.from, id: m.id, text: m.text?.body, audio: m.audio ? () => whatsappMedia(m.audio!.id) : undefined },
        { models: defaultModels(), transcribe: transcribeAudio, send: (text) => whatsapp.send(m.from, text) },
      );
    }
  });
  return Response.json({ ok: true });
}
