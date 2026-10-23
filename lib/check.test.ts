import { test } from "node:test";
import assert from "node:assert/strict";
import { firstBreak, follows, fromLatex } from "./check.ts";

test("correct algebra steps pass", () => {
  assert.equal(firstBreak(["5x^2 + 5 = 10", "5x^2 = 5", "x^2 = 1"]), null);
  assert.deepEqual(follows("2y + 3 = 7", "2y = 4"), { ok: true });
  assert.deepEqual(follows("(x+1)^2", "x^2 + 2x + 1"), { ok: true });
  assert.deepEqual(follows("3t - 6 = 0", "t = 2"), { ok: true });
});

test("catches the slips that matter", () => {
  const sign = firstBreak(["5x^2 + 5 = 10", "5x^2 = 15"]);
  assert.equal(sign?.index, 1);
  const lost = follows("x^2 = 1", "x = 1");
  assert.ok(lost && !lost.ok && lost.detail.includes("loses the solution -1"), JSON.stringify(lost));
  const div = follows("x^2 = 3x", "x = 3");
  assert.ok(div && !div.ok && div.detail.includes("loses the solution 0"));
  const expand = follows("(x+1)^2", "x^2 + 1");
  assert.ok(expand && !expand.ok);
});

test("reads the tutor's LaTeX transcriptions", () => {
  assert.equal(fromLatex("\\frac{x+1}{2} = 3"), "((x+1)/(2)) = 3");
  assert.deepEqual(follows("\\frac{x}{2} + 1 = 4", "x = 6"), { ok: true });
  assert.deepEqual(follows("\\sqrt{x} = 3", "x = 9"), { ok: true });
});

test("stays quiet when it can't judge", () => {
  assert.equal(follows("x = ±1", "x = 1"), null);
  assert.equal(follows("x + y = 3", "y = 3 - x"), null);
  assert.equal(follows("d/dx sin(x)", "cos(x)"), null);
  assert.equal(firstBreak(["The answer is", "x = 2"]), null);
});
