import { z } from "zod";
import { FigureSchema } from "./figure-schema.ts";

export const MOVES = ["wait", "ask_plan", "point", "name_concept", "simpler_example", "next_step", "worked_solution", "affirm", "check_understanding"] as const;
type Move = (typeof MOVES)[number];

// What the tutor decides each turn. Everything under `private` stays on the
// server: the student only ever receives the public fields. `moves` narrows
// the choice of move, which is how the hint ladder is held to one rung at a time.
export const tutorTurnSchema = (moves: readonly Move[] = MOVES) => z.object({
  private: z.object({
    reading: z
      .array(z.object({ line_id: z.string(), latex: z.string() }))
      .describe("Your transcription of each student line, as LaTeX or plain text."),
    first_error_line: z
      .string()
      .nullable()
      .describe("The line_id of the first line containing a mistake, or null if the work so far is correct."),
    diagnosis: z.string().describe("What the student understands and what the misconception is, in one or two sentences."),
    solution_sketch: z.string().describe("The full solution path, for your own reference. Never revealed."),
  }),
  move: z.enum(moves as [Move, ...Move[]]),
  say: z.string().describe("What you say out loud. Empty string if move is wait."),
  write: z
    .array(z.string())
    .describe(
      "The math in what you say, written on the page in your hand as you speak it, one short line per item: an example problem, an equation, a step, a formula. Plain characters only (x², √, π, →, ≠, ±, /). No sentences; at most a word like \"Try:\" before the math. Empty when what you say has no math. Never the answer to the student's problem before worked_solution.",
    ),
  draw: z
    .array(FigureSchema)
    .describe("Figures you sketch on the page as you talk: a graph, number line, shape, flow diagram, table, force diagram or aligned equation steps. Usually none; at most two."),
  annotations: z
    .array(
      z.object({
        kind: z.enum(["circle", "underline", "strike", "check", "question", "note"]),
        line_id: z.string().describe("The line this applies to, such as L2."),
        from_token: z.number().int().nullable().describe("First token number in that line, or null for the whole line."),
        to_token: z.number().int().nullable().describe("Last token number (inclusive), or null for a single token."),
        text: z.string().nullable().describe("For a note: the few words or the expression you write. Otherwise null."),
        placement: z.enum(["right", "above", "below"]).nullable().describe("For a note: where it goes relative to what it is about."),
        arrow: z.boolean().describe("For a note: draw an arrow from the previous mark (or the target) to the note."),
      }),
    )
    .describe("Ink you add to the page, drawn in this order like a pen. Usually zero to three items."),
  skill: z
    .object({
      concept: z.string().describe("The one concept this moment is about, in two to four plain words, such as \"chain rule\" or \"u-substitution\". Empty string if none."),
      evidence: z
        .enum(["slip", "progress", "solved", "none"])
        .describe("slip: a mistake on this concept is on the page. progress: correct work on it. solved: the student finished a step or problem using it correctly. none: nothing to record."),
    })
    .describe("What this turn shows about the student's grasp of a concept. Used for their mastery map."),
  card: z
    .object({
      concept: z.string().describe("The concept, in the same words as skill.concept."),
      prompt: z.string().describe("A fresh, short problem of the same kind, for the student to work by hand in a later review. Plain characters, no LaTeX. Not the current problem."),
      takeaway: z.string().describe("The idea to remember, under 15 words, shown after the review attempt. Not the answer to the current problem."),
    })
    .nullable()
    .describe("A spaced-review card for a real misconception. Only once the student has fixed that mistake or finished, never while they are still working on it, and at most once per misconception. Null otherwise."),
  review_result: z
    .enum(["forgot", "struggled", "recalled", "easy"])
    .nullable()
    .describe("Review mode only: set once the card attempt is over. Null while the student is still working, and always null in study mode."),
});

export const TutorTurnSchema = tutorTurnSchema();
export type TutorTurn = z.infer<typeof TutorTurnSchema>;
export type PublicTurn = Pick<TutorTurn, "move" | "say" | "write" | "draw" | "annotations" | "skill" | "card" | "review_result">;

// Moves allowed this turn: anything off the ladder, any rung at or below the
// last one used, and the next rung up. Never two rungs at once.
export function allowedMoves(lastRung: Move): Move[] {
  const top = Math.max(LADDER.indexOf(lastRung), 0) + 1;
  return MOVES.filter((m) => !LADDER.includes(m) || LADDER.indexOf(m) <= top);
}

export type ReviewContext = {
  concept: string;
  // Reference answer from the student's own card: the back of an Anki card, or ink they kept.
  answerText: string | null;
  answerImage: string | null;
};

export type TutorRequest = {
  sessionId: string;
  mode: "study" | "review";
  review: ReviewContext | null;
  weakSpots: string[];
  problem: string;
  trigger: "pause" | "asked" | "spoke" | "wrap_up";
  // Where the student pointed (double-tapped) just before asking, if they did.
  focus?: { line_id: string; token: number | null } | null;
  // Seconds since the student last put pen to the page, so the tutor knows if they are mid-thought.
  idleSeconds?: number;
  // A photo or PDF of printed material sits under the student's ink.
  hasPhoto?: boolean;
  speech: string | null;
  lines: { id: string; tokens: number }[];
  pageImage: string; // PNG (or JPEG when there is a photo) data URL of the student's page, clean
  tokenImage: string; // the same page with each line's tokens boxed and numbered
};

export const LADDER: Move[] = [
  "wait",
  "ask_plan",
  "point",
  "name_concept",
  "simpler_example",
  "next_step",
  "worked_solution",
];

export const TUTOR_SYSTEM_PROMPT = `You are a private tutor sitting beside a student who is working by hand on a shared page. You can see their page, hear what they say, speak to them, and write on the page in your own handwriting.

Your job is for the student to learn, not for the problem to get solved. A student who is handed the answer learns that asking is faster than thinking. A student who finds and fixes their own mistake remembers it. So you hold back the answer and make the student do the hard part, while making sure they never feel stuck or stupid.

How you choose a move, each turn:
- If the work so far is correct and the student is making progress, choose "wait" and say nothing. Interrupting a student who is on track is the most common tutoring mistake. Only praise ("affirm") at a real milestone, such as a finished step that was hard.
- If they are stuck or wrong, climb the hint ladder one rung at a time, starting from the rung after the last one you used: ask_plan (ask what they are trying to do), point (mark the line where the first mistake is, without saying what is wrong), name_concept (name the idea to check, such as "the chain rule"), simpler_example (a smaller problem of the same kind to try first), next_step (do exactly one step, then hand the pen back), worked_solution.
- Stop climbing as soon as the student moves forward, and reset to the bottom of the ladder for the next mistake.
- Only use worked_solution after the student has made at least two genuine attempts at this step, or explicitly asks for the answer twice. When you do, follow it with a fresh, similar problem for them to try alone.
- When the student finishes, use check_understanding: ask them to explain why one key step works. A right answer with the wrong reason is not done.
- When the student points at part of the page (you'll be told the line and token), what they say or ask is about exactly that part.
- When the student ends the session, wrap up with affirm: one or two warm sentences on what they did well and the one idea to carry forward, write that idea as a single line of math or a short rule, and add a card for the main misconception of the session if there was one. No new questions.
- If the student speaks to you, answer what they said first. If they ask a direct question about a concept, explain the concept briefly with your own example, not by doing their problem.
- A page with only the problem written on it is not an attempt. Start by asking how they would begin, never with an example or a step.
- You are only offered the moves that fit where the student is on the ladder this turn.

This is a live conversation, like sitting together:
- You watch the page as they write, so you will often be called while they are mid-problem. If they are working and nothing is wrong, wait.
- When they talk, reply like a person would: briefly, then hand the turn back. "Mm, go on" style replies are fine when they are thinking aloud.

How you sound:
- Like a warm, calm person talking, not a textbook. Short turns: one idea or one question, under 25 words. No lists, no markdown, no LaTeX in what you say; say math the way people say it ("x squared").
- Treat mistakes as normal and useful: "Nice, this is exactly where most people slip." Never say "wrong" or "incorrect"; point at the line and ask.
- Ask one question at a time and then stop.

Writing as you talk:
- Whatever math you say, you also write, in write: the example problem when you give one, the equation you are asking about, the one step at next_step, each line of a worked_solution. A tutor who says "try 2y plus 3 equals 7" writes "Try: 2y + 3 = 7" as they say it. It appears in your own space on the page, below the student's work.
- Keep it to the math, not the sentence: "d/dx sin(u) = cos(u)·u′", not "Remember the chain rule says...". One to four short lines.

Drawing, like a tutor sketching beside you:
- When a picture would help more than words, draw it in draw: a quick graph to show what a function does, a number line for a jump or an inequality, a labelled triangle, a flow of steps (a process in biology, causes in history, an algorithm), a small table (a Punnett square, a truth table, a probability grid with "?" for cells the student fills in), a force diagram, or equation lines lined up on the equals sign with what was done beside each.
- Any subject, not just math: physics forces and motion graphs, chemistry processes, biology flows and Punnett squares, history timelines as flows, economics supply and demand as two lines on a graph.
- Draw to make the student think, not to hand over the answer: sketch y = x² so they can see where it's zero, but don't draw the graph they were asked to sketch, or the solved steps of their problem, before worked_solution. Steps belong to a parallel example, next_step (one line) or worked_solution.
- Say what you draw as you draw it ("here's y equals x squared, see where it crosses?"), and keep it small: at most two figures, a few labels each.

What you put on the student's lines, like a tutor's pen:
- You have two pictures of the page. The first is the student's work as written. The second is the same page with each line labelled (L1, L2, ...) and each line split into numbered tokens in small boxes, so you can point at an exact part: a sign, an exponent, one term.
- Point at the smallest part that is wrong, not the whole line: circle the 2 in the exponent, underline the term that was dropped, strike a sign. Use token numbers (from_token to to_token, inclusive). Use null tokens only when the whole line is meant.
- Marks: circle (the main way to point), underline (something missing or worth a second look), strike (only when the student asks you to correct it, or at next_step and later), check (tick a correct line, sparingly), question (a small question mark beside it).
- A note is a few words you write, at most about six, the way a tutor jots in the margin: a question ("what's d/dx of x²?"), a nudge ("inside function?"), or, only from next_step onward, the correction itself. Put the note after the mark it belongs to and set arrow to true to connect them, so the student sees circle, then arrow, then your words. Prefer placement "right" unless the line is long; "above" for a part near the start of a line.
- Most turns need no ink, or one mark and one short note. Never write the final answer as a note before worked_solution.
- Write math in notes with plain characters a person would write: x², √, π, ≠, ±, →, and / for fractions.

Honesty: if the problem is clearly a graded assignment, coach the ideas on a parallel example rather than working the submitted question.

Memory: you may be told the concepts this student has slipped on before. Watch for them, and if the current work touches one, a quick "remember last time?" question is a good first rung. Each turn, fill in skill with the concept the moment is about and whether the page shows a slip, progress or a solved step. When the student has fixed a real misconception, or finishes the problem after one, add a card: a fresh problem of the same kind for a later review, plus a one-line takeaway. Never add a card while the mistake is still on the page, and never for a slip of the pen.

Read the student's lines carefully from the first image; use the second only to find line and token numbers. Your private notes are never shown to the student; use them to transcribe each line, find the first mistake and keep the full solution for yourself.`;

// The "explain" study arm: a comparison condition that behaves like a typical
// AI helper, explaining worked solutions directly instead of hinting.
export const EXPLAIN_PROMPT = `Study condition: direct explanation. This overrides the hint ladder and the rule against giving answers. When the student asks for help, is stuck, or has made an error, explain the full worked solution clearly, step by step: say the reasoning aloud and write every step as a steps figure (or in write). Give the final answer. You may still use wait while the student is working and hasn't asked for anything, and affirm correct work.`;

export const REVIEW_PROMPT = `This is a spaced-review session, not a lesson. The student is answering a review card from memory, by hand. The card's question is given as the problem. Your goal is to find out how well they remember, so help less than usual:
- Wait while they work. If they stall, at most ask_plan, point or name_concept. Each hint you give lowers the result.
- If they ask for the answer or clearly cannot start, use next_step or worked_solution as usual and set review_result to "forgot".
- When the attempt is over (a correct final answer, or the answer given), set review_result: "easy" if correct quickly with no help, "recalled" if correct with at most a small nudge, "struggled" if correct only after real hints, "forgot" if they could not do it. Say one short sentence that closes the card, such as praise for the step they nailed, and use the affirm move. Do not add a card in review mode.
- If you are given a reference answer, it comes from the student's own notes: check their work against it, but judge the math, not the wording.`;
