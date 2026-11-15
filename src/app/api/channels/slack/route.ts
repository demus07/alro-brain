import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { fileReader } from "@/ai/read-file";
import { transcribeAudio } from "@/ai/transcribe";
import { slackDm, slackFile, validSlackSignature } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { getDb } from "@/db/client";

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

/** Direct messages to the ALRO Slack app (Events API, `message.im`). */
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
    const from = e.user;
    const file = shared ? { mediaType: shared.mimetype ?? "application/octet-stream", name: shared.name, download: () => slackFile(shared.url_private_download!) } : undefined;
    const models = defaultModels();
    after(() =>
      handleInbound(
        getDb(),
        { channel: "slack", from, id: body.event_id, text: e.text || undefined, file },
        { models, transcribe: transcribeAudio, readFile: fileReader(models), send: (text) => slackDm.send(from, text) },
      ),
    );
  }
  return Response.json({ ok: true });
}
