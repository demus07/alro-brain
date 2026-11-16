import { headers } from "next/headers";

/**
 * This deployment's public address, for links in emails and invitations. In production it must
 * come from ALRO_APP_URL: the request's Host header is whatever the caller says it is, and a link
 * built from it could send someone's reset token to another site. Development falls back to
 * where the request came in.
 */
export async function appOrigin(): Promise<string> {
  if (process.env.ALRO_APP_URL) return process.env.ALRO_APP_URL.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") throw new Error("Set ALRO_APP_URL to this deployment's public address (https://…) so links in emails point at it.");
  const h = await headers();
  return `http://${h.get("host") ?? "localhost:3000"}`;
}
