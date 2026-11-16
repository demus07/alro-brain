import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { teamsBot } from "@/channels/channels";
import { teamsText, verifyTeamsRequest, type TeamsActivity } from "@/channels/teams-bot";
import { getDb } from "@/db/client";
import { liveWebhookDeps, processWebhook, storeWebhook } from "@/ops/webhooks";

export const maxDuration = 120;

/**
 * Messages to the ALRO bot in Teams (Bot Framework). Only one-to-one chats: in a group chat or
 * channel the bot would answer with one member's access for everyone to read.
 * The message is stored first (a redelivery is acknowledged and ignored) and answered after
 * the 200. One that fails is replayed by the tick; a Teams file link only lasts a few
 * minutes, so if it has expired by then the sender is asked once to send the file again.
 */
export async function POST(request: Request) {
  if (!teamsBot.configured()) return new Response("Forbidden", { status: 403 });
  const activity = (await request.json()) as TeamsActivity;
  if (!(await verifyTeamsRequest(request.headers.get("authorization"), activity))) return new Response("Unauthorized", { status: 401 });
  const from = activity.from?.aadObjectId ?? activity.from?.id;
  if (activity.type !== "message" || !from || !activity.serviceUrl || !activity.conversation || activity.conversation.conversationType !== "personal") {
    return new Response(null, { status: 200 });
  }
  const address = { serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id };
  const att = activity.attachments?.find((a) => a.contentType === "application/vnd.microsoft.teams.file.download.info" || a.contentType.startsWith("image/"));
  const file = att
    ? {
        // Only what's needed to download it again.
        ref: { contentType: att.contentType, contentUrl: att.contentUrl, name: att.name, content: att.content && { downloadUrl: att.content.downloadUrl, fileType: att.content.fileType } },
        mediaType: att.contentType.startsWith("image/") ? att.contentType : fileType(att.content?.fileType ?? att.name ?? ""),
        name: att.name,
      }
    : undefined;
  const db = getDb();
  const event = await storeWebhook(db, "teams", activity.id ? `${activity.conversation.id}:${activity.id}` : randomUUID(), { from, text: teamsText(activity) || undefined, file, address });
  if (event) after(() => processWebhook(db, event, liveWebhookDeps()));
  return new Response(null, { status: 200 });
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
const fileType = (nameOrExt: string) => TYPES[nameOrExt.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
