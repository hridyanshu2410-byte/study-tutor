import { redirect } from "next/navigation";
import StudyCanvas from "@/components/StudyCanvas";
import { currentAccount } from "@/lib/account";
import { researchMode } from "@/lib/supabase/env";
import { isAdmin } from "@/lib/supabase/server";
import { conditionOf, CONSENT_VERSION, testOpen } from "@/lib/study";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!researchMode) return <StudyCanvas account={null} />;

  const { user, profile } = await currentAccount();
  if (!user) redirect("/login");
  if (profile?.consent_version !== CONSENT_VERSION) redirect("/consent");
  if (testOpen("pre") && !profile.pretest_at) redirect("/quiz/pre");
  return (
    <StudyCanvas
      account={{
        userId: user.id,
        email: user.email ?? "",
        participantCode: profile.participant_code,
        admin: isAdmin(user.email),
        condition: conditionOf(profile.condition),
        postQuiz: testOpen("post") && !profile.posttest_at,
      }}
    />
  );
}
