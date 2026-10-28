import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLines, type Stroke } from "./ink.ts";
import { Pen, planAnnotations, retime, seeded, speechMs, strokeAt, TurnPlanner } from "./handwriting.ts";
import { drawFigure } from "./figures.ts";
import type { Figure } from "./figure-schema.ts";
import type { Box } from "./ink.ts";

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

// The box each tagged part of a figure covers.
const partBoxes = (fig: Figure, size = 28) => {
  const pen = new Pen(1);
  drawFigure(pen, fig, 0, 0, size, seeded(9));
  const out = new Map<string, Box>();
  for (const s of pen.strokes) {
    for (const [x, y] of s.points) {
      const b = out.get(s.tag ?? "") ?? { x, y, w: 0, h: 0 };
      const x0 = Math.min(b.x, x), y0 = Math.min(b.y, y);
      out.set(s.tag ?? "", { x: x0, y: y0, w: Math.max(b.x + b.w, x) - x0, h: Math.max(b.y + b.h, y) - y0 });
    }
  }
  return out;
};

test("diagram boxes sit on their grid cells, and two in one cell move apart", () => {
  const boxes = partBoxes({
    kind: "diagram",
    title: null,
    nodes: [
      { id: "a", text: "encoder", row: 0, col: 0 },
      { id: "b", text: "decoder", row: 0, col: 1 },
      { id: "c", text: "loss", row: 1, col: 0 },
      { id: "d", text: "same cell as c", row: 1, col: 0 },
    ],
    edges: [],
    frames: [],
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => boxes.get(`node:${id}`)!);
  assert.ok(b.x > a.x + a.w && Math.abs(b.y + b.h / 2 - (a.y + a.h / 2)) < 30, "a row runs left to right");
  assert.ok(c.y > a.y + a.h && Math.abs(c.x + c.w / 2 - (a.x + a.w / 2)) < 30, "a column runs down");
  assert.ok(d.x > c.x + c.w, "the second box in a cell moves to the next one");
});

test("paper margin notes go in the workspace column beside the passage", () => {
  const plan = planAnnotations([], [], 7, {
    column: { x: 770, top: 0 },
    marks: [{ boxes: [{ x: 60, y: 400, w: 300, h: 14 }], kind: "underline", note: "the key idea", edge: 700 }],
  });
  assert.ok(plan.box && plan.box.x + plan.box.w > 770, "note is in the column");
  assert.ok(plan.box && plan.box.y < 420 && plan.box.y + plan.box.h > 390, "note sits level with the passage");
});

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const flowchart = {
  kind: "diagram" as const,
  title: null,
  nodes: ["a", "b", "c", "d"].map((id, i) => ({ id, text: `Stage ${id} of the method`, row: i, col: 0 })),
  edges: [{ from: "a", to: "b", label: null }, { from: "b", to: "c", label: null }, { from: "c", to: "d", label: null }],
  frames: [],
};

test("in paper mode nothing the tutor writes lands on earlier writing", () => {
  const column = { x: 770, top: 0, bottom: 900 };
  const first = planAnnotations([], [], 3, {
    column,
    figures: [flowchart],
    marks: [{ boxes: [{ x: 60, y: 200, w: 300, h: 14 }], kind: "highlight", note: "what goes in and comes out of the system", edge: 700 }],
  });
  const second = planAnnotations([], [], 4, {
    column,
    avoid: first.parts,
    figures: [flowchart],
    marks: [{ boxes: [{ x: 60, y: 210, w: 300, h: 14 }], kind: "underline", note: "the scale gap", edge: 700 }],
  });
  const all = [...(first.parts ?? []), ...(second.parts ?? [])];
  assert.equal(all.length, 4);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), `parts ${i} and ${j} overlap`);
  // the second note stays near its passage rather than far down the page
  const note = second.parts![0];
  assert.ok(Math.abs(note.y - 210) < 120, `note at ${note.y}`);
});

test("the pen keeps pace with the voice", () => {
  const plan = planAnnotations([], [], 5, { column: { x: 770, top: 0 }, figures: [flowchart] });
  const fast = retime(plan, speechMs("Here is the method in four stages.") / plan.duration);
  assert.ok(fast.duration < plan.duration && fast.duration >= plan.duration * 0.35);
  assert.equal(fast.strokes.at(-1)!.end, fast.duration);
  assert.equal(retime(plan, 5), plan, "never slowed down");
});

test("a sketch draws smooth curves, circles, arrows and pointing labels", () => {
  const plan = planAnnotations([], [], 6, {
    column: { x: 770, top: 0 },
    figures: [
      {
        kind: "sketch",
        title: "A simulated community",
        paths: [{ points: [[20, 40], [15, 60], [25, 80]], closed: false, smooth: true }],
        circles: [{ cx: 20, cy: 30, r: 6, filled: false }, { cx: 70, cy: 50, r: 1, filled: true }],
        arrows: [{ from: [30, 50], to: [60, 50] }],
        labels: [{ x: 60, y: 90, text: "persona", point_to: [20, 30] }],
      },
    ],
  });
  assert.ok(plan.strokes.length > 8);
  assert.ok(plan.box && plan.box.w > 150 && plan.box.h > 150, "big enough to read");
});

const samePoints = (a: { points: [number, number][] }, b: { points: [number, number][] }) => JSON.stringify(a.points) === JSON.stringify(b.points);

test("a figure built up phrase by phrase draws only its new parts each time, in the same place", () => {
  const planner = new TurnPlanner([], 11, { column: { x: 770, top: 0, bottom: 900 }, size: 19 });
  const first = planner.plan({
    figures: [{ kind: "diagram", title: "The method", nodes: [{ id: "in", text: "tokens", row: 0, col: 0 }], edges: [], frames: [] }],
  });
  const second = planner.plan({
    continueFigure: true,
    figures: [{ kind: "diagram", title: null, nodes: [{ id: "route", text: "router", row: 0, col: 1 }], edges: [{ from: "in", to: "route", label: null }], frames: [] }],
  });
  const third = planner.plan({
    continueFigure: true,
    figures: [{ kind: "diagram", title: null, nodes: [{ id: "out", text: "experts", row: 1, col: 1 }], edges: [{ from: "route", to: "out", label: "top-2" }], frames: [] }],
  });
  for (const p of [first, second, third]) {
    assert.ok(p.strokes.length > 2);
    // each phrase's ink starts as soon as the phrase is heard
    assert.ok(p.strokes[0].start < 400, `starts at ${p.strokes[0].start}`);
    for (let i = 1; i < p.strokes.length; i++) assert.ok(p.strokes[i].start >= p.strokes[i - 1].end);
  }
  // nothing already on the page is drawn again
  for (const s of [...second.strokes, ...third.strokes]) assert.ok(!first.strokes.some((f) => samePoints(f, s)));
  for (const s of third.strokes) assert.ok(!second.strokes.some((f) => samePoints(f, s)));
  // each phrase knows the whole figure so far, for the view to follow
  assert.ok(third.figure && first.figure);
  assert.ok(third.figure.w > first.figure.w && third.figure.h > first.figure.h);
  for (const p of [second, third]) {
    const b = p.box!;
    assert.ok(b.x >= third.figure.x - 1 && b.y >= third.figure.y - 1 && b.x + b.w <= third.figure.x + third.figure.w + 1 && b.y + b.h <= third.figure.y + third.figure.h + 1);
  }
  // the new boxes go beside the first, to its right and below it
  assert.ok(second.box!.x > first.box!.x + first.box!.w * 0.5, "the router is to the right of the tokens");
  assert.ok(third.box!.y + third.box!.h > second.box!.y + second.box!.h, "the experts are below the router");
  assert.ok(Math.abs(second.box!.y - first.box!.y) < 200, "on the same row");
});

test("equation steps added phrase by phrase stay lined up on the equals sign", () => {
  const planner = new TurnPlanner(lines, 5);
  const first = planner.plan({ figures: [{ kind: "steps", lines: [{ math: "2x + 5 = 11", note: "−5" }] }] });
  const second = planner.plan({ continueFigure: true, figures: [{ kind: "steps", lines: [{ math: "2x = 6", note: "÷2" }] }] });
  const third = planner.plan({ continueFigure: true, figures: [{ kind: "steps", lines: [{ math: "x = 3", note: null }] }] });
  // each new line goes under the last one
  assert.ok(second.box!.y > first.box!.y + first.box!.h * 0.5);
  assert.ok(third.box!.y > second.box!.y + second.box!.h * 0.5);
  // a short line starts further right than a long one, so the equals signs line up
  assert.ok(third.box!.x > first.box!.x + 20, `x = 3 starts at ${third.box!.x}, 2x + 5 = 11 at ${first.box!.x}`);
});

test("what later phrases write never lands on what earlier phrases wrote", () => {
  const planner = new TurnPlanner(lines, 8);
  const plans = [
    planner.plan({ write: ["Try: 2y + 3 = 7"] }),
    planner.plan({ figures: [{ kind: "number_line", from: -5, to: 5, marks: [{ at: 2, label: "y", open: false }], jumps: [], shade_from: null, shade_to: null }] }),
    planner.plan({ write: ["2y = 4"] }),
    planner.plan({ annotations: [{ kind: "circle", line_id: "L1", from_token: 1, to_token: 2, text: null, placement: null, arrow: false }] }),
  ];
  const parts = plans.flatMap((p) => p.parts ?? []);
  assert.equal(parts.length, 3);
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) assert.ok(!overlaps(parts[i], parts[j]), `parts ${i} and ${j} overlap`);
  assert.deepEqual(planner.parts, parts);
});
