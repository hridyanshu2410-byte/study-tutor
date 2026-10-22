import { loadStudy, requireAdmin } from "@/lib/research";
import { researchMode } from "@/lib/supabase/env";
import { toCsv } from "@/lib/study";

// CSV exports for analysis, keyed by participant code; emails never leave the database.
export async function GET(req: Request) {
  if (!researchMode) return new Response("Not found", { status: 404 });
  const db = await requireAdmin();
  if (!db) return new Response("Forbidden", { status: 403 });
  const which = new URL(req.url).searchParams.get("table");
  const study = await loadStudy(db);
  const [rows, name] = which === "events" ? [study.events, "events"] : [study.participants, "participants"];
  const columns = rows.length ? Object.keys(rows[0]) : ["participant"];
  const date = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows as Record<string, unknown>[], columns), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tutor-study-${name}-${date}.csv"`,
    },
  });
}
