import { test } from "node:test";
import assert from "node:assert/strict";
import { Rating } from "ts-fsrs";
import {
  dueAt,
  dueCards,
  emptyMemory,
  gradeCard,
  masteryMap,
  newCard,
  recordEvidence,
  shouldAddMistakeCard,
  weakSpots,
} from "./review.ts";

const t0 = new Date("2026-10-22T10:00:00Z");
const later = (days: number) => new Date(t0.getTime() + days * 24 * 3600 * 1000);

test("a new card is due at once and moves out after a good review", () => {
  const card = newCard({ concept: " Chain  Rule ", source: "mistake", prompt: "d/dx sin(x²)" }, t0, "c1");
  assert.equal(card.concept, "chain rule");
  assert.deepEqual(dueCards([card], t0).map((c) => c.id), ["c1"]);
  const reviewed = gradeCard(card, Rating.Good, t0);
  assert.ok(dueAt(reviewed) > t0.getTime());
  assert.equal(reviewed.reviews.length, 1);
});

test("forgetting brings a card back sooner than recalling it easily", () => {
  let card = newCard({ concept: "u-sub", source: "kept", prompt: "∫ 2x cos(x²) dx" }, t0, "c1");
  for (let d = 0; d < 3; d++) card = gradeCard(card, Rating.Good, later(d * 3));
  const forgot = gradeCard(card, Rating.Again, later(10));
  const easy = gradeCard(card, Rating.Easy, later(10));
  assert.ok(dueAt(forgot) < dueAt(easy));
});

test("one mistake card per concept per session and per day", () => {
  const card = { ...newCard({ concept: "chain rule", source: "mistake", prompt: "p" }, t0, "c1"), sessionId: "s1" };
  assert.equal(shouldAddMistakeCard([card], "Chain rule", "s1", t0), false);
  assert.equal(shouldAddMistakeCard([card], "chain rule", "s2", later(0.5)), false);
  assert.equal(shouldAddMistakeCard([card], "chain rule", "s2", later(2)), true);
  assert.equal(shouldAddMistakeCard([card], "product rule", "s1", t0), true);
  assert.equal(shouldAddMistakeCard([card], "  ", "s1", t0), false);
});

test("evidence counts once per session and feeds mastery", () => {
  let skills = recordEvidence({}, "chain rule", "slip", "s1", t0);
  skills = recordEvidence(skills, "chain rule", "slip", "s1", t0);
  skills = recordEvidence(skills, "chain rule", "slip", "s2", later(1));
  skills = recordEvidence(skills, "power rule", "solved", "s2", later(1));
  assert.equal(skills["chain rule"].slips, 2);
  const map = masteryMap({ ...emptyMemory(), skills }, later(1));
  assert.deepEqual(map.map((m) => m.concept), ["chain rule", "power rule"]);
  assert.ok(map[0].mastery < 0.5 && map[1].mastery > 0.5);
  assert.deepEqual(weakSpots({ ...emptyMemory(), skills }, later(1)), ["chain rule"]);
});

test("reviewed cards raise mastery while they are remembered", () => {
  let card = newCard({ concept: "limits", source: "anki", prompt: "lim sin x / x", answerText: "1" }, t0, "c1");
  const skills = recordEvidence({}, "limits", "slip", "s1", t0);
  const before = masteryMap({ cards: [card], skills }, t0)[0].mastery;
  for (let d = 0; d < 4; d++) card = gradeCard(card, Rating.Good, later(d * 4));
  const after = masteryMap({ cards: [card], skills }, later(16))[0];
  assert.ok(after.mastery > before);
  assert.equal(after.cards, 1);
});
