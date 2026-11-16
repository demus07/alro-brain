/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a secret the
 * jobs only run in development.
 */
export function cronUnauthorized(request: Request): Response | undefined {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === "production" ? Response.json({ error: "CRON_SECRET is not set" }, { status: 500 }) : undefined;
  }
  return request.headers.get("authorization") === `Bearer ${secret}` ? undefined : Response.json({ error: "Unauthorized" }, { status: 401 });
}
