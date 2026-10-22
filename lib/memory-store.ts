"use client";

// The student's cards and mastery, saved on this device. Everything goes
// through `useStudyMemory`, so moving storage to accounts later changes this
// file and nothing that uses it.

import { useCallback, useEffect, useRef, useState } from "react";
import { emptyMemory, type StudyMemory } from "./review.ts";

const KEY = "study-tutor:memory:v1";

function load(): StudyMemory {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && Array.isArray(saved.cards) && saved.skills) return saved;
  } catch {
    // A blocked or corrupt store starts fresh.
  }
  return emptyMemory();
}

export function useStudyMemory() {
  const [memory, setMemory] = useState<StudyMemory>(emptyMemory);
  const ref = useRef(memory);
  const [storageFull, setStorageFull] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ref.current = load();
    setMemory(ref.current);
    setLoaded(true);
  }, []);

  // Updates apply to the latest memory, so several in one tick don't race.
  const update = useCallback((fn: (m: StudyMemory) => StudyMemory) => {
    ref.current = fn(ref.current);
    setMemory(ref.current);
    try {
      localStorage.setItem(KEY, JSON.stringify(ref.current));
      setStorageFull(false);
    } catch {
      setStorageFull(true);
    }
  }, []);

  return { memory, memoryRef: ref, update, storageFull, loaded };
}
