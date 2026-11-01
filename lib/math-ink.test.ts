import { test } from "node:test";
import assert from "node:assert/strict";
import { chemistry, equalsAt, isMath, layoutMath } from "./math-ink.ts";
import { measureText, Pen, seeded, textExtent, write } from "./handwriting.ts";

const m = (s: string, size: number) => ({ w: s.length * size * 0.6, asc: size, desc: size * 0.25 });
const texts = (src: string) => layoutMath(src, 30, m).items.flatMap((i) => (i.t === "text" ? [i.s] : []));

test("TeX, powers and $...$ count as math; plain words don't", () => {
  for (const s of ["\\frac{1}{2}", "x^2 + 1", "a_n", "Try: $x+1=2$", "\\sqrt{2}"]) assert.ok(isMath(s), s);
  for (const s of ["x² + 1", "chain rule", "f(x) = 3x", "fill in ___", "https://a.b/c_d"]) assert.ok(!isMath(s), s);
});

test("a fraction stacks over a bar, centred on the axis", () => {
  const b = layoutMath("\\frac{a+b}{2}", 30, m);
  const t = b.items.filter((i) => i.t === "text");
  const bar = b.items.find((i) => i.t === "path")!;
  assert.equal(t.length, 4); // a, +, b, 2
  const barY = bar.t === "path" ? bar.pts[0][1] : 0;
  assert.ok(t.slice(0, 3).every((i) => i.t === "text" && i.y < barY), "numerator above the bar");
  assert.ok(t[3].t === "text" && t[3].y > barY, "denominator below");
  assert.ok(b.asc > 30 && b.desc > 10);
});

test("powers go up and get smaller; limits go under", () => {
  const sq = layoutMath("x^{2}", 30, m).items;
  assert.ok(sq[1].t === "text" && sq[1].size < 30 && sq[1].y < 0);
  const lim = layoutMath("\\lim_{x \\to 0}", 30, m).items;
  const under = lim.filter((i) => i.t === "text" && i.y > 0);
  assert.deepEqual(under.map((i) => (i.t === "text" ? i.s : "")), ["x", "→", "0"]);
});

test("commands become symbols, and chemistry gets subscripts and arrows", () => {
  assert.deepEqual(texts("\\alpha \\le \\pi"), ["α", "≤", "π"]);
  assert.deepEqual(texts("x \\in \\mathbb{R}"), ["x", "∈", "ℝ"]);
  assert.equal(chemistry("2H2 + O2 -> 2H2O"), "2H_{2} + O_{2}  \\rightarrow  2H_{2}O");
  const water = layoutMath("\\ce{H2O}", 30, m).items;
  assert.ok(water[1].t === "text" && water[1].s === "2" && water[1].y > 0);
});

test("matrices lay cells out in rows and columns inside tall brackets", () => {
  const b = layoutMath("\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}", 30, m);
  const cells = b.items.filter((i) => i.t === "text") as { s: string; x: number; y: number }[];
  assert.deepEqual(cells.map((c) => c.s), ["1", "2", "3", "4"]);
  assert.ok(cells[0].y === cells[1].y && cells[2].y > cells[0].y && cells[1].x > cells[0].x);
  assert.equal(b.items.filter((i) => i.t === "path").length, 2);
});

test("steps line up on the top-level equals sign only", () => {
  assert.equal(equalsAt("\\sum_{n=1}^{3} n = 6"), "\\sum_{n=1}^{3} n ".length);
  assert.equal(equalsAt("x + 1"), -1);
});

test("the hand writes math with the pen, and measures it the same way", () => {
  const pen = new Pen(1);
  write(pen, "\\frac{dy}{dx} = \\sqrt{x}", 0, 100, 30, seeded(1));
  assert.ok(pen.strokes.length > 8);
  const w = measureText("\\frac{dy}{dx} = \\sqrt{x}", 30);
  assert.ok(pen.box!.w > w * 0.85 && pen.box!.w < w * 1.15);
  const e = textExtent("\\frac{1}{2}", 30);
  assert.ok(e.asc > 30 && e.desc > 10);
  // symbols the traced hand never had are built from its strokes
  for (const ch of ["∅", "⇌", "ℝ", "⊆", "∴", "Π", "∮"]) {
    const p = new Pen(1);
    write(p, ch, 0, 50, 30, seeded(2));
    assert.ok(p.strokes.length > 0, ch);
  }
});
