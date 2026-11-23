import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createLead, leadTokenMatches } from "@/business/leads";
import { limitKey, rateLimit } from "@/platform/rate-limit";

interface Params {
  params: Promise<{ org: string; token: string }>;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...CORS, ...extra } });

export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });

/** The first string among these field names (a website form, IndiaMART, Meta lead ads and Zapier all name them differently). */
function pick(body: Record<string, unknown>, names: string[]): string | undefined {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n);
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
}

/**
 * A company's enquiry address: a website form, IndiaMART, a Meta lead ad or an automation posts here and the enquiry
 * becomes a lead with a reply waiting for approval. Protected by the token in the address.
 */
export async function POST(request: Request, { params }: Params) {
  const { org, token } = await params;
  const db = getDb();
  if (!/^[0-9a-f-]{36}$/.test(org) || !leadTokenMatches(org, token)) return reply({ error: "Not found" }, 404);
  const [exists] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, org));
  if (!exists) return reply({ error: "Not found" }, 404);
  if (!(await rateLimit(db, limitKey("leads", org), 120, 3600)).ok) return reply({ error: "Slow down" }, 429, { "retry-after": "600" });

  let body: Record<string, unknown> = {};
  try {
    const type = request.headers.get("content-type") ?? "";
    body = type.includes("json") ? await request.json() : Object.fromEntries((await request.formData()).entries());
  } catch {
    return reply({ error: "Send JSON or a form." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Send JSON or a form." }, 400);

  const message = pick(body, ["message", "query_message", "enquiry", "inquiry", "comments", "details", "text"]);
  const name = pick(body, ["name", "sender_name", "full_name", "customer_name"]);
  const email = pick(body, ["email", "sender_email", "email_address"]);
  const phone = pick(body, ["phone", "mobile", "sender_mobile", "phone_number", "whatsapp"]);
  if (!message && !name && !email && !phone) return reply({ error: "Nothing to record." }, 400);
  const lead = await createLead(db, org, { source: pick(body, ["source"]) ?? "web", externalId: pick(body, ["id", "unique_query_id", "lead_id", "submission_id"]), name, email, phone, message: message ?? "(no message)" });
  return reply({ ok: true, duplicate: !lead });
}
