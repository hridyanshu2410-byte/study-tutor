"use client";

// The student's cards and mastery. Saved in the browser, and in research mode
// also to their account, so a tester's progress follows them across devices.

import { useCallback, useEffect, useRef, useState } from "react";
import { emptyMemory, type StudyMemory } from "./review.ts";
import { loadCloud, saveCloud, type Account } from "./cloud.ts";

const KEY = "study-tutor:memory:v1";

const keyFor = (account: Account | null) => (account ? `${KEY}:${account.userId}` : KEY);

function isMemory(m: unknown): m is StudyMemory {
  return Boolean(m && typeof m === "object" && Array.isArray((m as StudyMemory).cards) && (m as StudyMemory).skills);
}

function loadLocal(key: string): StudyMemory {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isMemory(saved)) return saved;
  } catch {
    // A blocked or corrupt store starts fresh.
  }
  return emptyMemory();
}

export function useStudyMemory(account: Account | null) {
  const [memory, setMemory] = useState<StudyMemory>(emptyMemory);
  const ref = useRef(memory);
  const [storageFull, setStorageFull] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const key = keyFor(account);
  const userId = account?.userId ?? null;

  const writeLocal = useCallback(
    (m: StudyMemory) => {
      try {
        localStorage.setItem(key, JSON.stringify(m));
        setStorageFull(false);
      } catch {
        // Cards with kept ink can outgrow browser storage; the account copy still has them.
        setStorageFull(!userId);
      }
    },
    [key, userId],
  );

  useEffect(() => {
    let cancelled = false;
    const local = loadLocal(key);
    ref.current = local;
    setMemory(local);
    if (!userId) {
      setLoaded(true);
      return;
    }
    loadCloud(userId, "memory")
      .then((cloud) => {
        if (cancelled) return;
        if (isMemory(cloud)) {
          ref.current = cloud;
          setMemory(cloud);
          writeLocal(cloud);
        } else if (local.cards.length || Object.keys(local.skills).length) {
          saveCloud(userId, "memory", local);
        }
      })
      .catch(() => {
        // Offline: carry on with the local copy; the next change syncs it.
      })
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [key, userId, writeLocal]);

  // Updates apply to the latest memory, so several in one tick don't race.
  const update = useCallback(
    (fn: (m: StudyMemory) => StudyMemory) => {
      ref.current = fn(ref.current);
      setMemory(ref.current);
      writeLocal(ref.current);
      if (userId) saveCloud(userId, "memory", ref.current);
    },
    [userId, writeLocal],
  );

  return { memory, memoryRef: ref, update, storageFull, loaded };
}
