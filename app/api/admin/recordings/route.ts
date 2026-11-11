import { requireAdmin } from "@/lib/research";
import { researchMode } from "@/lib/supabase/env";

const BUCKET = "recordings";

// Researchers only: the session recordings in the private bucket, by
// participant code, each file with a link that works for an hour. Audio is
// never listed anywhere else.
export async function GET() {
  if (!researchMode) return new Response("Not found", { status: 404 });
  const db = await requireAdmin();
  if (!db) return new Response("Forbidden", { status: 403 });
  const { data: profiles } = await db.from("profiles").select("id, participant_code");
  const codeOf = new Map((profiles ?? []).map((p: { id: string; participant_code: string }) => [p.id, p.participant_code]));
  const store = db.storage.from(BUCKET);
  const { data: users, error } = await store.list("", { limit: 1000 });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const sessions: { participant: string; user: string; session: string; updated: string | null; files: { name: string; url: string | null }[] }[] = [];
  for (const u of users ?? []) {
    const { data: list } = await store.list(u.name, { limit: 1000, sortBy: { column: "updated_at", order: "desc" } });
    for (const s of list ?? []) {
      const { data: files } = await store.list(`${u.name}/${s.name}`, { limit: 50 });
      const paths = (files ?? []).map((f) => `${u.name}/${s.name}/${f.name}`);
      const { data: signed } = paths.length ? await store.createSignedUrls(paths, 3600) : { data: [] };
      sessions.push({
        participant: codeOf.get(u.name) ?? "unknown",
        user: u.name,
        session: s.name,
        updated: (files ?? []).map((f) => f.updated_at ?? "").sort().at(-1) || null,
        files: (files ?? []).map((f, i) => ({ name: f.name, url: signed?.[i]?.signedUrl ?? null })),
      });
    }
  }
  sessions.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return Response.json({ sessions });
}
