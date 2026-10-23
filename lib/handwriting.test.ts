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

test("written work goes below the student's lines and any earlier tutor ink, line after line", () => {
  const avoid = [{ x: 0, y: 60, w: 100, h: 40 }];
  const plan = planAnnotations([], lines, 3, { write: ["Try: 2y + 3 = 7", "2y = 4"], avoid });
  assert.ok(plan.strokes.length > 10);
  const top = Math.min(...plan.strokes.flatMap((s) => s.points.map(([, y]) => y)));
  assert.ok(top > 100, `work starts below earlier ink (top ${top})`);
  for (let i = 1; i < plan.strokes.length; i++) assert.ok(plan.strokes[i].start >= plan.strokes[i - 1].end);
});

test("every kind of figure draws, below the work, one stroke after another", () => {
  const figures = [
    { kind: "graph" as const, x_min: -3, x_max: 3, y_min: -2, y_max: 8, x_label: "x", y_label: "y", curves: [{ formula: "x^2 - 1", label: "y = x² − 1" }, { formula: "1/x", label: null }], points: [{ x: 1, y: 0, label: "(1, 0)" }] },
    { kind: "number_line" as const, from: -5, to: 5, marks: [{ at: 2, label: "x", open: true }], jumps: [{ from: -3, to: 2, label: "+5" }], shade_from: 2, shade_to: 5 },
    { kind: "shape" as const, vertices: [{ x: 0, y: 0, label: "A" }, { x: 4, y: 0, label: "B" }, { x: 0, y: 3, label: "C" }], closed: true, side_labels: ["4", "5", "3"], angle_labels: ["90°", null, "θ"] },
    { kind: "flow" as const, direction: "right" as const, nodes: [{ text: "Glucose" }, { text: "Pyruvate" }, { text: "ATP made in the mitochondria" }], arrows: [{ from: 0, to: 1, label: "glycolysis" }, { from: 1, to: 2, label: null }] },
    { kind: "table" as const, header: true, rows: [["", "B", "b"], ["B", "BB", "?"], ["b", "?", "bb"]] },
    { kind: "forces" as const, body: "block" as const, incline_deg: 30, forces: [{ label: "mg", angle_deg: 270, size: 1 }, { label: "N", angle_deg: 120, size: 0.8 }, { label: "f", angle_deg: 30, size: 0.4 }] },
    { kind: "steps" as const, lines: [{ math: "5x² + 5 = 10", note: "−5" }, { math: "5x² = 5", note: "÷5" }, { math: "x² = 1", note: null }] },
  ];
  for (const fig of figures) {
    const plan = planAnnotations([], lines, 5, { figures: [fig] });
    assert.ok(plan.strokes.length > 5, `${fig.kind} drew ${plan.strokes.length} strokes`);
    for (let i = 1; i < plan.strokes.length; i++) assert.ok(plan.strokes[i].start >= plan.strokes[i - 1].end);
    const top = Math.min(...plan.strokes.flatMap((s) => s.points.map(([, y]) => y)));
    assert.ok(top > lines[0].box.y + lines[0].box.h, `${fig.kind} starts below the student's line`);
    for (const s of plan.strokes) for (const [x, y] of s.points) assert.ok(Number.isFinite(x) && Number.isFinite(y), fig.kind);
  }
});

test("a figure with a formula it can't read still draws the rest", () => {
  const plan = planAnnotations([], lines, 5, {
    figures: [{ kind: "graph", x_min: 0, x_max: 1, y_min: 0, y_max: 1, x_label: null, y_label: null, curves: [{ formula: "window.close()", label: null }], points: [] }],
  });
  assert.ok(plan.strokes.length > 3);
});
