import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { trackers } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { rowsOf, toCsv } from "@/work/trackers";

/** A tracker as a spreadsheet. Only its owner can download it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  const db = getDb();
  const [t] = await db.select().from(trackers).where(and(eq(trackers.id, id), eq(trackers.personId, viewer.personId)));
  if (!t) return Response.json({ error: "Not found" }, { status: 404 });
  const rows = await rowsOf(db, viewer, t.id, { limit: 50_000 });
  const name = t.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new Response(toCsv(t.columns, rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
}
