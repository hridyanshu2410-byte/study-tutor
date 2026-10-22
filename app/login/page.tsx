import { redirect } from "next/navigation";
import { researchMode } from "@/lib/supabase/env";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Tutor" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!researchMode) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="auth">
      <div className="auth-card">
        <h1 className="brand">Tutor</h1>
        <p className="auth-lede">A private tutor that watches you work by hand and helps you get there yourself.</p>
        <LoginForm needsInvite={Boolean(process.env.STUDY_INVITE_CODE)} linkError={error === "link"} />
      </div>
    </main>
  );
}
