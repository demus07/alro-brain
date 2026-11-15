import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import { splitMessage } from "./split";

/**
 * Microsoft Teams, through an Azure Bot (Bot Framework). Teams posts each message to
 * /api/channels/teams with a signed token; replies and unprompted messages go back to
 * the conversation's service URL with the bot's own token.
 * https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */
const appId = () => process.env.MICROSOFT_BOT_APP_ID;
const tenant = () => process.env.MICROSOFT_BOT_TENANT_ID;

export const teamsBotConfigured = () => !!appId() && !!process.env.MICROSOFT_BOT_APP_PASSWORD;

/** Where a conversation lives; kept so ALRO can message someone later (a brief, an approval). */
export interface TeamsAddress {
  serviceUrl: string;
  conversationId: string;
}

export interface TeamsActivity {
  type: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id: string; aadObjectId?: string; name?: string };
  conversation?: { id: string; conversationType?: string; tenantId?: string };
  attachments?: { contentType: string; contentUrl?: string; name?: string; content?: { downloadUrl?: string; fileType?: string } }[];
}

// --- Verifying what Teams sends -------------------------------------------------------

/** Teams messages reach the bot through the Bot Framework service, which signs them as this issuer. */
const BOT_FRAMEWORK = { metadata: "https://login.botframework.com/v1/.well-known/openidconfiguration", issuer: "https://api.botframework.com" };

const keyCache = new Map<string, { keys: (JsonWebKey & { kid?: string })[]; at: number }>();
const KEY_TTL_MS = 12 * 60 * 60 * 1000;

async function signingKeys(metadataUrl: string, fetcher: typeof fetch, fresh = false) {
  const cached = keyCache.get(metadataUrl);
  if (!fresh && cached && Date.now() - cached.at < KEY_TTL_MS) return cached.keys;
  const meta = (await (await fetcher(metadataUrl)).json()) as { jwks_uri: string };
  const jwks = (await (await fetcher(meta.jwks_uri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  keyCache.set(metadataUrl, { keys: jwks.keys, at: Date.now() });
  return jwks.keys;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Checks the bearer token on an incoming activity: signed by the Bot Framework service, meant for
 * this bot, unexpired, and issued for exactly the service URL the activity says to reply to (the
 * activity body itself isn't signed, so that claim is what stops a forged reply address).
 * Returns false for anything else.
 */
export async function verifyTeamsRequest(authorization: string | null, activity: TeamsActivity, opts: { now?: number; fetcher?: typeof fetch } = {}): Promise<boolean> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  const id = appId();
  if (!token || !id) return false;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return false;
  try {
    const header = decode(h);
    const claims = decode(p);
    if (header.alg !== "RS256") return false;
    if (claims.iss !== BOT_FRAMEWORK.issuer) return false;
    const fetcher = opts.fetcher ?? fetch;
    // Microsoft rotates keys: an unknown key id is worth one fresh look.
    const jwk = (await signingKeys(BOT_FRAMEWORK.metadata, fetcher)).find((k) => k.kid === header.kid) ?? (await signingKeys(BOT_FRAMEWORK.metadata, fetcher, true)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"))) return false;
    const now = (opts.now ?? Date.now()) / 1000;
    const SKEW = 300;
    if (claims.aud !== id) return false;
    if (typeof claims.exp !== "number" || claims.exp + SKEW < now) return false;
    if (typeof claims.nbf === "number" && claims.nbf - SKEW > now) return false;
    // Bot Framework tokens name the service URL they were issued for; missing or different is a forged reply address.
    if (typeof claims.serviceurl !== "string" || claims.serviceurl !== activity.serviceUrl) return false;
    return true;
  } catch {
    return false;
  }
}

// --- Sending --------------------------------------------------------------------------

let botToken: { value: string; expiresAt: number } | undefined;

async function token(): Promise<string> {
  if (botToken && botToken.expiresAt - Date.now() > 60_000) return botToken.value;
  const res = await fetch(`https://login.microsoftonline.com/${tenant() ?? "botframework.com"}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId() ?? "", client_secret: process.env.MICROSOFT_BOT_APP_PASSWORD ?? "", scope: "https://api.botframework.com/.default" }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Teams bot sign-in failed: ${body.error_description ?? res.status}`);
  botToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return botToken.value;
}

/** Only Microsoft's own bot service hosts get the bot's token (trafficmanager.net is shared, so only its Teams host). */
const SERVICE_HOSTS = /^(smba\.trafficmanager\.net|[a-z0-9.-]+\.botframework\.com|[a-z0-9.-]+\.botframework\.azure\.us|smba\.infra\.(gcc|gov)\.teams\.microsoft\.(com|us))$/;
export function checkServiceUrl(serviceUrl: string): URL {
  const u = new URL(serviceUrl);
  if (u.protocol !== "https:" || !SERVICE_HOSTS.test(u.hostname)) throw new Error(`Not a Teams service URL: ${u.host}`);
  return u;
}

export async function sendTeams(address: TeamsAddress, text: string): Promise<void> {
  const base = checkServiceUrl(address.serviceUrl);
  for (const part of splitMessage(text)) {
    const url = new URL(`v3/conversations/${encodeURIComponent(address.conversationId)}/activities`, base.href.endsWith("/") ? base : `${base.href}/`);
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text: part, textFormat: "plain" }),
    });
    if (!res.ok) throw new Error(`Teams ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** A photo or file someone sent the bot: images need the bot token, files come with a ready download link. */
export async function teamsAttachment(att: NonNullable<TeamsActivity["attachments"]>[number]): Promise<Uint8Array> {
  const pre = att.content?.downloadUrl;
  const url = new URL(pre ?? att.contentUrl ?? "");
  if (url.protocol !== "https:") throw new Error("Not an https link");
  // Files are pre-signed SharePoint/OneDrive links; images come from the bot service and need its token.
  if (pre && !/\.sharepoint\.com$/.test(url.hostname)) throw new Error(`Not a Teams file host: ${url.host}`);
  if (!pre && !/(\.botframework\.com|\.skype\.com|\.teams\.microsoft\.com)$/.test(url.hostname)) throw new Error(`Not a Teams file host: ${url.host}`);
  const headers: Record<string, string> = pre ? {} : { authorization: `Bearer ${await token()}` };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Teams file download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The message text without the bot's own @mention. */
export const teamsText = (a: TeamsActivity) =>
  (a.text ?? "")
    .replace(/<at>[^<]*<\/at>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
