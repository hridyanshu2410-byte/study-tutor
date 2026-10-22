import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LADDER, REVIEW_PROMPT, TUTOR_SYSTEM_PROMPT, TutorTurnSchema, type PublicTurn, type TutorRequest, type TutorTurn } from "@/lib/tutor";

const client = new Anthropic();

type SessionMemory = { turns: { trigger: string; speech: string | null; turn: TutorTurn }[] };

// MVP memory: in-process, per session. Moves to Postgres with accounts in phase 2.
const sessions = new Map<string, SessionMemory>();

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "The tutor needs ANTHROPIC_API_KEY in .env.local" }, { status: 500 });
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

  const memory = sessions.get(body.sessionId) ?? { turns: [] };
  sessions.set(body.sessionId, memory);

  const lastRung = [...memory.turns].reverse().find((t) => LADDER.includes(t.turn.move))?.turn.move ?? "wait";
  const history = memory.turns
    .slice(-12)
    .map(
      (t, i) =>
        `Turn ${i + 1} (${t.trigger})${t.speech ? `, student said: "${t.speech}"` : ""}\n` +
        `  you chose ${t.turn.move}; said: "${t.turn.say}"; ink: ${describeInk(t.turn)}\n` +
        `  private diagnosis then: ${t.turn.private.diagnosis}`,
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
    memory.turns.push({ trigger: body.trigger, speech: body.speech, turn });

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
