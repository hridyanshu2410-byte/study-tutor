import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLatencies, firstWriters, markPlacements, measureRow, MEASURE_COLUMNS, yields } from "./session-measures.ts";
import type { LogEvent, SessionFile, TimedPoint } from "./session-log.ts";
import { KEPT } from "./manners.ts";

const line = (x: number, y: number, n = 6): TimedPoint[] => Array.from({ length: n }, (_, i) => [x + i * 10, y + (i % 2) * 20, 0.5, i * 20]);

function file(events: LogEvent[]): SessionFile {
  return { format: "coink-session", version: 1, id: "f", startedAt: 0, savedAt: 0, tutor: "ai", manners: KEPT, problem: "", app: {}, duration: 60000, events };
}

const student = (id: string, t: number, x: number, y: number): LogEvent => ({ t, type: "stroke", who: "student", id, color: "#000", size: 4, pts: line(x, y), end: t + 100 });

test("marks are placed on, beside, near or apart from the learner's lines", () => {
  const f = file([
    student("a", 0, 0, 0),
    // a circle-like mark over the learner's line
    { t: 1000, type: "tutor_ink", id: "i1", turn: 1, beat: 1, strokes: [{ points: [[5, 5], [30, 10], [45, 15]], start: 0, end: 300 }], duration: 300 },
    // a written line well below it
    { t: 2000, type: "tutor_ink", id: "i2", turn: 1, beat: 2, strokes: [{ points: [[0, 100], [40, 110]], start: 0, end: 300 }], duration: 300 },
    { t: 3000, type: "tutor_ink", id: "i3", turn: 2, beat: 1, strokes: [{ points: [[0, 900], [40, 910]], start: 0, end: 300 }], duration: 300 },
  ]);
  assert.deepEqual(markPlacements(f).map((m) => m.place), ["on", "near", "apart"]);
});

test("human tutor strokes close in time and space are one mark", () => {
  const f = file([
    student("a", 0, 0, 0),
    { t: 1000, type: "stroke", who: "human_tutor", id: "h1", color: "#c2410c", size: 4, pts: line(200, 0), end: 1200 },
    { t: 1500, type: "stroke", who: "human_tutor", id: "h2", color: "#c2410c", size: 4, pts: line(230, 0), end: 1700 },
    { t: 9000, type: "stroke", who: "human_tutor", id: "h3", color: "#c2410c", size: 4, pts: line(230, 0), end: 9200 },
  ]);
  assert.equal(markPlacements(f).length, 2);
});

test("each line's first writer is found", () => {
  const f = file([
    student("a", 0, 0, 0),
    { t: 1000, type: "tutor_ink", id: "i1", turn: 1, beat: 1, strokes: [{ points: [[0, 200], [40, 220]], start: 0, end: 300 }], duration: 300 },
    student("b", 5000, 60, 200),
  ]);
  const lines = firstWriters(f);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].first, "student");
  assert.equal(lines[1].first, "tutor");
  assert.equal(lines[1].learnerInk, 1);
});

test("time from a marked error to the tutor's next act, ignoring filler", () => {
  const f = file([
    { t: 1000, type: "note", kind: "error", text: "sign slip" },
    { t: 1500, type: "speech", who: "tutor", text: "Okay, let's see", end: 2000, aside: true },
    { t: 4200, type: "speech", who: "tutor", text: "Look at this sign.", end: 6000, turn: 1, beat: 1 },
  ]);
  assert.deepEqual(errorLatencies(f), [{ at: 1000, label: "sign slip", firstAct: 4200, ms: 3200 }]);
});

test("the tutor stopping, or not, when the learner resumes", () => {
  const f = file([
    { t: 0, type: "speech", who: "tutor", text: "a long explanation", end: 10000, turn: 1, beat: 1 },
    student("a", 3000, 0, 0),
    { t: 20000, type: "speech", who: "human_tutor", text: "so", end: 22000 },
    student("b", 21500, 0, 50),
  ]);
  assert.deepEqual(yields(f).map((y) => y.stopped), [false, true]);
});

test("a row per session matches the columns", () => {
  assert.equal(measureRow(file([student("a", 0, 0, 0)])).length, MEASURE_COLUMNS.length);
});
