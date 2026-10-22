import { redirect } from "next/navigation";
import StudyCanvas from "@/components/StudyCanvas";
import { currentAccount } from "@/lib/account";
import { researchMode } from "@/lib/supabase/env";
import { isAdmin } from "@/lib/supabase/server";
import { CONSENT_VERSION } from "@/lib/study";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!researchMode) return <StudyCanvas account={null} />;

  const { user, profile } = await currentAccount();
  if (!user) redirect("/login");
  if (profile?.consent_version !== CONSENT_VERSION) redirect("/consent");
  return (
    <StudyCanvas
      account={{ userId: user.id, email: user.email ?? "", participantCode: profile.participant_code, admin: isAdmin(user.email) }}
    />
  );
}
