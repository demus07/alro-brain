import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { slackDm, validSlackSignature } from "@/channels/channels";
import { getDb } from "@/db/client";
import { liveWebhookDeps, processWebhook, storeWebhook } from "@/ops/webhooks";

export const maxDuration = 120;

interface SlackEvent {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    channel_type?: string;
    user?: string;
    text?: string;
    bot_id?: string;
    subtype?: string;
    files?: { url_private_download?: string; mimetype?: string; name?: string }[];
  };
}

/**
 * Direct messages to the ALRO Slack app (Events API, `message.im`). The event is stored first
 * under Slack's event id (Slack redelivers anything not acknowledged within 3 seconds; a
 * redelivery is acknowledged and ignored) and answered after the 200. One that fails is
 * replayed by the tick.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!slackDm.configured() || !validSlackSignature(raw, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const body = JSON.parse(raw) as SlackEvent;
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  const e = body.event;
  // Only a person's own direct message: never the bot's replies, edits or channel chatter.
  const shared = e?.subtype === "file_share" ? e.files?.find((f) => f.url_private_download) : undefined;
  if (e?.type === "message" && e.channel_type === "im" && e.user && !e.bot_id && (!e.subtype || shared) && (e.text || shared)) {
    const file = shared ? { ref: shared.url_private_download!, mediaType: shared.mimetype ?? "application/octet-stream", name: shared.name } : undefined;
    const db = getDb();
    const event = await storeWebhook(db, "slack", body.event_id ?? randomUUID(), { from: e.user, text: e.text || undefined, file });
    if (event) after(() => processWebhook(db, event, liveWebhookDeps()));
  }
  return Response.json({ ok: true });
}
