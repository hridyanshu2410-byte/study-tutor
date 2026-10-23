import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { firstBreak } from "@/lib/check";
import { describeSim, sanitizeSim } from "@/lib/sims";
import { zodResponseFormat } from "openai/helpers/zod";
import { adminClient, createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { conditionOf, dailyTutorLimit, startOfUtcDay, type Condition } from "@/lib/study";
import { allowedMoves, EXPLAIN_PROMPT, LADDER, MOVES, PAPER_PROMPT, REVIEW_PROMPT, TUTOR_SYSTEM_PROMPT, tutorTurnSchema, type PublicTurn, type TutorRequest, type TutorTurn } from "@/lib/tutor";

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

// A page picture: PNG for plain ink, JPEG when a photo or PDF is under the ink.
type Pic = { data: string; type: "image/png" | "image/jpeg" };
type Ask = {
  schema: ReturnType<typeof tutorTurnSchema>;
  system: string;
  page: Pic;
  tokens: Pic;
  reference?: Pic;
  situation: string;
  // A paper being read together. It goes first, after the system prompt, so the
  // provider can cache it across turns.
  paperText?: string;
};
type Answer = { turn: TutorTurn | null; usage: { input: number; output: number } };

async function askTutor(a: Ask): Promise<Answer> {
  if (provider === "openai") {
    const png = (p: Pic) => ({ type: "image_url" as const, image_url: { url: `data:${p.type};base64,${p.data}` } });
    const res = await openai!.chat.completions.parse({
      model: openaiModel,
      response_format: zodResponseFormat(a.schema, "tutor_turn"),
      messages: [
        { role: "system", content: a.system },
        {
          role: "user",
          content: [
            ...(a.paperText ? [{ type: "text" as const, text: `The paper:\n${a.paperText}` }] : []),
            { type: "text", text: a.paperText ? "What is on the student's screen:" : "The student's page:" },
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
          ...(a.paperText ? [{ type: "text" as const, text: `The paper:\n${a.paperText}`, cache_control: { type: "ephemeral" as const } }] : []),
          { type: "text", text: a.paperText ? "What is on the student's screen:" : "The student's page:" },
          { type: "image", source: { type: "base64", media_type: a.page.type, data: a.page.data } },
          { type: "text", text: "The same page with line ids and numbered tokens:" },
          { type: "image", source: { type: "base64", media_type: a.tokens.type, data: a.tokens.data } },
          ...(a.reference
            ? [
                { type: "text" as const, text: "The reference answer the student kept on their card:" },
                { type: "image" as const, source: { type: "base64" as const, media_type: a.reference.type, data: a.reference.data } },
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
  let condition: Condition = "socratic";
  if (supabase) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return Response.json({ error: "Please sign in again." }, { status: 401 });
    userId = user.id;
    const { data: profile } = await supabase.from("profiles").select("condition").eq("id", user.id).maybeSingle();
    condition = conditionOf(profile?.condition);
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
  // The "on request" arm never glances unasked; the browser shouldn't send these, but don't spend a model call if it does.
  if (condition === "on_request" && body.trigger === "pause") return Response.json({ ...fallbackTurn(""), move: "wait" });
  const png = (url: string | undefined): Pic | undefined => {
    const m = /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec(url ?? "");
    return m ? { type: m[1] as Pic["type"], data: m[2] } : undefined;
  };
  const page = png(body.pageImage);
  const tokens = png(body.tokenImage);
  if (!body.sessionId || !page || !tokens) {
    return Response.json({ error: "sessionId, pageImage and tokenImage (PNG or JPEG) are required" }, { status: 400 });
  }

  const reviewing = body.mode === "review" && body.review != null;
  const explaining = condition === "explain" && !reviewing;
  const paper =
    !reviewing && body.paper && typeof body.paper.text === "string" && body.paper.text.trim()
      ? {
          title: String(body.paper.title ?? "").slice(0, 300),
          text: body.paper.text.slice(0, 160_000),
          truncated: Boolean(body.paper.truncated) || body.paper.text.length > 160_000,
          visible: (Array.isArray(body.paper.visiblePages) ? body.paper.visiblePages : []).filter(Number.isInteger).slice(0, 6),
          pointedAt: typeof body.paper.pointedAt === "string" && /^p\d+\.s\d+$/.test(body.paper.pointedAt) ? body.paper.pointedAt : null,
        }
      : null;
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
    paper
      ? `Reading the paper "${paper.title}". Pages on screen: ${paper.visible.join(", ") || "none (they are looking at the workspace)"}.` +
        (paper.truncated ? " Parts of the paper were left out of the text for length; if asked about them, say so and ask the student to scroll there." : "") +
        (paper.pointedAt ? ` The student is pointing at sentence ${paper.pointedAt} in the paper.` : "")
      : "",
    `Lines on the page: ${body.lines.map((l) => `${l.id} (${l.tokens} tokens)`).join(", ") || "none yet"}`,
    body.hasPhoto
      ? "The page has a photo or PDF of printed material (a worksheet, textbook page or notes) under the student's ink. Line ids and token boxes cover only the student's handwriting. Read the printed problems from the image; if several are printed and the student hasn't said or shown which one, ask which they're on."
      : "",
    history ? `Earlier turns this session:\n${history}` : "This is the first turn of the session.",
    `Last hint-ladder rung used: ${lastRung}`,
    body.idleSeconds != null ? `The student last wrote ${Math.round(body.idleSeconds)} seconds ago.` : "",
    body.focus ? `The student is pointing at line ${body.focus.line_id}${body.focus.token != null ? `, token ${body.focus.token}` : ""}.` : "",
    body.trigger === "pause"
      ? "The student has paused writing."
      : body.trigger === "asked"
        ? body.focus
          ? "The student double-tapped there to ask about it."
          : "The student tapped to ask for your help."
        : body.trigger === "wrap_up"
          ? "The student is ending the session. Wrap up."
          : body.trigger === "paper_opened"
            ? "The student just opened this paper. In one or two sentences, say what it is about and why it matters. Draw a diagram of the big picture (what goes in, what the method does, what comes out; or how the argument is built), highlight the sentence that states the main contribution, and ask what they already know or where they'd like to start."
          : body.trigger === "watched"
            ? `The student just played the simulation and watched it. What happened: ${String(body.watched ?? "").slice(0, 600)}. Compare it with any prediction they marked or said, and ask them to explain the difference or why it happened.`
            : `The student just said: "${body.speech ?? ""}"`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const started = Date.now();
  try {
    // A reply that breaks the turn's schema (a model ignoring the allowed
    // moves, say) counts as no reply, never as a crash.
    const ask = (extra = "") =>
      askTutor({
        schema: tutorTurnSchema(explaining || paper ? MOVES : allowedMoves(lastRung)),
        system: [TUTOR_SYSTEM_PROMPT, reviewing ? REVIEW_PROMPT : paper ? PAPER_PROMPT : explaining ? EXPLAIN_PROMPT : ""].filter(Boolean).join("\n\n"),
        paperText: paper?.text,
        page,
        tokens,
        reference,
        situation: situation + extra,
      }).catch((err): Answer => {
        if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) throw err;
        console.warn("Unusable tutor reply", err instanceof Error ? err.message.slice(0, 200) : err);
        return { turn: null, usage: { input: 0, output: 0 } };
      });
    let { turn, usage } = await ask();

    // A math checker reads the turn. If it disagrees with the tutor about the
    // student's work, or finds a slip in the tutor's own math, the tutor gets
    // one chance to look again before anything reaches the student.
    const flags = turn ? mathFlags(turn) : [];
    let retried = false;
    if (turn && flags.length) {
      retried = true;
      const second = await ask(
        `\n\nA math checker reviewed your answer and found:\n- ${flags.join("\n- ")}\nLook again. If the checker is right, fix your turn: a slip by the student is their first mistake, and a slip of yours must not reach the page. If you are sure you were right, keep your answer.`,
      );
      if (second.turn) turn = second.turn;
      usage = { input: usage.input + second.usage.input, output: usage.output + second.usage.output };
    }
    if (turn) stripBadMath(turn);

    if (!turn) {
      return Response.json(fallbackTurn("Let's look at this together. What are you trying to do on this line?"));
    }

    const known = new Set(body.lines.map((l) => l.id));
    turn.annotations = turn.annotations.filter((a) => known.has(a.line_id) || a.kind === "note").slice(0, 4);
    if (reviewing) turn.card = null;
    else turn.review_result = null;
    turn.skill.concept = turn.skill.concept.slice(0, 60);
    turn.draw = turn.move === "wait" ? [] : turn.draw.slice(0, 2);
    turn.write = turn.move === "wait" ? [] : turn.write.map((w) => w.trim().slice(0, paper ? 60 : 48)).filter(Boolean).slice(0, paper ? 6 : 4);
    // Only passages that exist in the paper can be pointed at.
    turn.highlights =
      turn.move === "wait" || !paper
        ? []
        : (turn.highlights ?? [])
            .filter((h) => /^p\d+\.s\d+$/.test(h.ref) && paper.text.includes(`[${h.ref}]`))
            .slice(0, 3)
            .map((h) => ({ ...h, note: h.note?.trim().slice(0, 40) || null }));
    turn.simulate = turn.move === "wait" || !turn.simulate ? null : sanitizeSim(turn.simulate);
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
          condition,
          has_photo: Boolean(body.hasPhoto),
          paper: paper?.title ?? null,
          problem: body.problem.slice(0, 500),
          lines: body.lines.length,
          annotations: turn.annotations.map((a) => a.kind),
          concept: turn.skill.concept,
          evidence: turn.skill.evidence,
          card_proposed: Boolean(turn.card),
          review_result: turn.review_result,
          first_error_line: turn.private.first_error_line,
          math_flags: flags,
          math_retried: retried,
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
      highlights: turn.highlights,
      simulate: turn.simulate,
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
  return { move: "ask_plan", say, write: [], draw: [], highlights: [], simulate: null, annotations: [], skill: { concept: "", evidence: "none" }, card: null, review_result: null };
}

function describeInk(turn: TutorTurn): string {
  const wrote = turn.write.length ? `wrote below the work: ${turn.write.map((w) => `"${w}"`).join(", ")}` : "";
  const drew = [
    ...turn.draw.map(describeFigure),
    ...(turn.simulate ? [`set up a ${describeSim(turn.simulate)}`] : []),
    ...(turn.highlights ?? []).map((h) => `${h.kind}ed ${h.ref}${h.note ? ` with margin note "${h.note}"` : ""}`),
  ].join(", ");
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
  if (f.kind === "diagram")
    return `drew a diagram: ${f.nodes.map((n) => n.text).join(", ")}; arrows ${f.edges.map((e) => `${e.from}→${e.to}`).join(", ")}`;
  if (f.kind === "bars") return `drew a bar chart${f.title ? ` "${f.title}"` : ""}: ${f.bars.map((b) => `${b.label} ${b.value}`).join(", ")}`;
  if (f.kind === "sketch") return `sketched ${f.title ?? "a drawing"}${f.labels.length ? ` labelled ${f.labels.map((l) => l.text).join(", ")}` : ""}`;
  return `wrote steps: ${f.lines.map((l) => l.math).join(" ; ")}`;
}

function mathFlags(turn: TutorTurn): string[] {
  const flags: string[] = [];
  const reading = turn.private.reading;
  const student = firstBreak(reading.map((r) => r.latex));
  if (student) {
    const id = reading[student.index].line_id;
    const said = turn.private.first_error_line;
    const saidAt = said ? reading.findIndex((r) => r.line_id === said) : -1;
    if (saidAt < 0 || saidAt > student.index) {
      flags.push(`On the student's page, ${student.detail} (line ${id}), but your first_error_line is ${said ?? "null"}. Check your reading of ${id} and the line before it.`);
    }
  }
  for (const f of turn.draw) {
    if (f.kind !== "steps") continue;
    const b = firstBreak(f.lines.map((l) => l.math));
    if (b) flags.push(`In the steps you drew, ${b.detail}.`);
  }
  const w = firstBreak(turn.write);
  if (w) flags.push(`In what you wrote, ${w.detail}.`);
  return flags;
}

// What the tutor writes must be right: cut its working at the first slip.
function stripBadMath(turn: TutorTurn) {
  for (const f of turn.draw) {
    if (f.kind !== "steps") continue;
    const b = firstBreak(f.lines.map((l) => l.math));
    if (b) f.lines = f.lines.slice(0, b.index);
  }
  const w = firstBreak(turn.write);
  if (w) turn.write = turn.write.slice(0, w.index);
}
