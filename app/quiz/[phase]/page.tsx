import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/lib/account";
import { researchMode } from "@/lib/supabase/env";
import { CONSENT_VERSION, testOpen, type TestPhase } from "@/lib/study";
import { publicItems } from "@/lib/study-tests";
import QuizForm from "./QuizForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quick quiz · Tutor" };

export default async function QuizPage({ params }: { params: Promise<{ phase: string }> }) {
  const { phase } = await params;
  if (!researchMode || (phase !== "pre" && phase !== "post")) notFound();
  const { user, profile } = await currentAccount();
  if (!user) redirect("/login");
  if (profile?.consent_version !== CONSENT_VERSION) redirect("/consent");
  if (!testOpen(phase) || (phase === "pre" ? profile.pretest_at : profile.posttest_at)) redirect("/");

  return (
    <main className="auth">
      <div className="auth-card consent">
        <h1 className="brand">{phase === "pre" ? "A quick warm-up quiz" : "One last quiz"}</h1>
        <p className="auth-lede">
          {phase === "pre"
            ? "Eight short questions, before you start, so we can see what the tutor changes. It isn't graded and nobody sees your name. Skip any you don't know; a guess is fine too."
            : "Eight questions like the ones you saw at the start. It isn't graded. Skip any you don't know."}
        </p>
        <QuizForm phase={phase as TestPhase} items={publicItems(phase as TestPhase)} />
      </div>
    </main>
  );
}
