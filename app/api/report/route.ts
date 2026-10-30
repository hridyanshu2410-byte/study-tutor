import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { journalText, REPORT_PROMPT, reportAnalysisSchema, type ReportAnalysis, type ReportRequest } from "@/lib/session-report";

// The end-of-session analysis, on the same model as the tutor. Nobody is
// waiting on its first word, so it may think a little first.
const provider: "anthropic" | "openai" =
  process.env.TUTOR_PROVIDER === "openai" || process.env.TUTOR_PROVIDER === "anthropic"
    ? process.env.TUTOR_PROVIDER
    : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "openai";
const openaiModel = process.env.OPENAI_TUTOR_MODEL || "gpt-6-sol";
let effort = (process.env.OPENAI_REPORT_EFFORT || "low") as OpenAI.ReasoningEffort | "";

export const maxDuration = 120;

export async function POST(req: Request) {
  if (provider === "anthropic" ? !process.env.ANTHROPIC_API_KEY : !process.env.OPENAI_API_KEY) {
    return Response.json({ error: "The report needs an API key in .env.local" }, { status: 500 });
  }
  if (researchMode) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return Response.json({ error: "Please sign in again." }, { status: 401 });
  }
  const body = (await req.json()) as ReportRequest;
  if (!Array.isArray(body.journal) || !body.journal.length) return Response.json({ error: "Nothing to report yet." }, { status: 400 });

  const minutes = Math.max(1, Math.round((body.endedAt - body.startedAt) / 60000));
  const concepts = Object.entries(body.concepts ?? {})
    .map(([c, v]) => `${c}: ${v.solved ? `solved ${v.solved}` : ""}${v.slips ? `${v.solved ? ", " : ""}slipped` : ""}`)
    .join("; ");
  const facts = [
    `The session lasted about ${minutes} minutes.`,
    body.paper ? `They were reading "${body.paper.title}".` : body.problem.trim() ? `They were working on: ${body.problem.trim()}` : "",
    concepts ? `Ideas the tutor saw on the page: ${concepts}.` : "",
    body.cards?.length ? `Review cards saved: ${body.cards.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const conversation = `${facts}\n\nThe conversation:\n${journalText(body.journal.slice(-200))}`;
  const reading = body.paper?.text ? `The reading, every sentence tagged with its id:\n${body.paper.text}` : null;

  const started = Date.now();
  try {
    const analysis = provider === "openai" ? await viaOpenAI(conversation, reading) : await viaClaude(conversation, reading);
    console.log(`report: ${provider === "openai" ? openaiModel : "claude-opus-5-5"}, ${body.journal.length} entries, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return Response.json({ analysis });
  } catch (err) {
    console.error("report failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "The analysis could not be made this time." }, { status: 502 });
  }
}

async function viaOpenAI(conversation: string, reading: string | null): Promise<ReportAnalysis> {
  const openai = new OpenAI();
  try {
    const res = await openai.chat.completions.parse({
      model: openaiModel,
      ...(effort ? { reasoning_effort: effort } : {}),
      response_format: zodResponseFormat(reportAnalysisSchema, "session_report"),
      messages: [
        { role: "system", content: REPORT_PROMPT },
        { role: "user", content: [...(reading ? [{ type: "text" as const, text: reading }] : []), { type: "text" as const, text: conversation }] },
      ],
    });
    const parsed = res.choices[0]?.message.parsed;
    if (!parsed) throw new Error("no report in the answer");
    return parsed;
  } catch (err) {
    // a model that won't take this thinking setting: ask again without one
    if (err instanceof OpenAI.BadRequestError && /reasoning/i.test(err.message) && effort) {
      effort = "";
      return viaOpenAI(conversation, reading);
    }
    throw err;
  }
}

async function viaClaude(conversation: string, reading: string | null): Promise<ReportAnalysis> {
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(reportAnalysisSchema) },
    system: REPORT_PROMPT,
    messages: [{ role: "user", content: [...(reading ? [{ type: "text" as const, text: reading }] : []), { type: "text" as const, text: conversation }] }],
  });
  if (!res.parsed_output) throw new Error("no report in the answer");
  return res.parsed_output;
}
