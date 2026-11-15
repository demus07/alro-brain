import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { fileReader } from "@/ai/read-file";
import { transcribeAudio } from "@/ai/transcribe";
import { teamsBot } from "@/channels/channels";
import { handleInbound } from "@/channels/handle";
import { rememberAddress } from "@/channels/links";
import { teamsAttachment, teamsText, verifyTeamsRequest, type TeamsActivity } from "@/channels/teams-bot";
import { getDb } from "@/db/client";

export const maxDuration = 120;

/**
 * Messages to the ALRO bot in Teams (Bot Framework). Only one-to-one chats: in a group chat or
 * channel the bot would answer with one member's access for everyone to read.
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
        mediaType: att.contentType.startsWith("image/") ? att.contentType : fileType(att.content?.fileType ?? att.name ?? ""),
        name: att.name,
        download: () => teamsAttachment(att),
      }
    : undefined;
  const models = defaultModels();
  after(async () => {
    const db = getDb();
    await rememberAddress(db, "teams", from, address);
    await handleInbound(
      db,
      { channel: "teams", from, id: activity.id ? `${activity.conversation!.id}:${activity.id}` : undefined, text: teamsText(activity) || undefined, file, address },
      { models, transcribe: transcribeAudio, readFile: fileReader(models), send: (text) => teamsBot.send(from, text, address) },
    );
  });
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
