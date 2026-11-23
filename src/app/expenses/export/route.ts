import { expensesCsv } from "@/business/expenses";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";

/** The expenses as a spreadsheet for the accountant: /expenses/export?from=2026-04-01&to=2027-03-31 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return new Response("Only an admin can export expenses.", { status: 403 });
  const q = new URL(request.url).searchParams;
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(q.get(k) ?? "") ? (q.get(k) as string) : undefined);
  const csv = await expensesCsv(getDb(), viewer.orgId, { from: day("from"), to: day("to") });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="expenses.csv"`, "cache-control": "private, no-store" } });
}
