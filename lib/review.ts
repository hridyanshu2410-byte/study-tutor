// Spaced review and mastery, kept pure so it runs the same in the browser and
// in tests. Scheduling is FSRS via ts-fsrs (MIT), the algorithm modern Anki
// uses; none of Anki's own code is involved.

import { createEmptyCard, fsrs, Rating, type CardInput, type Grade } from "ts-fsrs";

const scheduler = fsrs({ enable_fuzz: true });

export type CardSource = "mistake" | "kept" | "anki";

export type ReviewCard = {
  id: string;
  concept: string;
  source: CardSource;
  // What the student sees and works on by hand.
  prompt: string;
  // Shown after the attempt: the takeaway for a mistake card, or the back of an Anki card.
  takeaway: string | null;
  // The reference answer the tutor checks against. Only kept and Anki cards have one;
  // for a mistake card the tutor works the fresh problem itself.
  answerText: string | null;
  answerImage: string | null; // PNG data URL of ink the student kept
  deck: string | null;
  sessionId: string | null;
  createdAt: number;
  fsrs: CardInput; // dates are ISO strings once stored
  reviews: { at: number; rating: Grade }[];
};

export type ReviewOutcome = "forgot" | "struggled" | "recalled" | "easy";

export const OUTCOME_RATING: Record<ReviewOutcome, Grade> = {
  forgot: Rating.Again,
  struggled: Rating.Hard,
  recalled: Rating.Good,
  easy: Rating.Easy,
};

export const RATING_LABEL: Record<Grade, string> = {
  [Rating.Again]: "Again",
  [Rating.Hard]: "Hard",
  [Rating.Good]: "Good",
  [Rating.Easy]: "Easy",
};

export type SkillEvidence = "slip" | "progress" | "solved" | "none";

// What the tutor has seen on a concept during study sessions. Each session
// counts at most once per kind, so one long struggle is one slip, not ten.
export type Skill = {
  concept: string;
  slips: number;
  solved: number;
  lastSeen: number;
  slipSessions: string[];
  solvedSessions: string[];
};

export type StudyMemory = { cards: ReviewCard[]; skills: Record<string, Skill> };

export const emptyMemory = (): StudyMemory => ({ cards: [], skills: {} });

export function conceptKey(concept: string): string {
  return concept.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
}

export function newCard(
  fields: Pick<ReviewCard, "concept" | "source" | "prompt"> & Partial<Omit<ReviewCard, "id" | "fsrs" | "reviews" | "createdAt">>,
  now: Date,
  id: string,
): ReviewCard {
  return {
    takeaway: null,
    answerText: null,
    answerImage: null,
    deck: null,
    sessionId: null,
    ...fields,
    concept: conceptKey(fields.concept) || "general",
    id,
    createdAt: now.getTime(),
    fsrs: createEmptyCard(now),
    reviews: [],
  };
}

export function gradeCard(card: ReviewCard, rating: Grade, now: Date): ReviewCard {
  const { card: next } = scheduler.next(card.fsrs, now, rating);
  return { ...card, fsrs: next, reviews: [...card.reviews, { at: now.getTime(), rating }].slice(-30) };
}

export function dueAt(card: ReviewCard): number {
  return new Date(card.fsrs.due).getTime();
}

export function dueCards(cards: ReviewCard[], now: Date): ReviewCard[] {
  return cards.filter((c) => dueAt(c) <= now.getTime()).sort((a, b) => dueAt(a) - dueAt(b));
}

// Chance the student would recall this card right now (0 to 1), or null if it
// has never been reviewed.
export function recall(card: ReviewCard, now: Date): number | null {
  if (!card.reviews.length) return null;
  return scheduler.get_retrievability(card.fsrs, now, false);
}

// The tutor proposes at most one card per concept per session, and never a
// duplicate of a mistake card made in the last day.
export function shouldAddMistakeCard(cards: ReviewCard[], concept: string, sessionId: string, now: Date): boolean {
  const key = conceptKey(concept);
  if (!key) return false;
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  return !cards.some(
    (c) => c.source === "mistake" && c.concept === key && (c.sessionId === sessionId || c.createdAt > dayAgo),
  );
}

export function recordEvidence(
  skills: Record<string, Skill>,
  concept: string,
  evidence: SkillEvidence,
  sessionId: string,
  now: Date,
): Record<string, Skill> {
  const key = conceptKey(concept);
  if (!key || evidence === "none") return skills;
  const prev = skills[key] ?? { concept: key, slips: 0, solved: 0, lastSeen: 0, slipSessions: [], solvedSessions: [] };
  const next = { ...prev, lastSeen: now.getTime() };
  if (evidence === "slip" && !prev.slipSessions.includes(sessionId)) {
    next.slips += 1;
    next.slipSessions = [...prev.slipSessions, sessionId].slice(-20);
  }
  if (evidence === "solved" && !prev.solvedSessions.includes(sessionId)) {
    next.solved += 1;
    next.solvedSessions = [...prev.solvedSessions, sessionId].slice(-20);
  }
  return { ...skills, [key]: next };
}

export type ConceptMastery = {
  concept: string;
  mastery: number; // 0 to 1
  slips: number;
  solved: number;
  cards: number;
  due: number;
  nextDue: number | null;
};

// Mastery blends what the tutor saw in sessions (solved vs slipped, with a
// neutral prior) and how well review cards are being recalled. Recall gets the
// larger weight once cards have a few reviews, because it measures memory over time.
export function masteryMap(memory: StudyMemory, now: Date): ConceptMastery[] {
  const concepts = new Set([...Object.keys(memory.skills), ...memory.cards.map((c) => c.concept)]);
  return [...concepts]
    .map((concept) => {
      const skill = memory.skills[concept];
      const cards = memory.cards.filter((c) => c.concept === concept);
      const slips = skill?.slips ?? 0;
      const solved = skill?.solved ?? 0;
      const evidence = (solved + 1) / (solved + slips + 2);
      const reviewed = cards.filter((c) => c.reviews.length);
      // One good review a minute ago says little, so recall earns its weight
      // over the first three reviews.
      const confidence = Math.min(1, reviewed.reduce((n, c) => n + c.reviews.length, 0) / (3 * Math.max(1, reviewed.length)));
      const recalls = reviewed.map((c) => recall(c, now) ?? 0);
      const mastery = recalls.length ? evidence + (mean(recalls) - evidence) * 0.6 * confidence : evidence;
      const upcoming = cards.map(dueAt).sort((a, b) => a - b);
      return {
        concept,
        mastery,
        slips,
        solved,
        cards: cards.length,
        due: upcoming.filter((d) => d <= now.getTime()).length,
        nextDue: upcoming[0] ?? null,
      };
    })
    .sort((a, b) => a.mastery - b.mastery || a.concept.localeCompare(b.concept));
}

// The concepts worth the tutor watching for, weakest first.
export function weakSpots(memory: StudyMemory, now: Date, limit = 5): string[] {
  return masteryMap(memory, now)
    .filter((m) => m.slips > 0 && m.mastery < 0.7)
    .slice(0, limit)
    .map((m) => m.concept);
}

export function whenText(due: number, now: Date): string {
  const mins = Math.round((due - now.getTime()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `in ${days} d` : `in ${Math.round(days / 30)} mo`;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
