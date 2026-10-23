"use server";

import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/account";
import { adminClient } from "@/lib/supabase/server";
import { conditionOf, testOpen } from "@/lib/study";
import { scoreTest, TESTS } from "@/lib/study-tests";

// Scored here so answer keys never reach the browser. The score and the
// "taken" mark are written with the service role, so a tester can't retake
// a quiz or edit a result.
export async function submitQuiz(_prev: string | null, form: FormData): Promise<string | null> {
  const phase = form.get("phase");
  if (phase !== "pre" && phase !== "post") return "Unknown quiz.";
  const { user, profile } = await currentAccount();
  if (!user || !profile) redirect("/login");
  if (!testOpen(phase) || (phase === "pre" ? profile.pretest_at : profile.posttest_at)) redirect("/");

  const answers: Record<string, number | null> = {};
  for (const it of TESTS[phase]) {
    const v = form.get(it.id);
    const n = v === null || v === "" ? NaN : Number(v);
    answers[it.id] = Number.isInteger(n) && n >= 0 && n < it.choices.length ? n : null;
  }
  const result = scoreTest(phase, answers);
  const seconds = Math.round((Date.now() - Number(form.get("started") ?? Date.now())) / 1000);

  const db = adminClient();
  const now = new Date().toISOString();
  const { error } = await db.from("events").insert({
    user_id: user.id,
    kind: "test",
    data: { phase, ...result, seconds: Number.isFinite(seconds) ? seconds : null, condition: conditionOf(profile.condition) },
  });
  if (error) return `Couldn't save that: ${error.message}`;
  await db
    .from("profiles")
    .update(phase === "pre" ? { pretest_at: now } : { posttest_at: now })
    .eq("id", user.id);
  redirect("/");
}
