import { test } from "node:test";
import assert from "node:assert/strict";
import { BeatChecker, readingFlag, TurnScanner } from "./turn-stream.ts";
import type { Beat } from "./tutor.ts";

const beat = (say: string, more: Partial<Beat> = {}): Beat => ({
  say,
  write: [],
  draw: null,
  continue_figure: false,
  highlights: [],
  annotations: [],
  ...more,
});

const turn = {
  private: { reading: [{ line_id: "L1", latex: "x^2 = 4" }], first_error_line: null, diagnosis: "Fine so far.", solution_sketch: "x = ±2" },
  move: "point",
  beats: [
    beat('Look at the "square" here, {and} what it hides: \\pm.', { annotations: [{ kind: "circle", line_id: "L1", from_token: 1, to_token: 1, text: null, placement: null, arrow: false }] }),
    beat("What else squares to four?", { write: ["(−2)² = ?"] }),
  ],
  simulate: null,
  skill: { concept: "square roots", evidence: "slip" },
  card: null,
  review_result: null,
};

test("each beat is read the moment it is complete, however the text is cut", () => {
  const json = JSON.stringify(turn, null, 1);
  for (const size of [1, 3, 7, 64]) {
    const scan = new TurnScanner();
    const seen: number[] = [];
    for (let i = 0; i < json.length; i += size) {
      scan.push(json.slice(i, i + size));
      seen.push(scan.beats.length);
      // the private notes are known before the first beat arrives
      if (scan.beats.length) assert.deepEqual(scan.values.get("private"), turn.private);
    }
    assert.deepEqual(scan.beats, turn.beats, `chunks of ${size}`);
    // the first beat was out before the second one was finished
    const firstAt = seen.indexOf(1);
    assert.ok(firstAt >= 0 && firstAt < seen.indexOf(2));
    assert.equal(scan.values.get("move"), "point");
    assert.deepEqual(scan.values.get("skill"), turn.skill);
    assert.equal(scan.values.get("simulate"), null);
    assert.equal(scan.values.get("review_result"), null);
    assert.deepEqual(scan.values.get("beats"), turn.beats);
    assert.equal(scan.text, json);
  }
});

test("a beat's words are known before its ink", () => {
  const scan = new TurnScanner();
  scan.push('{"private":{"reading":[],"first_error_line":null,"diagnosis":"","solution_sketch":""},"move":"point","beats":[{"say":"Look at the');
  assert.equal(scan.upcoming, null, "not until the words are complete");
  scan.push(' \\"square\\" here,","write":["x');
  assert.equal(scan.upcoming, 'Look at the "square" here,');
  scan.push('² = 4"],"draw":null,"continue_figure":false,"highlights":[],"annotations":[]},');
  assert.equal(scan.beats.length, 1);
  assert.equal(scan.upcoming, null, "the next beat hasn't started");
  scan.push('{"say":"What else?"');
  assert.equal(scan.upcoming, "What else?");
});

test("a move is known before the beats that follow it", () => {
  const scan = new TurnScanner();
  scan.push('{"private":{"reading":[],"first_error_line":null,"diagnosis":"","solution_sketch":""},"move":"wait","beats":[');
  assert.equal(scan.values.get("move"), "wait");
  assert.equal(scan.beats.length, 0);
});

test("the checker reads the student's page against the tutor's reading", () => {
  const reading = [{ line_id: "L1", latex: "5x^2 + 5 = 10" }, { line_id: "L2", latex: "5x^2 = 15" }];
  const missed = readingFlag({ reading, first_error_line: null, diagnosis: "", solution_sketch: "" });
  assert.ok(missed?.includes("L2"));
  assert.equal(readingFlag({ reading, first_error_line: "L2", diagnosis: "", solution_sketch: "" }), null);
  assert.equal(readingFlag(undefined), null);
});

test("beats are held to the turn's limits as they arrive", () => {
  const check = new BeatChecker({ paperText: null, lines: new Set(["L1"]) });
  const long = check.sanitize(beat("  Here.  ", { write: ["a = 1", "b = 2", "c = 3"], highlights: [{ ref: "p1.s1", kind: "highlight", note: null }] }))!;
  assert.equal(long.say, "Here.");
  assert.deepEqual(long.write, ["a = 1", "b = 2"], "at most two lines a beat");
  assert.deepEqual(long.highlights, [], "highlights are for papers only");
  check.commit(long);
  // marks on lines the student never wrote are dropped
  const mark = check.sanitize(beat("This one.", { annotations: [{ kind: "circle", line_id: "L9", from_token: null, to_token: null, text: null, placement: null, arrow: false }] }))!;
  assert.deepEqual(mark.annotations, []);
  assert.equal(check.sanitize({ say: "no ink fields" }), null, "not a beat");
  assert.equal(check.sanitize(beat("", { write: [] })), null, "nothing in it");
  for (let i = 0; i < 7; i++) check.commit(beat("More."));
  assert.equal(check.sanitize(beat("One too many.")), null, "eight beats at most");
});

test("in paper mode only sentences in the paper can be highlighted", () => {
  const check = new BeatChecker({ paperText: "[p1.s1] We propose a router. [p1.s2] It is fast.", lines: new Set() });
  const b = check.sanitize(
    beat("They propose a router.", {
      highlights: [
        { ref: "p1.s1", kind: "highlight", note: "  the main idea  " },
        { ref: "p9.s9", kind: "underline", note: null },
        { ref: "made up", kind: "underline", note: null },
      ],
    }),
  )!;
  assert.deepEqual(b.highlights, [{ ref: "p1.s1", kind: "highlight", note: "the main idea" }]);
});

test("a slip in the tutor's math is caught across beats, and cut if it comes back", () => {
  const check = new BeatChecker({ paperText: null, lines: new Set() });
  const first = check.sanitize(beat("Take five from both sides.", { write: ["5x² + 5 = 10"] }))!;
  assert.equal(check.slip(first), null);
  check.commit(first);
  // the second line doesn't follow from the first one written a beat earlier
  const wrong = check.sanitize(beat("That leaves this.", { write: ["5x² = 15", "x² = 3"] }))!;
  assert.match(check.slip(wrong) ?? "", /In what you wrote/);
  check.strip(wrong);
  assert.deepEqual(wrong.write, [], "everything from the slip on is cut");
  const right = check.sanitize(beat("That leaves this.", { write: ["5x² = 5"] }))!;
  assert.equal(check.slip(right), null);
});

test("steps grown over beats are checked as one figure", () => {
  const check = new BeatChecker({ paperText: null, lines: new Set() });
  const start = check.sanitize(beat("Start here.", { draw: { kind: "steps", lines: [{ math: "2x + 5 = 11", note: "−5" }] } }))!;
  check.commit(start);
  const next = check.sanitize(beat("Then this.", { continue_figure: true, draw: { kind: "steps", lines: [{ math: "2x = 16", note: null }] } }))!;
  assert.match(check.slip(next) ?? "", /In the steps you drew/);
  check.strip(next);
  assert.equal(next.draw, null, "the slipped line is never drawn");
  const fixed = check.sanitize(beat("Then this.", { continue_figure: true, draw: { kind: "steps", lines: [{ math: "2x = 6", note: "÷2" }, { math: "x = 3", note: null }] } }))!;
  assert.equal(check.slip(fixed), null);
  check.commit(fixed);
  // a new steps figure starts its own chain
  const fresh = check.sanitize(beat("Another one.", { draw: { kind: "steps", lines: [{ math: "y = 1", note: null }] } }))!;
  assert.equal(check.slip(fresh), null);
});
