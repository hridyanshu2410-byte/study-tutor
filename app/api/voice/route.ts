import { createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";

// Optional natural tutor voice via OpenAI text-to-speech. Without
// OPENAI_API_KEY this answers 404 and the browser speaks instead.
const VOICE = process.env.OPENAI_TTS_VOICE || "sage";
const STYLE =
  "You are a warm, calm private tutor sitting beside a student. Speak gently and unhurried, with natural pauses, like a person, not an announcer. Say math the way people say it aloud.";

export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return new Response(null, { status: 404 });
  if (researchMode) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return new Response(null, { status: 401 });
  }
  const { text } = (await req.json()) as { text?: string };
  if (!text?.trim()) return new Response(null, { status: 400 });

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: VOICE, input: text.slice(0, 600), instructions: STYLE, response_format: "mp3" }),
  });
  if (!res.ok || !res.body) return new Response(null, { status: 502 });
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
