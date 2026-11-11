// The tutor's manners, and switches that turn one off for a session.
//
// CoInk's tutor holds back in four ways that the DIS paper studies as design
// choices. For a comparison session a researcher can break any of them; each
// switch here names the manner it breaks, so `{ overLine: true }` means "this
// session the tutor writes over the learner's line". The default is every
// manner kept, which is the ordinary tutor.

export const MANNERS = ["overLine", "writeStep", "speakAtOnce", "inkAtOnce"] as const;
export type MannerKey = (typeof MANNERS)[number];
export type Manners = Record<MannerKey, boolean>;

export const KEPT: Manners = { overLine: false, writeStep: false, speakAtOnce: false, inkAtOnce: false };

// What each switch does, in words for the researcher's panel and the session file.
export const MANNER_INFO: Record<MannerKey, { kept: string; broken: string }> = {
  overLine: {
    kept: "The learner's line is theirs: the tutor writes below or beside it.",
    broken: "Writes over the learner's line: notes and math land on top of their writing.",
  },
  writeStep: {
    kept: "Point before you write: one hint rung a turn, steps only after real attempts.",
    broken: "Writes the next step itself: no hint ladder, the tutor does the next line.",
  },
  speakAtOnce: {
    kept: "A glance is not a turn: waits for a real pause, never talks over the learner.",
    broken: "Speaks at once: looks a moment after any pen lift and talks even mid-sentence.",
  },
  inkAtOnce: {
    kept: "The hand takes time: ink is written stroke by stroke with the voice.",
    broken: "Ink appears all at once: the whole phrase's ink shows the moment it starts.",
  },
};

export const MANNER_LABEL: Record<MannerKey, string> = {
  overLine: "Write over the learner's line",
  writeStep: "Write the next step itself",
  speakAtOnce: "Speak at once, no pause",
  inkAtOnce: "Ink appears all at once",
};

// Reads switches from anything shaped like them (a request body, saved
// settings, a URL), keeping only known keys set to true.
export function readManners(value: unknown): Manners {
  const out = { ...KEPT };
  if (typeof value === "string") {
    for (const k of value.split(/[\s,]+/)) if ((MANNERS as readonly string[]).includes(k)) out[k as MannerKey] = true;
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const k of MANNERS) out[k] = (value as Record<string, unknown>)[k] === true;
  return out;
}

export const brokenManners = (m: Manners): MannerKey[] => MANNERS.filter((k) => m[k]);

// How long after the pen lifts the tutor glances at the page.
export function glanceDelay(m: Manners, besidePaper: boolean): number {
  if (m.speakAtOnce) return 300;
  return besidePaper ? 3500 : 1500;
}

// The extra instruction the model gets when a session breaks "point before you write".
export const WRITE_STEP_PROMPT = `Study variant: you do the next step yourself. This overrides the hint ladder and the rule to wait for real attempts. Whenever the student pauses, is stuck, asks, or has made an error, write the next line of their solution yourself in that beat's write (one line, correctly worked), saying what you did as you write it; if they made an error, write the corrected line. Don't ask them for their plan, don't only point, and don't wait for attempts. Still do one step per turn, not the whole solution, unless they ask for it. Use next_step for these turns. When their latest line is correct and they are clearly mid-step, you may still wait.`;
