"use server";

import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/account";
import { adminClient } from "@/lib/supabase/server";
import { CONSENT_VERSION, parseIntake, pickCondition, studyConditions } from "@/lib/study";

export async function giveConsent(_prev: string | null, form: FormData): Promise<string | null> {
  const { supabase, user, profile } = await currentAccount();
  if (!user) redirect("/login");
  if (form.get("agree") !== "on" || form.get("adult") !== "on") return "Please tick both boxes to take part.";
  const intake = parseIntake(form);
  if (!intake) return "Please answer the two questions about your studies.";
  const { error } = await supabase
    .from("profiles")
    .update({ consent_version: CONSENT_VERSION, consented_at: new Date().toISOString(), age_confirmed: true, intake })
    .eq("id", user.id);
  if (error) return `Couldn't save that: ${error.message}`;
  if (!profile?.condition) await assignCondition(user.id);
  redirect("/");
}

// Testers can't write their own study arm, so the service role sets it.
async function assignCondition(userId: string) {
  const arms = studyConditions();
  if (!arms.length) return;
  const db = adminClient();
  const { data } = await db.from("profiles").select("condition").not("condition", "is", null);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.condition] = (counts[row.condition] ?? 0) + 1;
  await db.from("profiles").update({ condition: pickCondition(arms, counts) }).eq("id", userId).is("condition", null);
}
