import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LADDER, TUTOR_SYSTEM_PROMPT, TutorTurnSchema, type PublicTurn, type TutorRequest, type TutorTurn } from "@/lib/tutor";

const client = new Anthropic();

type SessionMemory = { turns: { trigger: string; speech: string | null; turn: TutorTurn }[] };

// MVP memory: in-process, per session. Moves to Postgres with accounts in phase 2.
const sessions = new Map<string, SessionMemory>();

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "The tutor needs ANTHROPIC_API_KEY in .env.local" }, { status: 500 });
  }
  const body = (await req.json()) as TutorRequest;
  const match = /^data:image\/png;base64,(.+)$/.exec(body.pageImage ?? "");
  if (!body.sessionId || !match) {
    return Response.json({ error: "sessionId and a PNG pageImage are required" }, { status: 400 });
  }

  const memory = sessions.get(body.sessionId) ?? { turns: [] };
  sessions.set(body.sessionId, memory);

  const lastRung = [...memory.turns].reverse().find((t) => LADDER.includes(t.turn.move))?.turn.move ?? "wait";
  const history = memory.turns
    .slice(-12)
    .map(
      (t, i) =>
        `Turn ${i + 1} (${t.trigger})${t.speech ? `, student said: "${t.speech}"` : ""}\n` +
        `  you chose ${t.turn.move}; said: "${t.turn.say}"; wrote: ${t.turn.write ?? "nothing"}; ` +
        `mark: ${t.turn.mark ? `${t.turn.mark.kind} on ${t.turn.mark.line_id}` : "none"}\n` +
        `  private diagnosis then: ${t.turn.private.diagnosis}`,
    )
    .join("\n");

  const situation = [
    `Problem the student is working on: ${body.problem.trim() || "not stated; infer it from the page"}`,
    `Lines on the page: ${body.lines.map((l) => l.id).join(", ") || "none yet"}`,
    history ? `Earlier turns this session:\n${history}` : "This is the first turn of the session.",
    `Last hint-ladder rung used: ${lastRung}`,
    body.trigger === "pause"
      ? "The student has paused writing."
      : body.trigger === "asked"
        ? "The student tapped to ask for your help."
        : `The student just said: "${body.speech ?? ""}"`,
  ].join("\n\n");

  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(TutorTurnSchema) },
      system: TUTOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: match[1] } },
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
    if (turn.mark && !known.has(turn.mark.line_id)) turn.mark = null;
    memory.turns.push({ trigger: body.trigger, speech: body.speech, turn });

    const publicTurn: PublicTurn = { move: turn.move, say: turn.say, write: turn.write, mark: turn.mark };
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
  return { move: "ask_plan", say, write: null, mark: null };
}
