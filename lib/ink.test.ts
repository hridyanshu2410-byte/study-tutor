import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLines, zoomAt, screenToWorld, type Stroke } from "./ink.ts";

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
