import "server-only";
import { adminClient, createClient, isAdmin } from "./supabase/server";

export async function requireAdmin() {
  const {
    data: { user },
  } = await (await createClient()).auth.getUser();
  return user && isAdmin(user.email) ? adminClient() : null;
}

type Profile = { id: string; participant_code: string; consented_at: string | null; intake: Record<string, unknown>; created_at: string };
type EventRow = { id: number; user_id: string; session_id: string | null; kind: string; data: Record<string, unknown>; created_at: string };

// Reads every row in pages, since PostgREST caps a single response.
async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

export async function loadStudy(db: ReturnType<typeof adminClient>) {
  const profiles = await all<Profile>((a, b) =>
    db.from("profiles").select("id, participant_code, consented_at, intake, created_at").order("created_at").range(a, b),
  );
  const events = await all<EventRow>((a, b) =>
    db.from("events").select("id, user_id, session_id, kind, data, created_at").order("id").range(a, b),
  );
  const code = new Map(profiles.map((p) => [p.id, p.participant_code]));

  const participants = profiles.map((p) => {
    const mine = events.filter((e) => e.user_id === p.id);
    const turns = mine.filter((e) => e.kind === "tutor_turn");
    return {
      participant: p.participant_code,
      joined: p.created_at,
      consented: p.consented_at,
      level: p.intake?.level ?? "",
      course: p.intake?.course ?? "",
      ai_use: p.intake?.aiUse ?? "",
      sessions: new Set(turns.map((e) => e.session_id)).size,
      tutor_turns: turns.length,
      spoken_turns: turns.filter((e) => e.data.move !== "wait").length,
      cards_created: mine.filter((e) => e.kind === "card_created").length,
      reviews: mine.filter((e) => e.kind === "review_graded" && !e.data.skipped).length,
      feedback: mine.filter((e) => e.kind === "feedback").length,
      input_tokens: turns.reduce((n, e) => n + Number(e.data.input_tokens ?? 0), 0),
      output_tokens: turns.reduce((n, e) => n + Number(e.data.output_tokens ?? 0), 0),
      last_active: mine.at(-1)?.created_at ?? "",
    };
  });

  const eventRows = events.map((e) => ({
    id: e.id,
    participant: code.get(e.user_id) ?? "",
    session: e.session_id ?? "",
    kind: e.kind,
    at: e.created_at,
    data: e.data,
  }));

  const feedback = eventRows.filter((e) => e.kind === "feedback").reverse();
  return { participants, events: eventRows, feedback };
}
