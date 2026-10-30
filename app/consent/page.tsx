import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/account";
import { researchMode } from "@/lib/supabase/env";
import { CONSENT_SECTIONS, CONSENT_VERSION, INTAKE_AI_USE, INTAKE_LEVELS } from "@/lib/study";
import ConsentForm from "./ConsentForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Before you start · Tutor" };

export default async function ConsentPage() {
  if (!researchMode) redirect("/");
  const { user, profile } = await currentAccount();
  if (!user) redirect("/login");
  if (profile?.consent_version === CONSENT_VERSION) redirect("/");

  return (
    <main className="auth">
      <div className="auth-card consent">
        <h1 className="brand">Before you start</h1>
        <p className="auth-lede">
          Thanks for helping test the tutor. Here is what taking part means. Your participant code is{" "}
          <strong>{profile?.participant_code ?? "being created"}</strong>.
        </p>
        {CONSENT_SECTIONS.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            <p>{s.body}</p>
          </section>
        ))}
        <ConsentForm levels={[...INTAKE_LEVELS]} aiUse={[...INTAKE_AI_USE]} />
      </div>
    </main>
  );
}
