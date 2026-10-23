"use client";

// Saving to the tester's account in research mode. The browser keeps a local
// copy too, so a dropped connection never loses a page; the account copy wins
// when a tester opens the app on another device.

import { browserClient } from "./supabase/client";

export type Account = { userId: string; email: string; participantCode: string; admin: boolean };

export type EventKind = "card_created" | "review_graded" | "review_started" | "deck_imported" | "feedback" | "session_finished" | "survey" | "test" | "photo_added";

type Column = "page" | "memory";

export async function loadCloud(userId: string, column: Column): Promise<unknown | null> {
  const { data, error } = await browserClient().from("study_state").select(column).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as Record<Column, unknown> | null)?.[column] ?? null;
}

const pending = new Map<string, { userId: string; patch: Partial<Record<Column, unknown>> }>();
let timer: ReturnType<typeof setTimeout> | null = null;

// Writes are batched for a second so a burst of strokes is one request.
export function saveCloud(userId: string, column: Column, value: unknown) {
  const entry = pending.get(userId) ?? { userId, patch: {} };
  entry.patch[column] = value;
  pending.set(userId, entry);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushCloud, 1000);
}

export async function flushCloud() {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = [...pending.values()];
  pending.clear();
  for (const { userId, patch } of batch) {
    const { error } = await browserClient()
      .from("study_state")
      .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) {
      // Keep it for the next attempt rather than dropping the tester's work.
      const again = pending.get(userId) ?? { userId, patch: {} };
      pending.set(userId, { userId, patch: { ...patch, ...again.patch } });
      timer ??= setTimeout(flushCloud, 5000);
    }
  }
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pending.size) flushCloud();
  });
}

export function logEvent(account: Account | null, kind: EventKind, data: Record<string, unknown>, sessionId: string | null) {
  if (!account) return;
  browserClient()
    .from("events")
    .insert({ user_id: account.userId, kind, data, session_id: sessionId })
    .then(({ error }) => {
      if (error) console.warn("Could not log study event", kind, error.message);
    });
}
