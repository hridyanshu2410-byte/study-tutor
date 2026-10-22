import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLines, spanBox, zoomAt, screenToWorld, strokesInLasso, type Stroke } from "./ink.ts";

const stroke = (id: string, x: number, y: number, w = 40, h = 30): Stroke => ({
  id,
  color: "#000",
  size: 0,
  createdAt: 0,
  points: [
    [x, y, 0.5],
    [x + w, y + h, 0.5],
  ],
});

test("strokes on the same row form one line, numbered top to bottom", () => {
  const lines = groupLines([stroke("c", 0, 200), stroke("a", 0, 0), stroke("b", 60, 5)]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].strokeIds.sort(), ["a", "b"]);
  assert.equal(lines[0].id, "L1");
  assert.deepEqual(lines[1].strokeIds, ["c"]);
});

test("a tall stroke like an integral sign does not swallow the next line", () => {
  const lines = groupLines([stroke("int", 0, 0, 10, 120), stroke("x", 30, 40), stroke("next", 0, 300)]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].strokeIds.sort(), ["int", "x"]);
});

test("zooming keeps the world point under the cursor fixed", () => {
  const cam = { x: 10, y: 20, z: 1 };
  const before = screenToWorld(cam, 300, 200);
  const after = screenToWorld(zoomAt(cam, 300, 200, 2), 300, 200);
  assert.deepEqual(after.map((v) => Math.round(v * 1e6)), before.map((v) => Math.round(v * 1e6)));
});

test("a line splits into tokens at gaps, and spans cover the chosen tokens", () => {
  // "2x + 3": strokes at x=0..40 and 42..82 nearly touch (one token), then gaps.
  const [line] = groupLines([stroke("2", 0, 0), stroke("x", 42, 0), stroke("+", 140, 0), stroke("3", 240, 0)]);
  assert.deepEqual(line.tokens.map((t) => t.strokeIds), [["2", "x"], ["+"], ["3"]]);
  const span = spanBox(line, 2, 3);
  assert.equal(span.x, 140);
  assert.equal(span.w, 140);
  assert.deepEqual(spanBox(line, 9, 12), line.tokens[2].box);
});

test("the second bar of an equals sign stays on its line", () => {
  const bar = (id: string, y: number): Stroke => ({ id, color: "#000", size: 3.6, createdAt: 0, points: [[200, y, 0.5], [240, y, 0.5]] });
  const lines = groupLines([stroke("y", 120, 113, 30, 100), bar("eq1", 140), bar("eq2", 158), stroke("next", 120, 300, 30, 100)]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].strokeIds.sort(), ["eq1", "eq2", "y"]);
  assert.deepEqual(lines[0].tokens.map((t) => t.strokeIds.sort()), [["y"], ["eq1", "eq2"]]);
});

test("a lasso keeps the strokes it mostly encloses", () => {
  const loop: [number, number][] = [
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ];
  const picked = strokesInLasso([stroke("in", 20, 20), stroke("edge", 180, 40, 60, 10), stroke("out", 300, 300)], loop);
  assert.deepEqual(picked.map((s) => s.id), ["in"]);
});
