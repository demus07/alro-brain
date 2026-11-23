import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { pushAndProcess, receiveGmailPush, receivePush, type PushResult } from "@/connectors/push";
import { getDb } from "@/db/client";

export const maxDuration = 120;

interface Params {
  params: Promise<{ connection: string; token: string }>;
}

const refuse = (result: Exclude<PushResult, "accepted">) =>
  result === "limited" ? new Response("Slow down", { status: 429, headers: { "retry-after": "60" } }) : new Response("Not found", { status: result === "forbidden" ? 403 : 404 });

/** A source checking that the address answers. */
export async function GET(request: Request, { params }: Params) {
  const { connection, token } = await params;
  const result = connection === "gmail" ? (await receiveGmailPush(getDb(), token, undefined)).result : await receivePush(getDb(), connection, token);
  if (result !== "accepted") return refuse(result);
  return new Response(new URL(request.url).searchParams.get("validationToken") ?? "ok", { headers: { "content-type": "text/plain" } });
}

/**
 * A source saying something changed. Nothing in the body is used except to name a Gmail mailbox and to answer
 * the two handshakes (Microsoft's validation token, Slack's challenge): the connection is synced after the
 * 200 through its own credentials, so a forged call can only cause an extra sync.
 */
export async function POST(request: Request, { params }: Params) {
  const { connection, token } = await params;
  const db = getDb();
  const url = new URL(request.url);
  const raw = await request.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }

  const ids: string[] = [];
  if (connection === "gmail") {
    const r = await receiveGmailPush(db, token, body);
    if (r.result !== "accepted") return refuse(r.result);
    ids.push(...r.connectionIds);
  } else {
    const result = await receivePush(db, connection, token);
    if (result !== "accepted") return refuse(result);
    // Microsoft Graph sends a validation token when a subscription is created and wants it back as plain text.
    const validation = url.searchParams.get("validationToken");
    if (validation) return new Response(validation, { headers: { "content-type": "text/plain" } });
    // Slack asks once for a challenge when the request URL is saved.
    if (body && typeof body === "object" && (body as { type?: string }).type === "url_verification") return Response.json({ challenge: (body as { challenge?: string }).challenge });
    ids.push(connection);
  }

  if (ids.length) {
    after(async () => {
      const models = defaultModels();
      for (const id of ids) await pushAndProcess(db, id, models);
    });
  }
  return Response.json({ ok: true });
}
