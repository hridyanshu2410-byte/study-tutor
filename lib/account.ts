import "server-only";
import { createClient } from "./supabase/server";

export type Profile = {
  id: string;
  participant_code: string;
  consent_version: string | null;
  consented_at: string | null;
  intake: Record<string, unknown>;
};

// The signed-in tester and their profile, or nulls when signed out.
export async function currentAccount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, profile: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, participant_code, consent_version, consented_at, intake")
    .eq("id", user.id)
    .maybeSingle<Profile>();
  return { supabase, user, profile };
}
