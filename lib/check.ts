// A numeric math checker: does each line of working follow from the one
// before? It reads one-variable equations and expressions and compares their
// solutions (or values) numerically. It can't prove things, but it reliably
// catches a dropped root, a sign slip or a wrong simplification, which is
// what small models and students most often get wrong.

import { compile, variableOf } from "./expr.ts";

type Parsed =
  | { kind: "equation"; g: (x: number) => number; text: string }
  | { kind: "expression"; f: (x: number) => number; text: string };

// The tutor's transcriptions come as LaTeX; turn the common parts into plain math.
export function fromLatex(src: string): string {
  let s = src.replace(/\\left|\\right|\\displaystyle|\\,|\\;|\\!|\\quad|\$/g, "");
  const braced = (from: number): [string, number] | null => {
    if (s[from] !== "{") return null;
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) return [s.slice(from + 1, i), i + 1];
    }
    return null;
  };
  for (let guard = 0; guard < 50; guard++) {
    const i = s.search(/\\[dt]?frac\{/);
    if (i < 0) break;
    const open = s.indexOf("{", i);
    const a = braced(open);
    const b = a && braced(a[1]);
    if (!a || !b) break;
    s = `${s.slice(0, i)}((${a[0]})/(${b[0]}))${s.slice(b[1])}`;
  }
  for (let guard = 0; guard < 50; guard++) {
    const i = s.indexOf("\\sqrt{");
    if (i < 0) break;
    const a = braced(i + 5);
    if (!a) break;
    s = `${s.slice(0, i)}sqrt(${a[0]})${s.slice(a[1])}`;
  }
  return s
    .replace(/\\(cdot|times)/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi/g, "pi")
    .replace(/\\(sin|cos|tan|ln|log|exp)/g, "$1")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .trim();
}

export function parseLine(src: string): Parsed | null {
  const text = src.trim();
  if (!text || /[<>≤≥±∓≈,;]|\\(le|ge|pm|neq|approx|int|sum|lim)/.test(text)) return null;
  const plain = text.includes("\\") ? fromLatex(text) : text;
  const sides = plain.split("=");
  if (sides.length > 2) return null;
  try {
    const v = variableOf(plain) ?? "x";
    if (sides.length === 2) {
      if (!sides[0].trim() || !sides[1].trim()) return null;
      const L = compile(sides[0], v), R = compile(sides[1], v);
      return { kind: "equation", g: (x) => L(x) - R(x), text };
    }
    return { kind: "expression", f: compile(plain, v), text };
  } catch {
    return null;
  }
}

const SPAN = 20;
const N = 4000;

// Solutions of g(x) = 0 on [-20, 20], or "all" for an identity.
function roots(g: (x: number) => number): number[] | "all" {
  const out: number[] = [];
  let zeroish = 0, finite = 0;
  let px = -SPAN, pv = g(px);
  const add = (r: number) => {
    if (!out.some((o) => Math.abs(o - r) < 1e-4)) out.push(r);
  };
  for (let i = 1; i <= N; i++) {
    const x = -SPAN + (2 * SPAN * i) / N;
    const v = g(x);
    if (Number.isFinite(v)) {
      finite++;
      if (Math.abs(v) < 1e-9) {
        zeroish++;
        add(x);
      } else if (Number.isFinite(pv) && pv * v < 0) {
        // bisect, then make sure it's a real crossing and not an asymptote
        let a = px, b = x, fa = pv;
        for (let k = 0; k < 60; k++) {
          const m = (a + b) / 2, fm = g(m);
          if (!Number.isFinite(fm)) break;
          if (fa * fm <= 0) b = m;
          else {
            a = m;
            fa = fm;
          }
        }
        const r = (a + b) / 2;
        if (Math.abs(g(r)) < 1e-6 * (1 + Math.abs(pv) + Math.abs(v))) add(Math.round(r * 1e6) / 1e6);
      }
    }
    px = x;
    pv = v;
  }
  if (finite > 0 && zeroish > finite * 0.9) return "all";
  return out.sort((a, b) => a - b);
}

const fmt = (r: number) => String(Math.round(r * 1000) / 1000);

export type StepCheck = { ok: true } | { ok: false; detail: string };

// Does `next` follow from `prev`? Unknown when either can't be read.
export function follows(prev: string, next: string): StepCheck | null {
  const a = parseLine(prev), b = parseLine(next);
  if (!a || !b || a.kind !== b.kind) return null;
  if (a.kind === "expression" && b.kind === "expression") {
    for (const x of [-2.7, -1.3, -0.4, 0.6, 1.9, 3.1, 4.4]) {
      const u = a.f(x), v = b.f(x);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (Math.abs(u - v) > 1e-6 * (1 + Math.abs(u))) return { ok: false, detail: `"${next}" is not equal to "${prev}" (they differ at x = ${x})` };
    }
    return { ok: true };
  }
  if (a.kind !== "equation" || b.kind !== "equation") return null;
  const ra = roots(a.g), rb = roots(b.g);
  if (ra === "all" || rb === "all") return ra === rb ? { ok: true } : { ok: false, detail: `"${prev}" and "${next}" don't have the same solutions` };
  const lost = ra.filter((r) => !rb.some((s) => Math.abs(r - s) < 1e-3));
  const gained = rb.filter((r) => !ra.some((s) => Math.abs(r - s) < 1e-3));
  if (!lost.length && !gained.length) return { ok: true };
  const parts = [lost.length ? `loses the solution ${lost.map(fmt).join(", ")}` : "", gained.length ? `adds the solution ${gained.map(fmt).join(", ")}` : ""];
  return { ok: false, detail: `going from "${prev}" to "${next}" ${parts.filter(Boolean).join(" and ")}` };
}

// The first line that doesn't follow from the readable line before it.
export function firstBreak(lines: string[]): { index: number; detail: string } | null {
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!parseLine(lines[i])) continue;
    if (prev != null) {
      const c = follows(prev, lines[i]);
      if (c && !c.ok) return { index: i, detail: c.detail };
    }
    prev = lines[i];
  }
  return null;
}
