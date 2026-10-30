// What a person says the moment they're asked something, while they gather
// their thoughts: short, natural, never the same twice in a row, and never
// committing the tutor to an answer. Said only when the student spoke,
// asked or opened something, never when the tutor glances at the page unasked.

import type { TutorRequest } from "./tutor.ts";

const LINES = {
  asked: ["Okay, let's see.", "Sure, let me look.", "Mm, let's have a look.", "Okay, let me see."],
  question: ["Hmm, let me think.", "Ooh, okay.", "Mm, good question.", "Hmm."],
  spoke: ["Mm-hm.", "Mm.", "Okay.", "Mm, okay."],
  watched: ["Ooh, look at that.", "Okay, interesting."],
  wrap_up: ["Okay, let's wrap up.", "Alright, let's wrap up."],
};

// Every fixed line, to fetch their voices once ahead of time.
export const ALL_LINES: string[] = Object.values(LINES).flat();

const QUESTION = /\?\s*$|^(why|how|what|when|where|which|who|can|could|would|should|is|are|do|does|did|will|wait)\b/i;

let last = "";
const pick = (options: string[]): string => {
  const fresh = options.filter((o) => o !== last);
  last = fresh[Math.floor(Math.random() * fresh.length)] ?? options[0];
  return last;
};

// The paper's name the way a person would say it in passing: the part
// before a colon, if that's only a word or three.
export function shortTitle(title: string): string | null {
  const head = title.split(/[:—–]|\s-\s/)[0].replace(/\s+/g, " ").trim();
  return head && head.length <= 28 && head.split(" ").length <= 3 ? head : null;
}

// What to say, and how long after the ask to say it if the tutor hasn't started answering.
export function thinkingAloud(trigger: TutorRequest["trigger"], speech: string | null, paperTitle: string | null): { text: string; after: number } | null {
  if (trigger === "paper_opened") {
    const name = paperTitle ? shortTitle(paperTitle) : null;
    // short, so the explanation never waits for it
    return { text: name ? `${pick(["Ooh", "Oh nice", "Okay"])}, ${name}.` : pick(["Ooh, a new paper.", "Okay, let's have a look.", "Ooh, let's see."]), after: 250 };
  }
  if (trigger === "asked") return { text: pick(LINES.asked), after: 350 };
  if (trigger === "spoke") return { text: pick(QUESTION.test((speech ?? "").trim()) ? LINES.question : LINES.spoke), after: 300 };
  if (trigger === "watched") return { text: pick(LINES.watched), after: 300 };
  if (trigger === "wrap_up") return { text: pick(LINES.wrap_up), after: 250 };
  return null;
}
