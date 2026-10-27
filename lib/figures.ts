// Draws the tutor's figures (graphs, number lines, shapes, flow diagrams,
// tables, force diagrams, equation steps) with the same hand-drawn pen as its
// writing: stroke by stroke, a little uneven, at hand speed.

import type { Box } from "./ink.ts";
import { arrow, jitter, measureText, write, type Pen, type Rng } from "./handwriting.ts";
import { compile } from "./expr.ts";
import type { Figure } from "./figure-schema.ts";

type Pt = [number, number];

// A ruler-free straight line: a slight bow and wobble, like a confident hand.
function line(pen: Pen, a: Pt, b: Pt, rng: Rng, speed = 1.6) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d < 1) return;
  const bow = jitter(rng, Math.min(4, d * 0.012));
  const nx = -(b[1] - a[1]) / d;
  const ny = (b[0] - a[0]) / d;
  const pts: Pt[] = [];
  const n = Math.max(2, Math.ceil(d / 24));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const s = Math.sin(f * Math.PI) * bow;
    pts.push([a[0] + (b[0] - a[0]) * f + nx * s + jitter(rng, 0.4), a[1] + (b[1] - a[1]) * f + ny * s + jitter(rng, 0.4)]);
  }
  pen.draw(pts, speed);
}

function head(pen: Pen, tip: Pt, ang: number, wing: number, rng: Rng) {
  const spread = 0.5 + jitter(rng, 0.05);
  pen.lift(60);
  pen.draw(
    [
      [tip[0] - wing * Math.cos(ang - spread), tip[1] - wing * Math.sin(ang - spread)],
      tip,
      [tip[0] - wing * Math.cos(ang + spread), tip[1] - wing * Math.sin(ang + spread)],
    ],
    1.4,
  );
}

function ring(pen: Pen, c: Pt, r: number, rng: Rng) {
  const pts: Pt[] = [];
  const start = rng() * Math.PI * 2;
  for (let i = 0; i <= 18; i++) {
    const a = start + (i / 18) * Math.PI * 2.1;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  pen.draw(pts, 1.2);
}

// A filled dot: a tight spiral, the way a pen fills one in.
function dot(pen: Pen, c: Pt, r: number) {
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 4;
    const rr = r * (1 - i / 30);
    pts.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
  }
  pen.draw(pts, 1.2);
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return String(r).replace("-", "−");
};

function graph(pen: Pen, fig: Extract<Figure, { kind: "graph" }>, x: number, y: number, size: number, rng: Rng) {
  let { x_min: x0, x_max: x1, y_min: y0, y_max: y1 } = fig;
  if (!(x1 > x0)) [x0, x1] = [-5, 5];
  if (!(y1 > y0)) [y0, y1] = [-5, 5];
  const L = x + size * 1.4, R = L + size * 11, T = y + size * 0.6, B = T + size * 7.5;
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (R - L);
  const sy = (v: number) => B - ((v - y0) / (y1 - y0)) * (B - T);
  const ax = x0 <= 0 && x1 >= 0 ? sx(0) : L;
  const ay = y0 <= 0 && y1 >= 0 ? sy(0) : B;
  const small = Math.max(13, size * 0.5);

  line(pen, [L - 8, ay], [R + 14, ay], rng, 2.2);
  head(pen, [R + 14, ay], 0, 10, rng);
  pen.lift(120);
  line(pen, [ax, B + 8], [ax, T - 14], rng, 2.2);
  head(pen, [ax, T - 14], -Math.PI / 2, 10, rng);

  const xs = niceStep(x1 - x0, 6);
  for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-9; v += xs) {
    if (Math.abs(v) < 1e-9) continue;
    pen.lift(40);
    line(pen, [sx(v), ay - 4], [sx(v), ay + 4], rng, 2);
    write(pen, num(v), sx(v) - measureText(num(v), small) / 2, ay + small * 1.7, small, rng);
  }
  const ys = niceStep(y1 - y0, 5);
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
    if (Math.abs(v) < 1e-9) continue;
    pen.lift(40);
    line(pen, [ax - 4, sy(v)], [ax + 4, sy(v)], rng, 2);
    write(pen, num(v), ax - 8 - measureText(num(v), small), sy(v) + small * 0.5, small, rng);
  }
  if (fig.x_label) write(pen, fig.x_label, R + 20, ay + small * 0.5, size * 0.7, rng);
  if (fig.y_label) write(pen, fig.y_label, ax + 10, T - 10, size * 0.7, rng);

  for (const c of fig.curves.slice(0, 3)) {
    let f: (v: number) => number;
    try {
      f = compile(c.formula);
    } catch {
      continue;
    }
    pen.lift(250);
    const pad = (y1 - y0) * 0.04;
    const segs: Pt[][] = [];
    let seg: Pt[] = [];
    const n = 180;
    for (let i = 0; i <= n; i++) {
      const v = x0 + ((x1 - x0) * i) / n;
      const w = f(v);
      if (Number.isFinite(w) && w >= y0 - pad && w <= y1 + pad) seg.push([sx(v), sy(w)]);
      else if (seg.length) {
        segs.push(seg);
        seg = [];
      }
    }
    if (seg.length) segs.push(seg);
    let end: Pt | null = null;
    for (const s of segs) {
      if (s.length < 2) continue;
      pen.draw(s, 1.1);
      pen.lift(80);
      end = s.at(-1)!;
    }
    if (c.label && end) write(pen, c.label, Math.min(end[0] + 8, R + 10), Math.max(end[1] - 8, T + size * 0.6), size * 0.65, rng);
  }

  for (const pt of fig.points.slice(0, 6)) {
    if (pt.x < x0 || pt.x > x1 || pt.y < y0 || pt.y > y1) continue;
    pen.lift(150);
    dot(pen, [sx(pt.x), sy(pt.y)], 3.5);
    if (pt.label) write(pen, pt.label, sx(pt.x) + 9, sy(pt.y) - 9, size * 0.6, rng);
  }
}

function numberLine(pen: Pen, fig: Extract<Figure, { kind: "number_line" }>, x: number, y: number, size: number, rng: Rng) {
  let { from, to } = fig;
  if (!(to > from)) [from, to] = [-5, 5];
  const small = Math.max(13, size * 0.55);
  const step = niceStep(to - from, 10);
  // Wide enough that the numbers under the ticks never touch.
  const W = Math.max(size * 13, ((to - from) / step) * small * 2.8);
  const ly = y + size * 2.4;
  const s = (v: number) => x + size * 0.8 + ((v - from) / (to - from)) * (W - size * 1.6);
  line(pen, [x, ly], [x + W, ly], rng, 2.2);
  head(pen, [x + W, ly], 0, 10, rng);
  head(pen, [x, ly], Math.PI, 10, rng);
  for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) {
    pen.lift(30);
    line(pen, [s(v), ly - 6], [s(v), ly + 6], rng, 2);
    write(pen, num(v), s(v) - measureText(num(v), small) / 2, ly + small * 2.2, small, rng);
  }
  if (fig.shade_from != null && fig.shade_to != null) {
    const a = s(Math.max(from, Math.min(fig.shade_from, fig.shade_to)));
    const b = s(Math.min(to, Math.max(fig.shade_from, fig.shade_to)));
    pen.lift(150);
    line(pen, [a, ly - 3], [b, ly - 3], rng, 1.6);
    line(pen, [b, ly - 6], [a, ly - 6], rng, 1.6);
  }
  for (const m of fig.marks.slice(0, 6)) {
    pen.lift(120);
    if (m.open) ring(pen, [s(m.at), ly], 5, rng);
    else dot(pen, [s(m.at), ly], 5);
    if (m.label) write(pen, m.label, s(m.at) - measureText(m.label, small) / 2, ly - 14, small, rng);
  }
  for (const j of fig.jumps.slice(0, 5)) {
    const a = s(j.from), b = s(j.to);
    const h = size * 0.9 + Math.abs(b - a) * 0.12;
    const pts: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const f = i / 20;
      pts.push([a + (b - a) * f, ly - 10 - Math.sin(f * Math.PI) * h]);
    }
    pen.lift(150);
    pen.draw(pts, 1.6);
    head(pen, pts.at(-1)!, Math.atan2(pts.at(-1)![1] - pts.at(-3)![1], pts.at(-1)![0] - pts.at(-3)![0]), 9, rng);
    if (j.label) write(pen, j.label, (a + b) / 2 - measureText(j.label, small) / 2, ly - 18 - h, small, rng);
  }
}

function shape(pen: Pen, fig: Extract<Figure, { kind: "shape" }>, x: number, y: number, size: number, rng: Rng) {
  const vs = fig.vertices.slice(0, 8);
  if (vs.length < 2) return;
  const minX = Math.min(...vs.map((v) => v.x)), maxX = Math.max(...vs.map((v) => v.x));
  const minY = Math.min(...vs.map((v) => v.y)), maxY = Math.max(...vs.map((v) => v.y));
  const k = Math.min((size * 9) / (maxX - minX || 1), (size * 6) / (maxY - minY || 1));
  const P = vs.map((v) => [x + size * 1.2 + (v.x - minX) * k, y + size * 1.2 + (maxY - v.y) * k] as Pt);
  const cx = P.reduce((a, p) => a + p[0], 0) / P.length;
  const cy = P.reduce((a, p) => a + p[1], 0) / P.length;
  const sides = fig.closed && P.length > 2 ? P.length : P.length - 1;
  for (let i = 0; i < sides; i++) {
    line(pen, P[i], P[(i + 1) % P.length], rng, 1.8);
    pen.lift(50);
  }
  const out = (p: Pt, dist: number): Pt => {
    const dx = p[0] - cx, dy = p[1] - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / d) * dist, p[1] + (dy / d) * dist];
  };
  const lsize = size * 0.65;
  vs.forEach((v, i) => {
    if (!v.label) return;
    const [lx, ly] = out(P[i], size * 0.7);
    write(pen, v.label, lx - measureText(v.label, lsize) / 2, ly + lsize * 0.4, lsize, rng);
  });
  for (let i = 0; i < sides; i++) {
    const t = fig.side_labels[i];
    if (!t) continue;
    const a = P[i], b = P[(i + 1) % P.length];
    const [lx, ly] = out([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], size * 0.6);
    write(pen, t, lx - measureText(t, lsize) / 2, ly + lsize * 0.4, lsize, rng);
  }
  vs.forEach((_, i) => {
    const t = fig.angle_labels[i];
    if (!t) return;
    const [lx, ly] = out(P[i], -size * 1.1);
    write(pen, t, lx - measureText(t, lsize * 0.85) / 2, ly + lsize * 0.35, lsize * 0.85, rng);
  });
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function flow(pen: Pen, fig: Extract<Figure, { kind: "flow" }>, x: number, y: number, size: number, rng: Rng) {
  const ts = Math.max(14, size * 0.55);
  const nodes = fig.nodes.slice(0, 7).map((n) => {
    const lines = wrap(n.text, 16);
    const w = Math.max(...lines.map((l) => measureText(l, ts))) * 1.08 + ts * 2;
    const h = lines.length * ts * 1.55 + ts * 1.3;
    return { lines, w, h, box: { x: 0, y: 0, w, h } as Box };
  });
  const ls = Math.max(12, size * 0.48);
  const longest = Math.max(0, ...fig.arrows.map((a) => (a.label ? measureText(a.label, ls) : 0)));
  const gap = fig.direction === "right" ? Math.max(size * 2.2, longest + size) : size * 1.6;
  let cx = x, cy = y;
  const rowH = Math.max(...nodes.map((n) => n.h));
  for (const n of nodes) {
    n.box = fig.direction === "right" ? { x: cx, y: y + (rowH - n.h) / 2, w: n.w, h: n.h } : { x, y: cy, w: n.w, h: n.h };
    cx += n.w + gap;
    cy += n.h + gap;
  }
  for (const n of nodes) {
    const b = n.box;
    const r = 6;
    pen.lift(120);
    pen.draw(
      [
        [b.x + r, b.y + jitter(rng, 1)],
        [b.x + b.w - r, b.y + jitter(rng, 1)],
        [b.x + b.w, b.y + r],
        [b.x + b.w + jitter(rng, 1), b.y + b.h - r],
        [b.x + b.w - r, b.y + b.h],
        [b.x + r, b.y + b.h + jitter(rng, 1)],
        [b.x, b.y + b.h - r],
        [b.x + jitter(rng, 1), b.y + r],
        [b.x + r + 4, b.y - 1],
      ],
      1.8,
    );
    n.lines.forEach((l, i) => write(pen, l, b.x + ts, b.y + ts * 1.7 + i * ts * 1.55, ts, rng));
  }
  const edge = (b: Box, toward: Pt): Pt => {
    const ccx = b.x + b.w / 2, ccy = b.y + b.h / 2;
    const dx = toward[0] - ccx, dy = toward[1] - ccy;
    const k = Math.min(Math.abs((b.w / 2 + 6) / (dx || 1e-6)), Math.abs((b.h / 2 + 6) / (dy || 1e-6)));
    return [ccx + dx * k, ccy + dy * k];
  };
  const arrows = fig.arrows.length ? fig.arrows : nodes.slice(1).map((_, i) => ({ from: i, to: i + 1, label: null }));
  for (const a of arrows.slice(0, 10)) {
    const A = nodes[a.from]?.box, Bx = nodes[a.to]?.box;
    if (!A || !Bx || A === Bx) continue;
    const ca: Pt = [A.x + A.w / 2, A.y + A.h / 2], cb: Pt = [Bx.x + Bx.w / 2, Bx.y + Bx.h / 2];
    const p0 = edge(A, cb), p1 = edge(Bx, ca);
    pen.lift(120);
    arrow(pen, p0, p1, rng);
    if (a.label) {
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      write(pen, a.label, fig.direction === "right" ? mx - measureText(a.label, ls) / 2 : mx + 10, fig.direction === "right" ? my - 16 : my + ls * 0.4, ls, rng);
    }
  }
}

function table(pen: Pen, fig: Extract<Figure, { kind: "table" }>, x: number, y: number, size: number, rng: Rng) {
  const rows = fig.rows.slice(0, 8).map((r) => r.slice(0, 6).map((c) => c.slice(0, 16)));
  if (!rows.length) return;
  const ts = Math.max(15, size * 0.62);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(ts * 2, ...rows.map((r) => measureText(r[c] ?? "", ts))) + ts * 1.4);
  const rh = ts * 2;
  const W = widths.reduce((a, b) => a + b, 0), H = rh * rows.length;
  line(pen, [x, y], [x + W, y], rng, 2.2);
  line(pen, [x + W, y], [x + W, y + H], rng, 2.2);
  line(pen, [x + W, y + H], [x, y + H], rng, 2.2);
  line(pen, [x, y + H], [x, y], rng, 2.2);
  for (let r = 1; r < rows.length; r++) {
    pen.lift(40);
    line(pen, [x, y + r * rh], [x + W, y + r * rh], rng, 2.2);
    if (r === 1 && fig.header) line(pen, [x + W, y + r * rh + 3], [x, y + r * rh + 3], rng, 2.2);
  }
  let cx = x;
  for (let c = 0; c < cols - 1; c++) {
    cx += widths[c];
    pen.lift(40);
    line(pen, [cx, y], [cx, y + H], rng, 2.2);
  }
  rows.forEach((r, ri) => {
    let left = x;
    r.forEach((cell, ci) => {
      if (cell) write(pen, cell, left + (widths[ci] - measureText(cell, ts)) / 2, y + ri * rh + rh * 0.68, ts, rng);
      left += widths[ci];
    });
  });
}

function forces(pen: Pen, fig: Extract<Figure, { kind: "forces" }>, x: number, y: number, size: number, rng: Rng) {
  const c: Pt = [x + size * 6, y + size * 4.5];
  const side = size * 2;
  const tilt = ((fig.incline_deg ?? 0) * Math.PI) / 180;
  if (fig.body === "block") {
    // The block sits on its surface; on a ramp, block and ramp share the slope.
    const ux: Pt = [Math.cos(tilt), -Math.sin(tilt)], uy: Pt = [Math.sin(tilt), Math.cos(tilt)];
    const at = (u: number, v: number): Pt => [c[0] + ux[0] * u + uy[0] * v, c[1] + ux[1] * u + uy[1] * v];
    const h = side / 2;
    line(pen, at(-size * 4.5, h), at(size * 4.5, h), rng, 2.2);
    pen.lift(80);
    pen.draw([at(-h, -h), at(h, -h), at(h, h), at(-h, h), at(-h, -h + 2)], 1.8);
  } else {
    dot(pen, c, 4);
  }
  for (const f of fig.forces.slice(0, 5)) {
    const a = (f.angle_deg * Math.PI) / 180;
    const len = size * 3.6 * Math.max(0.3, Math.min(1, f.size || 0.6));
    const start: Pt = [c[0] + Math.cos(a) * 4, c[1] - Math.sin(a) * 4];
    const tip: Pt = [c[0] + Math.cos(a) * len, c[1] - Math.sin(a) * len];
    pen.lift(150);
    line(pen, start, tip, rng, 1.8);
    head(pen, tip, Math.atan2(tip[1] - c[1], tip[0] - c[0]), 11, rng);
    const ls = size * 0.62;
    const lx = tip[0] + Math.cos(a) * 12 - (Math.cos(a) < -0.3 ? measureText(f.label, ls) : Math.cos(a) < 0.3 ? measureText(f.label, ls) / 2 : 0);
    const ly = tip[1] - Math.sin(a) * 14 + ls * 0.4;
    write(pen, f.label, lx, ly, ls, rng);
  }
}

// Equation lines under one another, lined up on the equals sign, with what
// was done written to the right, the way it's done on a board.
function steps(pen: Pen, fig: Extract<Figure, { kind: "steps" }>, x: number, y: number, size: number, rng: Rng) {
  const lines = fig.lines.slice(0, 6);
  const parts = lines.map((l) => {
    const i = l.math.indexOf("=");
    return i < 0 ? { pre: "", rest: l.math, note: l.note } : { pre: l.math.slice(0, i).trimEnd() + " ", rest: l.math.slice(i), note: l.note };
  });
  const preW = Math.max(...parts.map((p) => measureText(p.pre, size)));
  const restW = Math.max(...parts.map((p) => measureText(p.rest, size)));
  const eqX = x + preW;
  parts.forEach((p, i) => {
    const base = y + size * 1.4 + i * size * 2.3;
    write(pen, p.pre + p.rest, eqX - measureText(p.pre, size), base, size, rng);
    if (p.note) {
      const nx = eqX + restW + size * 1.2;
      line(pen, [nx, base - size * 0.95], [nx, base + size * 0.15], rng, 2);
      write(pen, p.note, nx + size * 0.4, base, size * 0.7, rng);
    }
  });
}

function roundBox(pen: Pen, b: Box, rng: Rng, speed = 1.8) {
  const r = 6;
  pen.draw(
    [
      [b.x + r, b.y + jitter(rng, 1)],
      [b.x + b.w - r, b.y + jitter(rng, 1)],
      [b.x + b.w, b.y + r],
      [b.x + b.w + jitter(rng, 1), b.y + b.h - r],
      [b.x + b.w - r, b.y + b.h],
      [b.x + r, b.y + b.h + jitter(rng, 1)],
      [b.x, b.y + b.h - r],
      [b.x + jitter(rng, 1), b.y + r],
      [b.x + r + 4, b.y - 1],
    ],
    speed,
  );
}

// Where a line from a box's centre toward a point leaves the box.
function boxExit(b: Box, toward: Pt): Pt {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = toward[0] - cx, dy = toward[1] - cy;
  const k = Math.min(Math.abs((b.w / 2 + 6) / (dx || 1e-6)), Math.abs((b.h / 2 + 6) / (dy || 1e-6)));
  return [cx + dx * k, cy + dy * k];
}

// Columns (or rows) by how far each node is from a starting node, so a
// method's pipeline reads left to right. Back edges don't move a node.
export function layers(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  const index = new Map(ids.map((id, i) => [id, i]));
  const forward = edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);
  // Edges that point back to an earlier-listed node can be cycles; keep only those that
  // aren't on a path back to themselves.
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    from === to || (!seen.has(from) && (seen.add(from), forward.some((e) => e.from === from && reaches(e.to, to, seen))));
  const dag = forward.filter((e) => !(index.get(e.to)! < index.get(e.from)! && reaches(e.to, e.from)));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of dag) {
      const next = out.get(e.from)! + 1;
      if (next > out.get(e.to)!) {
        out.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function diagram(pen: Pen, fig: Extract<Figure, { kind: "diagram" }>, x: number, y: number, size: number, rng: Rng) {
  const ts = Math.max(14, size * 0.55);
  const nodes = fig.nodes.slice(0, 12).map((n) => {
    const lines = wrap(n.text, 16);
    const w = Math.max(...lines.map((l) => measureText(l, ts))) * 1.08 + ts * 2;
    const h = lines.length * ts * 1.55 + ts * 1.3;
    return { ...n, lines, w, h, box: { x: 0, y: 0, w, h } as Box };
  });
  if (!nodes.length) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = fig.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).slice(0, 16);
  const layer = layers(nodes.map((n) => n.id), edges);
  const count = Math.max(...layer.values()) + 1;
  const cols = Array.from({ length: count }, (_, i) => nodes.filter((n) => layer.get(n.id) === i));
  const ls = Math.max(12, size * 0.46);
  const longest = Math.max(0, ...edges.map((e) => (e.label ? measureText(e.label, ls) : 0)));
  // A long pipeline won't fit across the page; stack it downward instead.
  const across = cols.reduce((sum, c) => sum + Math.max(...c.map((n) => n.w), 0), 0) + (cols.length - 1) * Math.max(size * 2.2, longest + size);
  const right = fig.direction === "right" && across <= size * 22;
  const gapMain = right ? Math.max(size * 2.2, longest + size) : Math.max(size * 1.8, ls * 2.4);
  const gapCross = size * 1.1;
  const grouped = nodes.some((n) => n.group);
  const pad = grouped ? ts * 1.6 : 0;
  // place each column (or row), centred on the widest one
  const cross = cols.map((c) => c.reduce((s, n) => s + (right ? n.h : n.w), 0) + gapCross * Math.max(0, c.length - 1));
  const span = Math.max(...cross);
  let main = right ? x + pad : y + pad;
  cols.forEach((col, i) => {
    let at = (right ? y + pad : x + pad) + (span - cross[i]) / 2;
    const thick = Math.max(...col.map((n) => (right ? n.w : n.h)), 0);
    for (const n of col) {
      n.box = right ? { x: main + (thick - n.w) / 2, y: at, w: n.w, h: n.h } : { x: at, y: main + (thick - n.h) / 2, w: n.w, h: n.h };
      at += (right ? n.h : n.w) + gapCross;
    }
    main += thick + gapMain;
  });
  // groups first, as a light frame around their members
  const groups = [...new Set(nodes.map((n) => n.group).filter((g): g is string => !!g))].slice(0, 4);
  for (const g of groups) {
    const members = nodes.filter((n) => n.group === g).map((n) => n.box);
    const gx = Math.min(...members.map((b) => b.x)) - ts * 0.7, gy = Math.min(...members.map((b) => b.y)) - ts * 1.5;
    const gb = { x: gx, y: gy, w: Math.max(...members.map((b) => b.x + b.w)) + ts * 0.7 - gx, h: Math.max(...members.map((b) => b.y + b.h)) + ts * 0.7 - gy };
    pen.lift(120);
    roundBox(pen, gb, rng, 2.4);
    write(pen, g, gb.x + ts * 0.5, gb.y + ts * 1.05, ls, rng);
  }
  for (const n of nodes) {
    pen.lift(120);
    roundBox(pen, n.box, rng);
    n.lines.forEach((l, i) => write(pen, l, n.box.x + ts, n.box.y + ts * 1.7 + i * ts * 1.55, ts, rng));
  }
  for (const e of edges) {
    const A = byId.get(e.from)!.box, B = byId.get(e.to)!.box;
    if (A === B) continue;
    const ca: Pt = [A.x + A.w / 2, A.y + A.h / 2], cb: Pt = [B.x + B.w / 2, B.y + B.h / 2];
    const p0 = boxExit(A, cb), p1 = boxExit(B, ca);
    pen.lift(120);
    arrow(pen, p0, p1, rng);
    if (e.label) {
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      write(pen, e.label, right ? mx - measureText(e.label, ls) / 2 : mx + 10, right ? my - 14 : my + ls * 0.4, ls, rng);
    }
  }
}

function bars(pen: Pen, fig: Extract<Figure, { kind: "bars" }>, x: number, y: number, size: number, rng: Rng) {
  const items = fig.bars.slice(0, 8).filter((b) => Number.isFinite(b.value));
  if (!items.length) return;
  const ts = Math.max(14, size * 0.55);
  let top = y;
  if (fig.title) {
    write(pen, fig.title, x, top + ts, ts * 1.05, rng);
    top += ts * 2;
  }
  const labelW = Math.max(...items.map((b) => measureText(b.label, ts))) + ts;
  const full = size * 9;
  const lo = Math.min(0, ...items.map((b) => b.value)), hi = Math.max(...items.map((b) => b.value), 1e-9);
  const scale = full / (hi - lo || 1);
  const zero = x + labelW + -lo * scale;
  const rowH = ts * 1.9;
  items.forEach((b, i) => {
    const cy = top + i * rowH + rowH / 2;
    pen.lift(100);
    write(pen, b.label, x, cy + ts * 0.35, ts, rng);
    const end = zero + b.value * scale;
    const h = rowH * 0.55;
    const x0 = Math.min(zero, end), x1 = Math.max(zero, end);
    pen.draw(
      [
        [x0, cy - h / 2],
        [x1 + jitter(rng, 1), cy - h / 2],
        [x1, cy + h / 2],
        [x0, cy + h / 2 + jitter(rng, 1)],
        [x0, cy - h / 2],
      ],
      2,
    );
    if (b.highlight) {
      // quick hatching, the way you'd shade a bar by hand
      const pts: Pt[] = [];
      for (let hx = x0 + 6; hx < x1; hx += 9) pts.push([hx, cy + h / 2 - 2], [Math.min(x1, hx + 6), cy - h / 2 + 2]);
      if (pts.length > 1) pen.draw(pts, 3);
    }
    write(pen, num(Math.round(b.value * 100) / 100), x1 + ts * 0.5, cy + ts * 0.35, ts * 0.9, rng);
  });
  // the zero line
  pen.lift(100);
  line(pen, [zero, top + 2], [zero, top + items.length * rowH - 2], rng);
  if (fig.unit) write(pen, fig.unit, zero, top + items.length * rowH + ts * 1.2, ts * 0.85, rng);
}

function sketch(pen: Pen, fig: Extract<Figure, { kind: "sketch" }>, x: number, y: number, size: number, rng: Rng) {
  const ts = Math.max(14, size * 0.52);
  let top = y;
  if (fig.title) {
    write(pen, fig.title, x, top + ts, ts * 1.05, rng);
    top += ts * 1.8;
  }
  const k = (size * 11) / 100;
  const clamp = (v: number | undefined) => Math.min(100, Math.max(0, Number.isFinite(v) ? (v as number) : 0));
  const at = (p: number[] | null | undefined): Pt => [x + clamp(p?.[0]) * k, top + clamp(p?.[1]) * k];
  const wobble = (pts: Pt[]) => pts.map(([px, py]) => [px + jitter(rng, 0.6), py + jitter(rng, 0.6)] as Pt);
  for (const path of fig.paths.slice(0, 20)) {
    let pts = path.points.slice(0, 60).filter((p) => p.length >= 2 && p.every(Number.isFinite)).map(at);
    if (pts.length < 2) continue;
    if (path.closed) pts.push(pts[0]);
    if (path.smooth && pts.length > 2) pts = curveThrough(pts, path.closed);
    pen.lift(110);
    pen.draw(wobble(pts), 1.6);
  }
  for (const c of (fig.circles ?? []).slice(0, 30)) {
    const centre = at([c.cx, c.cy]);
    const r = Math.max(1.5, Math.min(50, Number.isFinite(c.r) ? c.r : 3) * k);
    pen.lift(90);
    if (c.filled && r < 10) dot(pen, centre, r);
    else ring(pen, centre, r, rng);
  }
  for (const a of (fig.arrows ?? []).slice(0, 8)) {
    pen.lift(110);
    arrow(pen, at(a.from), at(a.to), rng);
  }
  for (const l of fig.labels.slice(0, 12)) {
    const [lx, ly] = at([l.x, l.y]);
    const text = l.text.slice(0, 24);
    pen.lift(100);
    write(pen, text, lx, ly, ts, rng);
    if (l.point_to) {
      // a leader line from the nearer end of the label to the part it names
      const [tx, ty] = at(l.point_to);
      const w = measureText(text, ts);
      const sx = Math.abs(tx - lx) < Math.abs(tx - (lx + w)) ? lx - 4 : lx + w + 4;
      pen.lift(80);
      line(pen, [sx, ly - ts * 0.35], [tx, ty], rng);
    }
  }
}

// A smooth curve through the points (Catmull-Rom), the way a hand rounds an outline.
function curveThrough(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  const get = (i: number) => (closed ? pts[(i + n - 1) % (n - 1)] : pts[Math.max(0, Math.min(n - 1, i))]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = pts[i], p2 = pts[i + 1], p3 = get(i + 2);
    for (let s = 0; s < 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

export function drawFigure(pen: Pen, fig: Figure, x: number, y: number, size: number, rng: Rng) {
  if (fig.kind === "graph") graph(pen, fig, x, y, size, rng);
  else if (fig.kind === "number_line") numberLine(pen, fig, x, y, size, rng);
  else if (fig.kind === "shape") shape(pen, fig, x, y, size, rng);
  else if (fig.kind === "flow") flow(pen, fig, x, y, size, rng);
  else if (fig.kind === "table") table(pen, fig, x, y, size, rng);
  else if (fig.kind === "forces") forces(pen, fig, x, y, size, rng);
  else if (fig.kind === "steps") steps(pen, fig, x, y, size, rng);
  else if (fig.kind === "diagram") diagram(pen, fig, x, y, size, rng);
  else if (fig.kind === "bars") bars(pen, fig, x, y, size, rng);
  else if (fig.kind === "sketch") sketch(pen, fig, x, y, size, rng);
}
