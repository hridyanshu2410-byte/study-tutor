import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { adminClient, createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { dailyTutorLimit, startOfUtcDay } from "@/lib/study";
import { allowedMoves, LADDER, REVIEW_PROMPT, TUTOR_SYSTEM_PROMPT, tutorTurnSchema, type PublicTurn, type TutorRequest, type TutorTurn } from "@/lib/tutor";

// The tutor runs on Claude when ANTHROPIC_API_KEY is set, otherwise on OpenAI
// (OPENAI_TUTOR_MODEL, default GPT-6 Luna). TUTOR_PROVIDER forces one.
const provider: "anthropic" | "openai" =
  process.env.TUTOR_PROVIDER === "openai" || process.env.TUTOR_PROVIDER === "anthropic"
    ? process.env.TUTOR_PROVIDER
    : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "openai";
const openaiModel = process.env.OPENAI_TUTOR_MODEL || "gpt-6-luna";
const client = provider === "anthropic" ? new Anthropic() : null;
const openai = provider === "openai" && process.env.OPENAI_API_KEY ? new OpenAI() : null;

type Ask = { schema: ReturnType<typeof tutorTurnSchema>; system: string; page: string; tokens: string; reference?: string; situation: string };
type Answer = { turn: TutorTurn | null; usage: { input: number; output: number } };

async function askTutor(a: Ask): Promise<Answer> {
  if (provider === "openai") {
    const png = (data: string) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } });
    const res = await openai!.chat.completions.parse({
      model: openaiModel,
      response_format: zodResponseFormat(a.schema, "tutor_turn"),
      messages: [
        { role: "system", content: a.system },
        {
          role: "user",
          content: [
            { type: "text", text: "The student's page:" },
            png(a.page),
            { type: "text", text: "The same page with line ids and numbered tokens:" },
            png(a.tokens),
            ...(a.reference ? [{ type: "text" as const, text: "The reference answer the student kept on their card:" }, png(a.reference)] : []),
            { type: "text", text: a.situation },
          ],
        },
      ],
    });
    const choice = res.choices[0];
    return {
      turn: choice?.message.refusal ? null : (choice?.message.parsed ?? null),
      usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
    };
  }
  const response = await client!.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(a.schema) },
    system: a.system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "The student's page:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: a.page } },
          { type: "text", text: "The same page with line ids and numbered tokens:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: a.tokens } },
          ...(a.reference
            ? [
                { type: "text" as const, text: "The reference answer the student kept on their card:" },
                { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: a.reference } },
              ]
            : []),
          { type: "text", text: a.situation },
        ],
      },
    ],
  });
  return {
    turn: response.stop_reason === "refusal" ? null : response.parsed_output,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

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
  if (provider === "anthropic" ? !process.env.ANTHROPIC_API_KEY : !openai) {
    return Response.json(
      { error: provider === "anthropic" ? "The tutor needs ANTHROPIC_API_KEY in .env.local" : "The tutor needs OPENAI_API_KEY in .env.local" },
      { status: 500 },
    );
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
    body.idleSeconds != null ? `The student last wrote ${Math.round(body.idleSeconds)} seconds ago.` : "",
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
    const { turn, usage } = await askTutor({
      schema: tutorTurnSchema(allowedMoves(lastRung)),
      system: reviewing ? `${TUTOR_SYSTEM_PROMPT}\n\n${REVIEW_PROMPT}` : TUTOR_SYSTEM_PROMPT,
      page,
      tokens,
      reference,
      situation,
    });

    if (!turn) {
      return Response.json(fallbackTurn("Let's look at this together. What are you trying to do on this line?"));
    }

    const known = new Set(body.lines.map((l) => l.id));
    turn.annotations = turn.annotations.filter((a) => known.has(a.line_id) || a.kind === "note").slice(0, 4);
    if (reviewing) turn.card = null;
    else turn.review_result = null;
    turn.skill.concept = turn.skill.concept.slice(0, 60);
    turn.draw = turn.move === "wait" ? [] : turn.draw.slice(0, 2);
    turn.write = turn.move === "wait" ? [] : turn.write.map((w) => w.trim().slice(0, 48)).filter(Boolean).slice(0, 4);
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
          model: provider === "openai" ? openaiModel : "claude-opus-5-5",
          input_tokens: usage.input,
          output_tokens: usage.output,
        },
      });
      if (error) console.warn("Could not log tutor turn", error.message);
    }

    const publicTurn: PublicTurn = {
      move: turn.move,
      say: turn.say,
      write: turn.write,
      draw: turn.draw,
      annotations: turn.annotations,
      skill: turn.skill,
      card: turn.card,
      review_result: turn.review_result,
    };
    return Response.json(publicTurn);
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      return Response.json({ error: "Check OPENAI_API_KEY in .env.local" }, { status: 500 });
    }
    if (err instanceof OpenAI.RateLimitError) {
      return Response.json(fallbackTurn("Give me a second, then ask me again."), { status: 429 });
    }
    if (err instanceof OpenAI.APIError) {
      console.warn("OpenAI tutor error", err.status, err.message);
      return Response.json({ error: `Tutor service error ${err.status}` }, { status: 502 });
    }
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
  return { move: "ask_plan", say, write: [], draw: [], annotations: [], skill: { concept: "", evidence: "none" }, card: null, review_result: null };
}

function describeInk(turn: TutorTurn): string {
  const wrote = turn.write.length ? `wrote below the work: ${turn.write.map((w) => `"${w}"`).join(", ")}` : "";
  const drew = turn.draw.map(describeFigure).join(", ");
  if (!turn.annotations.length) return [wrote, drew].filter(Boolean).join(", ") || "none";
  return [wrote, drew, ...turn.annotations
    .map((a) => {
      const where = a.from_token == null ? a.line_id : `${a.line_id} tokens ${a.from_token}-${a.to_token ?? a.from_token}`;
      return a.kind === "note" ? `note "${a.text}" near ${where}` : `${a.kind} on ${where}`;
    })]
    .filter(Boolean)
    .join(", ");
}

function describeFigure(f: TutorTurn["draw"][number]): string {
  if (f.kind === "graph") return `drew a graph of ${f.curves.map((c) => c.formula).join(" and ") || "points"}`;
  if (f.kind === "number_line") return `drew a number line from ${f.from} to ${f.to}`;
  if (f.kind === "shape") return `drew a shape ${f.vertices.map((v) => v.label ?? "").join("")}`.trim();
  if (f.kind === "flow") return `drew a flow: ${f.nodes.map((n) => n.text).join(" → ")}`;
  if (f.kind === "table") return `drew a table: ${f.rows.map((r) => r.join(" | ")).join(" / ")}`;
  if (f.kind === "forces") return `drew a force diagram: ${f.forces.map((x) => x.label).join(", ")}`;
  return `wrote steps: ${f.lines.map((l) => l.math).join(" ; ")}`;
}
