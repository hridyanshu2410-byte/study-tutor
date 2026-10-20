import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLines, type Stroke } from "./ink.ts";
import { planAnnotations, strokeAt } from "./handwriting.ts";

const stroke = (id: string, x: number, y: number): Stroke => ({
  id,
  color: "#000",
  size: 3,
  createdAt: 0,
  points: [[x, y, 0.5], [x + 30, y + 40, 0.5]],
});

const lines = groupLines([stroke("a", 0, 0), stroke("b", 60, 0), stroke("c", 120, 0)]);

test("circle, arrow and note are drawn one after another, never at once", () => {
  const plan = planAnnotations(
    [
      { kind: "circle", line_id: "L1", from_token: 2, to_token: 3, text: null, placement: null, arrow: false },
      { kind: "note", line_id: "L1", from_token: 2, to_token: 3, text: "why?", placement: "right", arrow: true },
    ],
    lines,
    7,
  );
  assert.ok(plan.strokes.length > 4);
  for (let i = 1; i < plan.strokes.length; i++) assert.ok(plan.strokes[i].start >= plan.strokes[i - 1].end);
  assert.equal(plan.duration >= plan.strokes.at(-1)!.end, true);
  // the note is written to the right of the line, clear of the student's ink
  const last = plan.strokes.at(-1)!;
  assert.ok(Math.min(...last.points.map(([x]) => x)) > lines[0].box.x + lines[0].box.w);
});

test("the same seed draws the same ink, a different seed a slightly different hand", () => {
  const a = [{ kind: "circle" as const, line_id: "L1", from_token: 1, to_token: 1, text: null, placement: null, arrow: false }];
  assert.deepEqual(planAnnotations(a, lines, 1), planAnnotations(a, lines, 1));
  assert.notDeepEqual(planAnnotations(a, lines, 1), planAnnotations(a, lines, 2));
});

test("a stroke is revealed progressively", () => {
  const s = { points: Array.from({ length: 10 }, (_, i) => [i, 0] as [number, number]), start: 100, end: 200 };
  assert.equal(strokeAt(s, 50), null);
  assert.ok(strokeAt(s, 150)!.length < 10);
  assert.equal(strokeAt(s, 250)!.length, 10);
});
