import { after } from "next/server";
import { validWhatsAppSignature, whatsapp } from "@/channels/channels";
import { getDb } from "@/db/client";
import { liveWebhookDeps, processWebhook, storeWebhook, type WebhookEvent } from "@/ops/webhooks";

export const maxDuration = 120;

interface WhatsAppMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  audio?: { id: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
}

/** Meta checks the webhook once with a challenge when you set it up. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ok = q.get("hub.mode") === "subscribe" && !!process.env.WHATSAPP_VERIFY_TOKEN && q.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(q.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
}

/**
 * Incoming WhatsApp messages. Each is stored first (a redelivery of one already stored is
 * acknowledged and ignored), then answered after the 200, since Meta retries anything slow.
 * One that fails is replayed by the tick; media is fetched again by its id.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!whatsapp.configured() || !validWhatsAppSignature(raw, request.headers.get("x-hub-signature-256"))) return new Response("Forbidden", { status: 403 });
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { messages?: WhatsAppMessage[] } }[] }[] };
  const messages = (body.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  const db = getDb();
  const stored: WebhookEvent[] = [];
  for (const m of messages) {
    if (!["text", "audio", "image", "document"].includes(m.type)) continue;
    const media = m.image ?? m.document;
    const event = await storeWebhook(db, "whatsapp", m.id, {
      from: m.from,
      text: m.text?.body ?? media?.caption,
      audio: m.audio?.id,
      file: media ? { ref: media.id, mediaType: media.mime_type, name: m.document?.filename } : undefined,
    });
    if (event) stored.push(event);
  }
  if (stored.length) {
    after(async () => {
      const deps = liveWebhookDeps();
      for (const event of stored) await processWebhook(db, event, deps);
    });
  }
  return Response.json({ ok: true });
}
