import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "./expr.ts";

const at = (src: string, x: number) => compile(src)(x);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("reads formulas the way people write them", () => {
  near(at("x^2 - 2", 3), 7);
  near(at("y = 2x + 1", 2), 5);
  near(at("f(x) = -x^2", 3), -9);
  near(at("2sin(x)", Math.PI / 2), 2);
  near(at("sin x", Math.PI / 2), 1);
  near(at("sin^2(x) + cos^2(x)", 0.7), 1);
  near(at("e^(-x/2)", 2), Math.exp(-1));
  near(at("(x+1)(x-1)", 3), 8);
  near(at("x²", 4), 16);
  near(at("√(x)", 9), 3);
  near(at("1/x", 4), 0.25);
  near(at("2^-x", 1), 0.5);
  near(at("3πx", 1), 3 * Math.PI);
  near(at("ln(e)", 0), 1);
  near(at("5x^2 + 5", 1), 10);
});

test("refuses anything that isn't arithmetic", () => {
  assert.throws(() => compile("alert(1)"));
  assert.throws(() => compile("x +"));
  assert.throws(() => compile("constructor"));
  assert.throws(() => compile("x; y"));
});
