import { createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";
import { inviteOk } from "@/lib/study";

// Sign-up goes through the server so the optional study invite code is
// checked where testers can't skip it.
export async function POST(req: Request) {
  if (!researchMode) return Response.json({ error: "Accounts are not set up on this server." }, { status: 404 });
  const { email, password, invite } = (await req.json()) as { email?: string; password?: string; invite?: string };
  if (!email || !password) return Response.json({ error: "Email and password are required." }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "Use at least 8 characters for your password." }, { status: 400 });
  if (!inviteOk(invite)) return Response.json({ error: "That invite code isn't right." }, { status: 403 });

  const supabase = await createClient();
  const origin = new URL(req.url).origin;
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: `${origin}/auth/callback?next=/consent` },
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  // With email confirmation on, there is no session until the link is clicked.
  return Response.json({ confirm: !data.session });
}
