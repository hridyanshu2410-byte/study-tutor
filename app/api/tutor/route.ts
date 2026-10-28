import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { describeSim, sanitizeSim } from "@/lib/sims";
import { zodResponseFormat } from "openai/helpers/zod";
import { adminClient, createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { conditionOf, dailyTutorLimit, startOfUtcDay, type Condition } from "@/lib/study";
import { allowedMoves, EXPLAIN_PROMPT, LADDER, MOVES, PAPER_PROMPT, REVIEW_PROMPT, TUTOR_SYSTEM_PROMPT, tutorTurnSchema, type Beat, type PublicTurn, type TurnEnd, type TutorRequest, type TutorTurn } from "@/lib/tutor";
import { BeatChecker, readingFlag, TurnScanner } from "@/lib/turn-stream";

// The tutor runs on Claude when ANTHROPIC_API_KEY is set, otherwise on OpenAI
// (OPENAI_TUTOR_MODEL, default GPT-6 Luna). TUTOR_PROVIDER forces one.
const provider: "anthropic" | "openai" =
  process.env.TUTOR_PROVIDER === "openai" || process.env.TUTOR_PROVIDER === "anthropic"
    ? process.env.TUTOR_PROVIDER
    : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "openai";
const openaiModel = process.env.OPENAI_TUTOR_MODEL || "gpt-6-luna";
// GPT-6 Luna reasons before it answers. A little is enough for one turn of
// tutoring, and the student is waiting for the first words.
// OPENAI_REASONING_EFFORT changes it; a model that doesn't take the setting is
// asked again without it.
let reasoningEffort = (process.env.OPENAI_REASONING_EFFORT || "low") as OpenAI.ReasoningEffort | "";
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
type Usage = { input: number; output: number; cached: number; thinking: number };
type Answer = { text: string; refused: boolean; usage: Usage };

// Asks for a turn and hands over its text as it is written, so the first
// phrase can be spoken while the rest is still coming.
async function streamTutor(a: Ask, signal: AbortSignal, onText: (delta: string) => void): Promise<Answer> {
  let text = "";
  if (provider === "openai") {
    const png = (p: Pic) => ({ type: "image_url" as const, image_url: { url: `data:${p.type};base64,${p.data}` } });
    const stream = openai!.chat.completions.stream(
      {
        model: openaiModel,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        response_format: zodResponseFormat(a.schema, "tutor_turn"),
        stream_options: { include_usage: true },
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
      },
      { signal },
    );
    let refused = false;
    stream.on("content", (delta) => {
      text += delta;
      onText(delta);
    });
    stream.on("refusal.delta", () => (refused = true));
    try {
      const res = await stream.finalChatCompletion();
      const u = res.usage;
      return {
        text,
        refused,
        usage: { input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, cached: u?.prompt_tokens_details?.cached_tokens ?? 0, thinking: u?.completion_tokens_details?.reasoning_tokens ?? 0 },
      };
    } catch (err) {
      if (err instanceof OpenAI.BadRequestError && reasoningEffort && !text && /reasoning/i.test(err.message)) {
        const was = reasoningEffort;
        reasoningEffort = lighterEffort(was, err.message);
        console.warn(`${openaiModel} doesn't take reasoning_effort ${was}; asking with ${reasoningEffort || "the model's default"}`);
        return streamTutor(a, signal, onText);
      }
      // A reply that doesn't fit the schema is read from its text, not a crash.
      if (signal.aborted || err instanceof OpenAI.APIError) throw err;
      return { text, refused, usage: { input: 0, output: 0, cached: 0, thinking: 0 } };
    }
  }
  const stream = client!.messages.stream(
    {
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
    },
    { signal },
  );
  stream.on("text", (delta) => {
    text += delta;
    onText(delta);
  });
  try {
    const msg = await stream.finalMessage();
    const u = msg.usage;
    return {
      text,
      refused: msg.stop_reason === "refusal",
      usage: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cached: u.cache_read_input_tokens ?? 0, thinking: 0 },
    };
  } catch (err) {
    if (signal.aborted || err instanceof Anthropic.APIError) throw err;
    const u = stream.currentMessage?.usage;
    return { text, refused: false, usage: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cached: u?.cache_read_input_tokens ?? 0, thinking: 0 } };
  }
}

// The least thinking a model takes when it turned down `was`: the lightest
// of the values its error lists, or the next one up, or none at all.
const EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
function lighterEffort(was: string, message: string): OpenAI.ReasoningEffort | "" {
  const listed = EFFORTS.filter((e) => e !== was && new RegExp(`['"\`]${e}['"\`]`).test(message.split(/supported values/i)[1] ?? ""));
  if (listed.length) return listed[0];
  const next = EFFORTS[EFFORTS.indexOf(was as (typeof EFFORTS)[number]) + 1];
  return next && next !== "medium" ? next : "";
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
            ? "The student just opened this paper. In three to five short beats: the problem it tackles, as a situation they can picture; the paper's key idea and how it works, in its own terms, building one picture of it as you go, one part per beat (usually a scene of who and what is involved, or a diagram if it is a pipeline); then one question that gets them thinking about the idea. Highlight the sentence that states the main contribution as you name it."
          : body.trigger === "watched"
            ? `The student just played the simulation and watched it. What happened: ${String(body.watched ?? "").slice(0, 600)}. Compare it with any prediction they marked or said, and ask them to explain the difference or why it happened.`
            : `The student just said: "${body.speech ?? ""}"`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const started = Date.now();
  const schema = tutorTurnSchema(explaining || paper ? MOVES : allowedMoves(lastRung));
  const system = [TUTOR_SYSTEM_PROMPT, reviewing ? REVIEW_PROMPT : paper ? PAPER_PROMPT : explaining ? EXPLAIN_PROMPT : ""].filter(Boolean).join("\n\n");
  const known = new Set(body.lines.map((l) => l.id));
  // The student closed the page or cut the tutor off: stop writing the turn.
  const gone = new AbortController();
  req.signal?.addEventListener("abort", () => gone.abort());

  // Streams the turn to the student beat by beat, then records it.
  const perform = async (send: (event: object) => void) => {
    const checker = new BeatChecker({ paperText: paper?.text ?? null, lines: known });
    const sent: Beat[] = [];
    const flags: string[] = [];
    let usage: Usage = { input: 0, output: 0, cached: 0, thinking: 0 };
    // when the model's first words and the first beat came, for the timing line below
    let firstText = 0;
    let firstBeat = 0;
    let turn: TutorTurn | null = null;
    let move: TutorTurn["move"] | null = null;
    let diagnosis = "";
    let extra = "";
    let retried = false;
    // A retry starts the turn over; the beats the student already heard are skipped.
    let skip = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      gone.signal.addEventListener("abort", stop);
      const scan = new TurnScanner();
      let restart: string | null = null;
      let checked = false;
      let seen = 0;
      let told = -1;
      // Called as text arrives: checks the student's page once the tutor's
      // reading of it is complete, then sends each finished beat.
      const pump = () => {
        if (restart) return;
        if (!checked && scan.values.has("private")) {
          checked = true;
          const flag = retried ? null : readingFlag(scan.values.get("private") as TutorTurn["private"]);
          if (flag) {
            flags.push(flag);
            restart = `\n\nA math checker reviewed your reading of the page and found:\n- ${flag}\nLook again. If the checker is right, a slip by the student is their first mistake; set first_error_line and your turn accordingly. If you are sure you were right, keep your answer.`;
            return ctrl.abort();
          }
        }
        const m = scan.values.get("move");
        if (!checked || typeof m !== "string" || m === "wait") return;
        while (seen < scan.beats.length) {
          const raw = scan.beats[seen++];
          if (seen <= skip) continue;
          const beat = checker.sanitize(raw);
          if (!beat) continue;
          const slip = checker.slip(beat);
          if (slip) {
            flags.push(slip);
            if (!retried) {
              const heard = sent.map((b, i) => `${i + 1}. "${b.say}"${b.write.length ? ` (wrote ${b.write.map((w) => `"${w}"`).join(", ")})` : ""}`).join("\n");
              restart =
                `\n\nA math checker read the beat you were about to say and found: ${slip} That beat was not shown.` +
                (sent.length
                  ? ` The student has already heard your first ${sent.length} beat${sent.length === 1 ? "" : "s"}:\n${heard}\nWrite the turn again starting with exactly ${sent.length === 1 ? "that beat" : `those ${sent.length} beats`}, then go on from there with the math fixed.`
                  : " Write the turn again with the math fixed.");
              return ctrl.abort();
            }
            checker.strip(beat);
            if (!beat.say && !beat.write.length && !beat.draw && !beat.highlights.length && !beat.annotations.length) continue;
          }
          checker.commit(beat);
          sent.push(beat);
          firstBeat ||= Date.now() - started;
          send({ beat });
        }
        // The next phrase's words come before its ink, so its voice can be made meanwhile.
        const next = scan.upcoming?.trim().slice(0, 240);
        if (next && scan.beats.length > told && scan.beats.length >= skip && checker.count < 8) {
          told = scan.beats.length;
          send({ upcoming: next });
        }
      };
      try {
        const answer = await streamTutor(
          { schema, system, paperText: paper?.text, page: page!, tokens: tokens!, reference, situation: situation + extra },
          ctrl.signal,
          (delta) => {
            firstText ||= Date.now() - started;
            scan.push(delta);
            pump();
          },
        );
        usage = {
          input: usage.input + answer.usage.input,
          output: usage.output + answer.usage.output,
          cached: usage.cached + answer.usage.cached,
          thinking: usage.thinking + answer.usage.thinking,
        };
        pump();
        if (!restart) {
          const parsed = answer.refused ? null : schema.safeParse(safeJson(answer.text));
          turn = parsed?.success ? parsed.data : null;
          const m = scan.values.get("move");
          move = turn?.move ?? (typeof m === "string" && (MOVES as readonly string[]).includes(m) ? (m as TutorTurn["move"]) : null);
          diagnosis = turn?.private.diagnosis ?? String((scan.values.get("private") as { diagnosis?: unknown } | undefined)?.diagnosis ?? "");
          break;
        }
      } catch (err) {
        if (gone.signal.aborted) break;
        if (!restart) {
          // Errors before anything was said are answered as errors; after that the turn just ends.
          if (!sent.length) throw err;
          console.warn("Tutor stream ended early", err instanceof Error ? err.message.slice(0, 200) : err);
          break;
        }
      } finally {
        gone.signal.removeEventListener("abort", stop);
      }
      retried = true;
      extra = restart ?? "";
      skip = sent.length;
    }

    if (gone.signal.aborted && !sent.length) return;
    if (!move || (!sent.length && move !== "wait")) {
      // Nothing usable came back: a gentle question instead of silence.
      const say = "Let's look at this together. What are you trying to do on this line?";
      if (!gone.signal.aborted) {
        const fallback = fallbackTurn(say);
        for (const beat of fallback.beats) send({ beat });
        sent.push(...fallback.beats);
      }
      move ??= "ask_plan";
    }
    const simulate = move === "wait" || !turn?.simulate ? null : sanitizeSim(turn.simulate);
    const end: TurnEnd = {
      move,
      say: sent.map((b) => b.say).filter(Boolean).join(" "),
      simulate,
      skill: { concept: (turn?.skill.concept ?? "").slice(0, 60), evidence: turn?.skill.evidence ?? "none" },
      card: reviewing ? null : (turn?.card ?? null),
      review_result: reviewing ? (turn?.review_result ?? null) : null,
    };
    if (!gone.signal.aborted) send({ turn: end });
    const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    console.log(
      `tutor ${body.trigger}: ${provider === "openai" ? `${openaiModel} (reasoning ${reasoningEffort || "default"})` : "claude-opus-5-5"}, ` +
        `first text ${sec(firstText)}, first beat ${sec(firstBeat)}, done ${sec(Date.now() - started)}; ` +
        `${usage.input} tokens in (${usage.cached} cached), ${usage.output} out (${usage.thinking} thinking); ${sent.length} beats, ${move}${retried ? ", retried" : ""}${gone.signal.aborted ? ", cut off" : ""}`,
    );

    const record: PastTurn = {
      trigger: body.trigger,
      speech: body.speech,
      move,
      say: end.say,
      ink: describeInk(sent, simulate),
      diagnosis,
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
          beats: sent.length,
          annotations: sent.flatMap((b) => b.annotations.map((a) => a.kind)),
          concept: end.skill.concept,
          evidence: end.skill.evidence,
          card_proposed: Boolean(end.card),
          review_result: end.review_result,
          first_error_line: turn?.private.first_error_line ?? null,
          math_flags: flags,
          math_retried: retried,
          interrupted: gone.signal.aborted,
          latency_ms: Date.now() - started,
          model: provider === "openai" ? openaiModel : "claude-opus-5-5",
          input_tokens: usage.input,
          output_tokens: usage.output,
        },
      });
      if (error) console.warn("Could not log tutor turn", error.message);
    }
  };

  // The reply is a stream of lines: {"upcoming": words} as soon as a phrase's
  // words are known, {"beat": ...} once its ink is too, then {"turn": ...} at
  // the end. Until the first line is ready, a failure can still be answered
  // with an ordinary error.
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: () => gone.abort(),
  });
  let begin!: () => void;
  const begun = new Promise<void>((resolve) => (begin = resolve));
  const send = (event: object) => {
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      // the student has gone
    }
    begin();
  };
  const work = perform(send);
  try {
    await Promise.race([begun, work]);
  } catch (err) {
    return errorResponse(err);
  }
  work.then(
    () => controller.close(),
    (err) => {
      console.warn("Tutor turn failed", err instanceof Error ? err.message.slice(0, 200) : err);
      send({ error: "The tutor lost its train of thought. Ask again?" });
      controller.close();
    },
  );
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
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

function fallbackTurn(say: string): PublicTurn {
  return {
    move: "ask_plan",
    say,
    beats: say ? [{ say, write: [], draw: null, continue_figure: false, highlights: [], annotations: [] }] : [],
    simulate: null,
    skill: { concept: "", evidence: "none" },
    card: null,
    review_result: null,
  };
}

function describeInk(beats: Beat[], simulate: TutorTurn["simulate"]): string {
  const ink = beats.flatMap((b) => [
    ...b.write.map((w) => `wrote "${w}"`),
    ...(b.draw ? [`${b.continue_figure ? "added to the figure: " : ""}${describeFigure(b.draw)}`] : []),
    ...b.highlights.map((h) => `${h.kind}ed ${h.ref}${h.note ? ` with margin note "${h.note}"` : ""}`),
    ...b.annotations.map((a) => {
      const where = a.from_token == null ? a.line_id : `${a.line_id} tokens ${a.from_token}-${a.to_token ?? a.from_token}`;
      return a.kind === "note" ? `note "${a.text}" near ${where}` : `${a.kind} on ${where}`;
    }),
  ]);
  if (simulate) ink.push(`set up a ${describeSim(simulate)}`);
  return ink.join(", ") || "none";
}

function describeFigure(f: NonNullable<Beat["draw"]>): string {
  if (f.kind === "graph") return `drew a graph of ${f.curves.map((c) => c.formula).join(" and ") || "points"}`;
  if (f.kind === "number_line") return `drew a number line from ${f.from} to ${f.to}`;
  if (f.kind === "shape") return `drew a shape ${f.vertices.map((v) => v.label ?? "").join("")}`.trim();
  if (f.kind === "flow") return `drew a flow: ${f.nodes.map((n) => n.text).join(" → ")}`;
  if (f.kind === "table") return `drew a table: ${f.rows.map((r) => r.join(" | ")).join(" / ")}`;
  if (f.kind === "forces") return `drew a force diagram: ${f.forces.map((x) => x.label).join(", ")}`;
  if (f.kind === "diagram")
    return `drew a diagram${f.title ? ` "${f.title}"` : ""}: ${f.nodes.map((n) => `${n.text} (row ${n.row}, col ${n.col})`).join(", ")}; arrows ${f.edges.map((e) => `${e.from}→${e.to}`).join(", ")}`;
  if (f.kind === "bars") return `drew a bar chart${f.title ? ` "${f.title}"` : ""}: ${f.bars.map((b) => `${b.label} ${b.value}`).join(", ")}`;
  if (f.kind === "sketch") return `sketched ${f.title ?? "a drawing"}${f.labels.length ? ` labelled ${f.labels.map((l) => l.text).join(", ")}` : ""}`;
  if (f.kind === "scene")
    return `drew a scene${f.title ? ` "${f.title}"` : ""}: ${f.things
      .map((t) => `${t.what}${t.count ? ` ×${t.count}` : ""}${t.caption ? ` "${t.caption}"` : ""}${t.says ? ` saying "${t.says}"` : ""} (row ${t.row}, col ${t.col})`)
      .join(", ")}${f.arrows.length ? `; arrows ${f.arrows.map((a) => `${a.from}→${a.to}`).join(", ")}` : ""}${f.marks.length ? `; marked ${f.marks.map((m) => `${m.kind} on ${m.on}${m.note ? ` "${m.note}"` : ""}`).join(", ")}` : ""}`;
  return `wrote steps: ${f.lines.map((l) => l.math).join(" ; ")}`;
}
