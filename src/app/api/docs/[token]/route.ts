import { documentByToken, renderPdf } from "@/business/documents";
import { getDb } from "@/db/client";
import { limitKey, rateLimit } from "@/platform/rate-limit";

interface Params {
  params: Promise<{ token: string }>;
}

/** A quote or invoice, opened by the customer from the link in their message. The unguessable token is the only key. */
export async function GET(request: Request, { params }: Params) {
  const { token } = await params;
  const db = getDb();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (!(await rateLimit(db, limitKey("docs", ip), 60, 3600)).ok) return new Response("Slow down", { status: 429, headers: { "retry-after": "600" } });
  const doc = /^[\w-]{20,64}$/.test(token) ? await documentByToken(db, token) : undefined;
  if (!doc || doc.status === "void") return new Response("Not found", { status: 404 });
  const pdf = await renderPdf(db, doc);
  return new Response(Buffer.from(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${doc.number}.pdf"`, "cache-control": "private, no-store", "x-robots-tag": "noindex" },
  });
}
