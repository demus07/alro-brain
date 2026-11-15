import { createHmac, timingSafeEqual } from "node:crypto";
import { splitMessage } from "./split";
import { sendTeams, teamsBotConfigured, type TeamsAddress } from "./teams-bot";

export { splitMessage };

export type ChannelId = "whatsapp" | "telegram" | "slack" | "teams";

/** A messaging app the agent can be asked in. One bot per ALRO deployment, configured in the environment. */
export interface Channel {
  id: ChannelId;
  label: string;
  /** How a member finds the bot, shown in Settings. */
  where: () => string;
  configured: () => boolean;
  /** `address` is what was kept when the person linked, for apps that need more than an id (Teams). */
  send(to: string, text: string, address?: Record<string, string> | null): Promise<void>;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) throw new Error(`${new URL(url).host} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const graph = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v24.0"}`;

/** WhatsApp Business Cloud API (Meta). https://developers.facebook.com/docs/whatsapp/cloud-api */
export const whatsapp: Channel = {
  id: "whatsapp",
  label: "WhatsApp",
  where: () => process.env.WHATSAPP_DISPLAY_NUMBER ?? "your ALRO WhatsApp number",
  configured: () => !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID,
  async send(to, text) {
    for (const body of splitMessage(text)) {
      await post(`${graph()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, { messaging_product: "whatsapp", to, type: "text", text: { body } });
    }
  },
};

/** Downloads a WhatsApp voice note, photo or document: the media id resolves to a short-lived URL. */
export async function whatsappMedia(mediaId: string): Promise<Uint8Array> {
  const auth = { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = (await (await fetch(`${graph()}/${mediaId}`, { headers: auth })).json()) as { url?: string };
  if (!meta.url) throw new Error("WhatsApp didn't return the file");
  return new Uint8Array(await (await fetch(meta.url, { headers: auth })).arrayBuffer());
}

/** Meta signs each webhook body with the app secret: "sha256=<hex>". */
export function validWhatsAppSignature(rawBody: string, header: string | null, secret = process.env.WHATSAPP_APP_SECRET): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  return sameHex(createHmac("sha256", secret).update(rawBody).digest("hex"), header.slice(7));
}

const telegramApi = (method: string) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

/** Telegram Bot API. https://core.telegram.org/bots/api */
export const telegram: Channel = {
  id: "telegram",
  label: "Telegram",
  where: () => (process.env.TELEGRAM_BOT_NAME ? `@${process.env.TELEGRAM_BOT_NAME.replace(/^@/, "")}` : "your ALRO Telegram bot"),
  configured: () => !!process.env.TELEGRAM_BOT_TOKEN,
  async send(to, text) {
    for (const body of splitMessage(text)) await post(telegramApi("sendMessage"), {}, { chat_id: to, text: body });
  },
};

export async function telegramFile(fileId: string): Promise<Uint8Array> {
  const meta = (await (await fetch(`${telegramApi("getFile")}?file_id=${encodeURIComponent(fileId)}`)).json()) as { result?: { file_path?: string } };
  if (!meta.result?.file_path) throw new Error("Telegram didn't return the file");
  return new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`)).arrayBuffer());
}

/** A Slack app's direct messages (Events API). https://api.slack.com/apis/events-api */
export const slackDm: Channel = {
  id: "slack",
  label: "Slack",
  where: () => "the ALRO app in Slack (Apps → ALRO → Messages)",
  configured: () => !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_SIGNING_SECRET,
  async send(to, text) {
    for (const body of splitMessage(text)) await post("https://slack.com/api/chat.postMessage", { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, { channel: to, text: body });
  },
};

/** A file shared in a direct message with the app; Slack needs the bot token (files:read) to download it. */
export async function slackFile(url: string): Promise<Uint8Array> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !/(^|\.)slack\.com$/.test(u.hostname)) throw new Error("Not a Slack file link");
  const res = await fetch(u, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  if (!res.ok) throw new Error(`Slack file download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Slack signs "v0:<timestamp>:<body>" with the signing secret; stale timestamps are replays. */
export function validSlackSignature(rawBody: string, timestamp: string | null, signature: string | null, now = Date.now(), secret = process.env.SLACK_SIGNING_SECRET): boolean {
  if (!secret || !timestamp || !signature?.startsWith("v0=")) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return sameHex(createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex"), signature.slice(3));
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Microsoft Teams, as a personal chat with the ALRO bot. */
export const teamsBot: Channel = {
  id: "teams",
  label: "Teams",
  where: () => "the ALRO app in Teams (Apps → ALRO → Chat)",
  configured: teamsBotConfigured,
  async send(_to, text, address) {
    if (!address?.serviceUrl || !address.conversationId) throw new Error("No Teams conversation to send to yet: message the bot once first");
    await sendTeams(address as unknown as TeamsAddress, text);
  },
};

export const CHANNELS: Record<ChannelId, Channel> = { whatsapp, telegram, slack: slackDm, teams: teamsBot };
