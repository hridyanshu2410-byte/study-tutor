import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { adminClient, createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { dailyTutorLimit, startOfUtcDay } from "@/lib/study";
import { LADDER, REVIEW_PROMPT, TUTOR_SYSTEM_PROMPT, TutorTurnSchema, type PublicTurn, type TutorRequest, type TutorTurn } from "@/lib/tutor";

const client = new Anthropic();

// What the tutor remembers of earlier turns in a session.
type PastTurn = { trigger: string; speech: string | null; move: TutorTurn["move"]; say: string; ink: string; diagnosis: string };

// Without accounts, sessions live in this process. In research mode they are
// read back from the event log, so they survive across serverless instances.
const sessions = new Map<string, PastTurn[]>();

async function pastTurns(db: ReturnType<typeof adminClient> | null, userId: string | null, sessionId: string): Promise<PastTurn[]> {
  if (!db || !userId) return sessions.get(sessionId) ?? [];
  const { data } = await db
    .from("events")
    .select("data")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .eq("kind", "tutor_turn")
    .order("id", { ascending: false })
    .limit(12);
  return (data ?? []).map((r) => r.data as PastTurn).reverse();
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "The tutor needs ANTHROPIC_API_KEY in .env.local" }, { status: 500 });
  }
  // In research mode only signed-in testers reach the tutor, within a daily cap.
  // Testers can't read the event log (it holds the tutor's private
  // diagnosis), so the server counts and writes tutor turns with the service role.
  const supabase = researchMode ? adminClient() : null;
  let userId: string | null = null;
  if (supabase) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return Response.json({ error: "Please sign in again." }, { status: 401 });
    userId = user.id;
    const { count } = await supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("kind", "tutor_turn")
      .gte("created_at", startOfUtcDay(new Date()));
    if ((count ?? 0) >= dailyTutorLimit()) {
      return Response.json(fallbackTurn("That's a lot of great work for one day. I need a rest; let's pick this up tomorrow."), {
        status: 429,
      });
    }
  }

  const body = (await req.json()) as TutorRequest;
  const png = (url: string | undefined) => /^data:image\/png;base64,(.+)$/.exec(url ?? "")?.[1];
  const page = png(body.pageImage);
  const tokens = png(body.tokenImage);
  if (!body.sessionId || !page || !tokens) {
    return Response.json({ error: "sessionId, pageImage and tokenImage (PNG) are required" }, { status: 400 });
  }

  const reviewing = body.mode === "review" && body.review != null;
  const reference = reviewing ? png(body.review?.answerImage ?? undefined) : undefined;
  const weakSpots = (body.weakSpots ?? []).slice(0, 5).map((w) => String(w).slice(0, 60));

  const past = await pastTurns(supabase, userId, body.sessionId);
  const lastRung = [...past].reverse().find((t) => LADDER.includes(t.move))?.move ?? "wait";
  const history = past
    .slice(-12)
    .map(
      (t, i) =>
        `Turn ${i + 1} (${t.trigger})${t.speech ? `, student said: "${t.speech}"` : ""}\n` +
        `  you chose ${t.move}; said: "${t.say}"; ink: ${t.ink}\n` +
        `  private diagnosis then: ${t.diagnosis}`,
    )
    .join("\n");

  const situation = [
    reviewing
      ? `Review card (concept: ${body.review!.concept}). The question: ${body.problem.trim()}` +
        (body.review!.answerText ? `\nReference answer from the student's card: ${body.review!.answerText.slice(0, 2000)}` : "") +
        (reference ? "\nThe reference answer is the ink in the last image." : "")
      : `Problem the student is working on: ${body.problem.trim() || "not stated; infer it from the page"}`,
    weakSpots.length ? `Concepts this student has slipped on before: ${weakSpots.join(", ")}` : "",
    `Lines on the page: ${body.lines.map((l) => `${l.id} (${l.tokens} tokens)`).join(", ") || "none yet"}`,
    history ? `Earlier turns this session:\n${history}` : "This is the first turn of the session.",
    `Last hint-ladder rung used: ${lastRung}`,
    body.trigger === "pause"
      ? "The student has paused writing."
      : body.trigger === "asked"
        ? "The student tapped to ask for your help."
        : `The student just said: "${body.speech ?? ""}"`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const started = Date.now();
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(TutorTurnSchema) },
      system: reviewing ? `${TUTOR_SYSTEM_PROMPT}\n\n${REVIEW_PROMPT}` : TUTOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "The student's page:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: page } },
            { type: "text", text: "The same page with line ids and numbered tokens:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: tokens } },
            ...(reference
              ? [
                  { type: "text" as const, text: "The reference answer the student kept on their card:" },
                  { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: reference } },
                ]
              : []),
            { type: "text", text: situation },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return Response.json(fallbackTurn("Let's look at this together. What are you trying to do on this line?"));
    }

    const turn = response.parsed_output;
    const known = new Set(body.lines.map((l) => l.id));
    turn.annotations = turn.annotations.filter((a) => known.has(a.line_id) || a.kind === "note").slice(0, 4);
    if (reviewing) turn.card = null;
    else turn.review_result = null;
    turn.skill.concept = turn.skill.concept.slice(0, 60);
    const record: PastTurn = {
      trigger: body.trigger,
      speech: body.speech,
      move: turn.move,
      say: turn.say,
      ink: describeInk(turn),
      diagnosis: turn.private.diagnosis,
    };
    if (!supabase) sessions.set(body.sessionId, [...past, record].slice(-12));

    if (supabase && userId) {
      // The study log keeps what the tutor did and why, never the hidden solution.
      const { error } = await supabase.from("events").insert({
        user_id: userId,
        session_id: body.sessionId,
        kind: "tutor_turn",
        data: {
          ...record,
          mode: reviewing ? "review" : "study",
          problem: body.problem.slice(0, 500),
          lines: body.lines.length,
          annotations: turn.annotations.map((a) => a.kind),
          concept: turn.skill.concept,
          evidence: turn.skill.evidence,
          card_proposed: Boolean(turn.card),
          review_result: turn.review_result,
          first_error_line: turn.private.first_error_line,
          latency_ms: Date.now() - started,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      });
      if (error) console.warn("Could not log tutor turn", error.message);
    }

    const publicTurn: PublicTurn = {
      move: turn.move,
      say: turn.say,
      annotations: turn.annotations,
      skill: turn.skill,
      card: turn.card,
      review_result: turn.review_result,
    };
    return Response.json(publicTurn);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "Set ANTHROPIC_API_KEY in .env.local" }, { status: 500 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return Response.json(fallbackTurn("Give me a second, then ask me again."), { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      return Response.json({ error: `Tutor service error ${err.status}` }, { status: 502 });
    }
    throw err;
  }
}

function fallbackTurn(say: string): PublicTurn {
  return { move: "ask_plan", say, annotations: [], skill: { concept: "", evidence: "none" }, card: null, review_result: null };
}

function describeInk(turn: TutorTurn): string {
  if (!turn.annotations.length) return "none";
  return turn.annotations
    .map((a) => {
      const where = a.from_token == null ? a.line_id : `${a.line_id} tokens ${a.from_token}-${a.to_token ?? a.from_token}`;
      return a.kind === "note" ? `note "${a.text}" near ${where}` : `${a.kind} on ${where}`;
    })
    .join(", ");
}
