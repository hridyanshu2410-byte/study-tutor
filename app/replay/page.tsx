import Replay from "@/components/Replay";
import { researchMode } from "@/lib/supabase/env";

export const metadata = { title: "Replay · CoInk" };

export default function ReplayPage() {
  return <Replay cloud={researchMode} />;
}
