import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { secrets } from "@/db/schema";

/**
 * Connector tokens and live-tool sign-ins are stored encrypted with AES-256-GCM.
 * The key is ALRO_SECRET_KEY: 32 random bytes, base64 (`openssl rand -base64 32`).
 * Losing the key means reconnecting every source; nothing else is lost.
 */
function key(): Buffer {
  const raw = process.env.ALRO_SECRET_KEY;
  if (!raw) throw new Error("Set ALRO_SECRET_KEY in .env.local (openssl rand -base64 32) to connect sources.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ALRO_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  return buf;
}

export const secretsConfigured = () => !!process.env.ALRO_SECRET_KEY;

const b64 = (b: Buffer) => b.toString("base64url");

/** Encrypts any JSON value: "v1.<iv>.<tag>.<ciphertext>". */
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function unseal<T>(sealed: string): T {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")) as T;
}

/** A tamper-proof, expiring token for round trips through a browser (OAuth `state`). Not encrypted. */
export function sign(payload: Record<string, unknown>, ttlMs: number, now = Date.now()): string {
  const body = b64(Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })));
  return `${body}.${b64(createHmac("sha256", key()).update(body).digest())}`;
}

export function verify<T extends Record<string, unknown>>(token: string | null | undefined, now = Date.now()): T | undefined {
  const [body, mac] = (token ?? "").split(".");
  if (!body || !mac) return undefined;
  const expected = createHmac("sha256", key()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
  return payload.exp > now ? payload : undefined;
}

export type SecretKind = "connection" | "mcp";

export async function saveSecret(db: Db, orgId: string, kind: SecretKind, refId: string, value: unknown) {
  const data = seal(value);
  await db
    .insert(secrets)
    .values({ orgId, kind, refId, data })
    .onConflictDoUpdate({ target: [secrets.kind, secrets.refId], set: { data, updatedAt: new Date() } });
}

export async function readSecret<T>(db: Db, kind: SecretKind, refId: string): Promise<T | undefined> {
  const [row] = await db.select({ data: secrets.data }).from(secrets).where(and(eq(secrets.kind, kind), eq(secrets.refId, refId)));
  return row ? unseal<T>(row.data) : undefined;
}

export async function deleteSecret(db: Db, kind: SecretKind, refId: string) {
  await db.delete(secrets).where(and(eq(secrets.kind, kind), eq(secrets.refId, refId)));
}
