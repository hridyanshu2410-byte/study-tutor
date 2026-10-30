// Draws the tutor's figures (graphs, number lines, shapes, flow diagrams,
// tables, force diagrams, equation steps, diagrams, bars, sketches, scenes) with the
// same hand-drawn pen as its writing: stroke by stroke, a little uneven, at
// hand speed.
//
// A figure can be built up over several spoken phrases: the tutor draws the
// first part, then adds to it as it talks. So every part of a figure is drawn
// with its own tag and its own wobble, and lays out the same however many
// parts come after it: drawing the grown figure again gives the same strokes
// for the old parts, and only the new tags need drawing.

import type { Box } from "./ink.ts";
import { arrow, jitter, measureText, seeded, write, type Pen, type Rng } from "./handwriting.ts";
import { compile } from "./expr.ts";
import type { Figure } from "./figure-schema.ts";
import { boxExit, curveThrough, dot, head, line, ring, roundBox, wrapTo, type Pt } from "./pen-shapes.ts";
import { scene, sceneRoom } from "./scene.ts";
// Starts a part of the figure: tags the strokes that follow and gives the part its own randomness.
type Part = (tag: string) => Rng;
// Measurements taken from a figure's first part, so later parts line up with it.
export type FigureLayout = { eqX?: number; restW?: number; widths?: number[] };

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

function graph(pen: Pen, fig: Extract<Figure, { kind: "graph" }>, x: number, y: number, size: number, part: Part) {
  let { x_min: x0, x_max: x1, y_min: y0, y_max: y1 } = fig;
  if (!(x1 > x0)) [x0, x1] = [-5, 5];
  if (!(y1 > y0)) [y0, y1] = [-5, 5];
  const L = x + size * 1.4, R = L + size * 11, T = y + size * 0.6, B = T + size * 7.5;
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (R - L);
  const sy = (v: number) => B - ((v - y0) / (y1 - y0)) * (B - T);
  const ax = x0 <= 0 && x1 >= 0 ? sx(0) : L;
  const ay = y0 <= 0 && y1 >= 0 ? sy(0) : B;
  const small = Math.max(13, size * 0.5);

  let rng = part("axes");
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

  fig.curves.slice(0, 5).forEach((c, ci) => {
    let f: (v: number) => number;
    try {
      f = compile(c.formula);
    } catch {
      return;
    }
    rng = part(`curve:${ci}`);
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
  });

  fig.points.slice(0, 8).forEach((pt, i) => {
    if (pt.x < x0 || pt.x > x1 || pt.y < y0 || pt.y > y1) return;
    const r = part(`point:${i}`);
    pen.lift(150);
    dot(pen, [sx(pt.x), sy(pt.y)], 3.5);
    if (pt.label) write(pen, pt.label, sx(pt.x) + 9, sy(pt.y) - 9, size * 0.6, r);
  });
}

function numberLine(pen: Pen, fig: Extract<Figure, { kind: "number_line" }>, x: number, y: number, size: number, part: Part) {
  let { from, to } = fig;
  if (!(to > from)) [from, to] = [-5, 5];
  const small = Math.max(13, size * 0.55);
  const step = niceStep(to - from, 10);
  // Wide enough that the numbers under the ticks never touch.
  const W = Math.max(size * 13, ((to - from) / step) * small * 2.8);
  const ly = y + size * 2.4;
  const s = (v: number) => x + size * 0.8 + ((v - from) / (to - from)) * (W - size * 1.6);
  const rng = part("axis");
  line(pen, [x, ly], [x + W, ly], rng, 2.2);
  head(pen, [x + W, ly], 0, 10, rng);
  head(pen, [x, ly], Math.PI, 10, rng);
  for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) {
    pen.lift(30);
    line(pen, [s(v), ly - 6], [s(v), ly + 6], rng, 2);
    write(pen, num(v), s(v) - measureText(num(v), small) / 2, ly + small * 2.2, small, rng);
  }
  if (fig.shade_from != null && fig.shade_to != null) {
    const r = part(`shade:${fig.shade_from}:${fig.shade_to}`);
    const a = s(Math.max(from, Math.min(fig.shade_from, fig.shade_to)));
    const b = s(Math.min(to, Math.max(fig.shade_from, fig.shade_to)));
    pen.lift(150);
    line(pen, [a, ly - 3], [b, ly - 3], r, 1.6);
    line(pen, [b, ly - 6], [a, ly - 6], r, 1.6);
  }
  fig.marks.slice(0, 8).forEach((m, i) => {
    const r = part(`mark:${i}`);
    pen.lift(120);
    if (m.open) ring(pen, [s(m.at), ly], 5, r);
    else dot(pen, [s(m.at), ly], 5);
    if (m.label) write(pen, m.label, s(m.at) - measureText(m.label, small) / 2, ly - 14, small, r);
  });
  fig.jumps.slice(0, 6).forEach((j, i) => {
    const r = part(`jump:${i}`);
    const a = s(j.from), b = s(j.to);
    const h = size * 0.9 + Math.abs(b - a) * 0.12;
    const pts: Pt[] = [];
    for (let k = 0; k <= 20; k++) {
      const f = k / 20;
      pts.push([a + (b - a) * f, ly - 10 - Math.sin(f * Math.PI) * h]);
    }
    pen.lift(150);
    pen.draw(pts, 1.6);
    head(pen, pts.at(-1)!, Math.atan2(pts.at(-1)![1] - pts.at(-3)![1], pts.at(-1)![0] - pts.at(-3)![0]), 9, r);
    if (j.label) write(pen, j.label, (a + b) / 2 - measureText(j.label, small) / 2, ly - 18 - h, small, r);
  });
}

function shape(pen: Pen, fig: Extract<Figure, { kind: "shape" }>, x: number, y: number, size: number, part: Part) {
  const vs = fig.vertices.slice(0, 8);
  if (vs.length < 2) return;
  const rng = part("shape");
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

function flow(pen: Pen, fig: Extract<Figure, { kind: "flow" }>, x: number, y: number, size: number, part: Part) {
  const rng = part("flow");
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
    pen.lift(120);
    roundBox(pen, n.box, rng);
    n.lines.forEach((l, i) => write(pen, l, n.box.x + ts, n.box.y + ts * 1.7 + i * ts * 1.55, ts, rng));
  }
  const arrows = fig.arrows.length ? fig.arrows : nodes.slice(1).map((_, i) => ({ from: i, to: i + 1, label: null }));
  for (const a of arrows.slice(0, 10)) {
    const A = nodes[a.from]?.box, Bx = nodes[a.to]?.box;
    if (!A || !Bx || A === Bx) continue;
    const ca: Pt = [A.x + A.w / 2, A.y + A.h / 2], cb: Pt = [Bx.x + Bx.w / 2, Bx.y + Bx.h / 2];
    const p0 = boxExit(A, cb), p1 = boxExit(Bx, ca);
    pen.lift(120);
    arrow(pen, p0, p1, rng);
    if (a.label) {
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      write(pen, a.label, fig.direction === "right" ? mx - measureText(a.label, ls) / 2 : mx + 10, fig.direction === "right" ? my - 16 : my + ls * 0.4, ls, rng);
    }
  }
}

// One row at a time (its own stretch of each rule and its cells), so a table
// can grow by rows. Column widths come from the first part.
function table(pen: Pen, fig: Extract<Figure, { kind: "table" }>, x: number, y: number, size: number, part: Part, fixed?: FigureLayout): FigureLayout {
  const rows = fig.rows.slice(0, 10).map((r) => r.slice(0, 6).map((c) => c.slice(0, 16)));
  const ts = Math.max(15, size * 0.62);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths =
    fixed?.widths ?? Array.from({ length: cols }, (_, c) => Math.max(ts * 2, ...rows.map((r) => measureText(r[c] ?? "", ts))) + ts * 1.4);
  if (!rows.length) return { widths };
  const rh = ts * 2;
  const W = widths.reduce((a, b) => a + b, 0);
  rows.forEach((row, ri) => {
    const rng = part(`row:${ri}`);
    const top = y + ri * rh, bottom = top + rh;
    if (ri === 0) line(pen, [x, top], [x + W, top], rng, 2.2);
    pen.lift(40);
    line(pen, [x, top], [x, bottom], rng, 2.4);
    let cx = x;
    for (let c = 0; c < widths.length; c++) {
      cx += widths[c];
      pen.lift(30);
      line(pen, [cx, top], [cx, bottom], rng, 2.4);
    }
    pen.lift(40);
    line(pen, [x + W, bottom], [x, bottom], rng, 2.2);
    if (ri === 0 && fig.header) line(pen, [x, bottom + 3], [x + W, bottom + 3], rng, 2.2);
    let left = x;
    row.forEach((cell, ci) => {
      const w = widths[ci] ?? widths.at(-1)!;
      if (cell) write(pen, cell, left + (w - measureText(cell, ts)) / 2, top + rh * 0.68, ts, rng);
      left += w;
    });
  });
  return { widths };
}

function forces(pen: Pen, fig: Extract<Figure, { kind: "forces" }>, x: number, y: number, size: number, part: Part) {
  const c: Pt = [x + size * 6, y + size * 4.5];
  const side = size * 2;
  const tilt = ((fig.incline_deg ?? 0) * Math.PI) / 180;
  const rng = part("body");
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
  fig.forces.slice(0, 6).forEach((f, i) => {
    const r = part(`force:${i}`);
    const a = (f.angle_deg * Math.PI) / 180;
    const len = size * 3.6 * Math.max(0.3, Math.min(1, f.size || 0.6));
    const start: Pt = [c[0] + Math.cos(a) * 4, c[1] - Math.sin(a) * 4];
    const tip: Pt = [c[0] + Math.cos(a) * len, c[1] - Math.sin(a) * len];
    pen.lift(150);
    line(pen, start, tip, r, 1.8);
    head(pen, tip, Math.atan2(tip[1] - c[1], tip[0] - c[0]), 11, r);
    const ls = size * 0.62;
    const lx = tip[0] + Math.cos(a) * 12 - (Math.cos(a) < -0.3 ? measureText(f.label, ls) : Math.cos(a) < 0.3 ? measureText(f.label, ls) / 2 : 0);
    const ly = tip[1] - Math.sin(a) * 14 + ls * 0.4;
    write(pen, f.label, lx, ly, ls, r);
  });
}

// Equation lines under one another, lined up on the equals sign, with what
// was done written to the right, the way it's done on a board. The equals
// sign's place comes from the first part, so lines added later line up too.
function steps(pen: Pen, fig: Extract<Figure, { kind: "steps" }>, x: number, y: number, size: number, part: Part, fixed?: FigureLayout): FigureLayout {
  const parts = fig.lines.slice(0, 10).map((l) => {
    const i = l.math.indexOf("=");
    return i < 0 ? { pre: "", rest: l.math, note: l.note } : { pre: l.math.slice(0, i).trimEnd() + " ", rest: l.math.slice(i), note: l.note };
  });
  const eqX = fixed?.eqX ?? Math.max(0, ...parts.map((p) => measureText(p.pre, size)));
  const restW = fixed?.restW ?? Math.max(0, ...parts.map((p) => measureText(p.rest, size)));
  parts.forEach((p, i) => {
    const rng = part(`line:${i}`);
    const base = y + size * 1.4 + i * size * 2.3;
    pen.lift(i ? 160 : 0);
    write(pen, p.pre + p.rest, x + eqX - measureText(p.pre, size), base, size, rng);
    if (p.note) {
      const nx = x + eqX + Math.max(restW, measureText(p.rest, size)) + size * 1.2;
      line(pen, [nx, base - size * 0.95], [nx, base + size * 0.15], rng, 2);
      write(pen, p.note, nx + size * 0.4, base, size * 0.7, rng);
    }
  });
  return { eqX, restW };
}

// Boxes on a grid of rows and columns, one box per cell, with arrows between
// them and named outlines around groups. Every cell is the same size, so a
// box's place depends only on its row and column and the diagram can grow.
export const DIAGRAM_CELL = { w: 7.2, h: 3.2, gapX: 2.6, gapY: 2.4 };

function diagram(pen: Pen, fig: Extract<Figure, { kind: "diagram" }>, x: number, y: number, size: number, part: Part) {
  const ts = Math.max(14, size * 0.55);
  const ls = Math.max(12, size * 0.46);
  const cw = size * DIAGRAM_CELL.w, ch = size * DIAGRAM_CELL.h;
  const pitchX = cw + size * DIAGRAM_CELL.gapX, pitchY = ch + size * DIAGRAM_CELL.gapY;
  let top = y;
  if (fig.title) {
    const rng = part("title");
    write(pen, fig.title, x, top + ts * 1.1, ts * 1.1, rng);
  }
  // room for the title and for a frame's name above the first row
  top += fig.title ? ts * 3.2 : ts * 1.8;
  const taken = new Set<string>();
  const nodes = fig.nodes.slice(0, 14).map((n) => {
    let row = Math.max(0, Math.min(5, Math.round(Number.isFinite(n.row) ? n.row : 0)));
    let col = Math.max(0, Math.min(5, Math.round(Number.isFinite(n.col) ? n.col : 0)));
    // two boxes in one cell: the later one moves along to the next free cell
    while (taken.has(`${row},${col}`) && col < 8) col++;
    taken.add(`${row},${col}`);
    const rows = wrapTo(n.text, ts, cw - ts * 1.4);
    const w = Math.min(cw, Math.max(size * 3, ...rows.map((r) => measureText(r, ts))) + ts * 1.6);
    const h = rows.length * ts * 1.5 + ts * 1.2;
    const box: Box = { x: x + col * pitchX + (cw - w) / 2, y: top + row * pitchY + (ch - h) / 2, w, h };
    return { id: n.id, rows, box, row, col };
  });
  if (!nodes.length) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const f of fig.frames.slice(0, 4)) {
    const members = f.nodes.map((id) => byId.get(id)?.box).filter((b): b is Box => !!b);
    if (!members.length) continue;
    const rng = part(`frame:${f.label}`);
    const gx = Math.min(...members.map((b) => b.x)) - ts * 0.8, gy = Math.min(...members.map((b) => b.y)) - ts * 2;
    const gb = { x: gx, y: gy, w: Math.max(...members.map((b) => b.x + b.w)) + ts * 0.8 - gx, h: Math.max(...members.map((b) => b.y + b.h)) + ts * 0.8 - gy };
    pen.lift(120);
    roundBox(pen, gb, rng, 2.4);
    write(pen, f.label, gb.x + ts * 0.6, gb.y + ts * 1.3, ls, rng);
  }
  for (const n of nodes) {
    const rng = part(`node:${n.id}`);
    pen.lift(120);
    roundBox(pen, n.box, rng);
    n.rows.forEach((r, i) => write(pen, r, n.box.x + (n.box.w - measureText(r, ts)) / 2, n.box.y + ts * 1.55 + i * ts * 1.5, ts, rng));
  }
  for (const e of fig.edges.slice(0, 18)) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a === b) continue;
    const rng = part(`edge:${e.from}>${e.to}`);
    const A = a.box, B = b.box;
    const ca: Pt = [A.x + A.w / 2, A.y + A.h / 2], cb: Pt = [B.x + B.w / 2, B.y + B.h / 2];
    // an arrow that would pass through the boxes between its ends arcs around them
    const skip = (a.row === b.row && Math.abs(a.col - b.col) > 1) || (a.col === b.col && Math.abs(a.row - b.row) > 1);
    let p0 = boxExit(A, cb), p1 = boxExit(B, ca);
    if (skip && a.row === b.row) {
      p0 = [ca[0] + Math.sign(cb[0] - ca[0]) * A.w * 0.25, A.y - 6];
      p1 = [cb[0] - Math.sign(cb[0] - ca[0]) * B.w * 0.25, B.y - 6];
    } else if (skip) {
      p0 = [A.x + A.w + 6, ca[1] + Math.sign(cb[1] - ca[1]) * A.h * 0.25];
      p1 = [B.x + B.w + 6, cb[1] - Math.sign(cb[1] - ca[1]) * B.h * 0.25];
    }
    pen.lift(120);
    const bend = skip ? (a.row === b.row ? Math.sign(cb[0] - ca[0]) : -Math.sign(cb[1] - ca[1])) * 0.35 : undefined;
    arrow(pen, p0, p1, rng, bend);
    if (e.label) {
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      const across = Math.abs(p1[0] - p0[0]) > Math.abs(p1[1] - p0[1]);
      const lift = skip && a.row === b.row ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.2 : 0;
      write(pen, e.label, across ? mx - measureText(e.label, ls) / 2 : mx + 10, across ? my - 12 - lift : my + ls * 0.4, ls, rng);
    }
  }
}

function bars(pen: Pen, fig: Extract<Figure, { kind: "bars" }>, x: number, y: number, size: number, part: Part) {
  const items = fig.bars.slice(0, 8).filter((b) => Number.isFinite(b.value));
  if (!items.length) return;
  const rng = part("bars");
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

// A sketch lives on a 100 by 100 grid this many text sizes across.
export const SKETCH_SPAN = 11;

function sketch(pen: Pen, fig: Extract<Figure, { kind: "sketch" }>, x: number, y: number, size: number, part: Part) {
  const ts = Math.max(14, size * 0.52);
  let top = y;
  if (fig.title) {
    const rng = part("title");
    write(pen, fig.title, x, top + ts, ts * 1.05, rng);
    top += ts * 1.8;
  }
  const k = (size * SKETCH_SPAN) / 100;
  const clamp = (v: number | undefined) => Math.min(100, Math.max(0, Number.isFinite(v) ? (v as number) : 0));
  const at = (p: number[] | null | undefined): Pt => [x + clamp(p?.[0]) * k, top + clamp(p?.[1]) * k];
  const first = pen.strokes.length;
  fig.paths.slice(0, 30).forEach((path, i) => {
    let pts = path.points.slice(0, 60).filter((p) => p.length >= 2 && p.every(Number.isFinite)).map(at);
    if (pts.length < 2) return;
    const rng = part(`path:${i}`);
    if (path.closed) pts.push(pts[0]);
    if (path.smooth && pts.length > 2) pts = curveThrough(pts, path.closed);
    pen.lift(110);
    pen.draw(pts.map(([px, py]) => [px + jitter(rng, 0.6), py + jitter(rng, 0.6)] as Pt), 1.6);
  });
  (fig.circles ?? []).slice(0, 40).forEach((c, i) => {
    const rng = part(`circle:${i}`);
    const centre = at([c.cx, c.cy]);
    const r = Math.max(1.5, Math.min(50, Number.isFinite(c.r) ? c.r : 3) * k);
    pen.lift(90);
    if (c.filled && r < 10) dot(pen, centre, r);
    else ring(pen, centre, r, rng);
  });
  (fig.arrows ?? []).slice(0, 10).forEach((a, i) => {
    const rng = part(`arrow:${i}`);
    pen.lift(110);
    arrow(pen, at(a.from), at(a.to), rng);
  });
  fig.labels.slice(0, 16).forEach((l, i) => {
    const rng = part(`label:${i}`);
    const text = l.text.slice(0, 24);
    const w = measureText(text, ts);
    // a label that would sit on the drawing moves to the nearest clear space
    const clear = (lx: number, ly: number) => {
      const b = { x: lx - 3, y: ly - ts * 0.85, w: w + 6, h: ts * 1.15 };
      return !pen.strokes.slice(first).some((st) => st.points.some(([px, py]) => px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h));
    };
    const [x0, y0] = at([l.x, l.y]);
    const tries: Pt[] = [[0, 0]];
    for (const d of [1, 2, 3]) tries.push([0, -ts * 1.2 * d], [0, ts * 1.2 * d], [w * 0.6 * d, 0], [-w * 0.6 * d, 0], [w * 0.5 * d, -ts * 1.2 * d], [-w * 0.5 * d, ts * 1.2 * d]);
    const [dx, dy] = tries.find(([ddx, ddy]) => clear(x0 + ddx, y0 + ddy)) ?? [0, 0];
    const lx = x0 + dx, ly = y0 + dy;
    pen.lift(100);
    write(pen, text, lx, ly, ts, rng);
    if (l.point_to) {
      // a leader line from the nearer end of the label to the part it names
      const [tx, ty] = at(l.point_to);
      const sx = Math.abs(tx - lx) < Math.abs(tx - (lx + w)) ? lx - 4 : lx + w + 4;
      pen.lift(80);
      line(pen, [sx, ly - ts * 0.35], [tx, ty], rng);
    }
  });
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// Draws the figure with its top left at (x, y). Pass the layout returned by
// the first part's drawing when drawing a figure that has grown since.
export function drawFigure(pen: Pen, fig: Figure, x: number, y: number, size: number, rng: Rng, layout?: FigureLayout): FigureLayout {
  const base = Math.floor(rng() * 2 ** 31);
  const part: Part = (tag) => {
    pen.tag = tag;
    return seeded(base ^ hash(tag));
  };
  let out: FigureLayout = {};
  if (fig.kind === "graph") graph(pen, fig, x, y, size, part);
  else if (fig.kind === "number_line") numberLine(pen, fig, x, y, size, part);
  else if (fig.kind === "shape") shape(pen, fig, x, y, size, part);
  else if (fig.kind === "flow") flow(pen, fig, x, y, size, part);
  else if (fig.kind === "table") out = table(pen, fig, x, y, size, part, layout);
  else if (fig.kind === "forces") forces(pen, fig, x, y, size, part);
  else if (fig.kind === "steps") out = steps(pen, fig, x, y, size, part, layout);
  else if (fig.kind === "diagram") diagram(pen, fig, x, y, size, part);
  else if (fig.kind === "bars") bars(pen, fig, x, y, size, part);
  else if (fig.kind === "sketch") sketch(pen, fig, x, y, size, part);
  else if (fig.kind === "scene") scene(pen, fig, x, y, size, part);
  pen.tag = undefined;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const added = <T>(old: T[], more: T[], key: (t: T) => string = (t) => JSON.stringify(t)): T[] => {
  const seen = new Set(old.map(key));
  return [...old, ...more.filter((m) => !seen.has(key(m)))];
};

// The figure with the next part added: its new boxes, arrows, curves, lines,
// rows or shapes. Null when the part can't extend it (a different kind, or a
// kind whose layout depends on all of its parts at once, like bars).
export function extendFigure(base: Figure, more: Figure): Figure | null {
  if (base.kind !== more.kind) return null;
  if (base.kind === "graph" && more.kind === "graph") return { ...base, curves: added(base.curves, more.curves, (c) => c.formula), points: added(base.points, more.points) };
  if (base.kind === "number_line" && more.kind === "number_line")
    return {
      ...base,
      marks: added(base.marks, more.marks),
      jumps: added(base.jumps, more.jumps),
      shade_from: more.shade_from ?? base.shade_from,
      shade_to: more.shade_to ?? base.shade_to,
    };
  if (base.kind === "table" && more.kind === "table") return { ...base, rows: [...base.rows, ...more.rows.filter((r) => !base.rows.some((o) => same(o, r)))] };
  if (base.kind === "forces" && more.kind === "forces") return { ...base, forces: added(base.forces, more.forces, (f) => f.label) };
  if (base.kind === "steps" && more.kind === "steps") return { ...base, lines: added(base.lines, more.lines, (l) => l.math) };
  if (base.kind === "diagram" && more.kind === "diagram")
    return {
      ...base,
      nodes: added(base.nodes, more.nodes, (n) => n.id),
      edges: added(base.edges, more.edges, (e) => `${e.from}>${e.to}`),
      frames: added(base.frames, more.frames, (f) => f.label),
    };
  if (base.kind === "scene" && more.kind === "scene")
    return {
      ...base,
      things: added(base.things, more.things, (t) => t.id),
      arrows: added(base.arrows, more.arrows, (a) => `${a.from}>${a.to}`),
      marks: added(base.marks, more.marks, (m) => `${m.on}:${m.kind}`),
    };
  if (base.kind === "sketch" && more.kind === "sketch")
    return {
      ...base,
      paths: added(base.paths, more.paths),
      circles: added(base.circles ?? [], more.circles ?? []),
      arrows: added(base.arrows ?? [], more.arrows ?? []),
      labels: added(base.labels, more.labels),
    };
  return null;
}

// The space a figure may grow into after its first part, relative to its top
// left: a diagram's grid, a sketch's square, more equation lines or rows.
export function figureRoom(fig: Figure, size: number, drawn: Box, x: number, y: number): Box {
  const grow = (w: number, h: number) => ({ x: drawn.x, y: drawn.y, w: Math.max(drawn.w, w - (drawn.x - x)), h: Math.max(drawn.h, h - (drawn.y - y)) });
  // A grid figure can grow into any of its cells, above or left of its first
  // ink too (a speech bubble, a thing in an earlier column), and a circle
  // round an edge cell reaches a little past the grid: hold all of it.
  const grid = (w: number, h: number, edge: number): Box => {
    const x0 = Math.min(drawn.x, x - edge), y0 = Math.min(drawn.y, y - edge);
    return { x: x0, y: y0, w: Math.max(drawn.x + drawn.w, x + w + edge) - x0, h: Math.max(drawn.y + drawn.h, y + h + edge) - y0 };
  };
  if (fig.kind === "diagram") {
    const ts = Math.max(14, size * 0.55);
    // a diagram can grow along its row to the full width of the grid
    const cols = 4;
    const rows = Math.min(4, Math.max(0, ...fig.nodes.map((n) => n.row)) + 2);
    const head = fig.title ? ts * 3.2 : ts * 1.8;
    return grid(cols * size * (DIAGRAM_CELL.w + DIAGRAM_CELL.gapX), head + rows * size * (DIAGRAM_CELL.h + DIAGRAM_CELL.gapY), ts * 0.5);
  }
  if (fig.kind === "scene") {
    const room = sceneRoom(fig, size);
    return grid(room.w, room.h, Math.max(14, size * 0.52) * 1.2);
  }
  if (fig.kind === "sketch") {
    const ts = Math.max(14, size * 0.52);
    return grow(size * SKETCH_SPAN + ts * 5, size * SKETCH_SPAN + (fig.title ? ts * 1.8 : 0) + ts);
  }
  if (fig.kind === "steps") return grow(drawn.w + size * 4, (fig.lines.length + 3) * size * 2.3 + size);
  if (fig.kind === "table") return grow(drawn.w, drawn.h + Math.max(15, size * 0.62) * 2 * 3);
  if (fig.kind === "forces") return grow(size * 12, size * 9.5);
  if (fig.kind === "number_line") return { x: drawn.x, y: drawn.y - size * 2, w: drawn.w, h: drawn.h + size * 2 };
  return drawn;
}
