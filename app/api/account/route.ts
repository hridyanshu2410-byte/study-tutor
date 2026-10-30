import { adminClient, createClient } from "@/lib/supabase/server";
import { researchMode } from "@/lib/supabase/env";

// A tester's right to withdraw: deleting the auth user cascades to their
// profile, saved state and every logged event.
export async function DELETE() {
  if (!researchMode) return Response.json({ error: "Accounts are not set up on this server." }, { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
  const { error } = await adminClient().auth.admin.deleteUser(user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
