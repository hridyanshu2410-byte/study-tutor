"use server";

import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/account";
import { CONSENT_VERSION, parseIntake } from "@/lib/study";

export async function giveConsent(_prev: string | null, form: FormData): Promise<string | null> {
  const { supabase, user } = await currentAccount();
  if (!user) redirect("/login");
  if (form.get("agree") !== "on" || form.get("adult") !== "on") return "Please tick both boxes to take part.";
  const intake = parseIntake(form);
  if (!intake) return "Please answer the two questions about your studies.";
  const { error } = await supabase
    .from("profiles")
    .update({ consent_version: CONSENT_VERSION, consented_at: new Date().toISOString(), age_confirmed: true, intake })
    .eq("id", user.id);
  if (error) return `Couldn't save that: ${error.message}`;
  redirect("/");
}
