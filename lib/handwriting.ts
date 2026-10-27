// Turns what the tutor wants to do on the page (circle this, arrow to there,
// write that) into timed pen strokes, so the ink appears the way a person's
// pen moves: one stroke at a time, at hand speed, never quite perfect.

import type { Box, InkLine } from "./ink.ts";
import { spanBox, unionBox } from "./ink.ts";
import hand from "./tutor-hand/ems-felix.json" with { type: "json" };
import { drawFigure } from "./figures.ts";
import type { Figure } from "./figure-schema.ts";

export type PenStroke = { points: [number, number][]; start: number; end: number };
// `parts` are the boxes of what was written or drawn (not the arrows between),
// so later turns can tuck their own work into the gaps.
export type PenPlan = { strokes: PenStroke[]; duration: number; box: Box | null; parts?: Box[] };

// Roughly how long a line takes to say aloud.
export function speechMs(text: string): number {
  return 600 + text.trim().split(/\s+/).filter(Boolean).length * 400;
}

// The same plan played faster (factor below 1), so the pen keeps pace with the
// voice; never more than about three times hand speed.
export function retime(plan: PenPlan, factor: number): PenPlan {
  const f = Math.max(0.35, Math.min(1, factor));
  if (f === 1) return plan;
  return { ...plan, strokes: plan.strokes.map((s) => ({ ...s, start: s.start * f, end: s.end * f })), duration: plan.duration * f };
}

export type Annotation = {
  kind: "circle" | "underline" | "strike" | "check" | "question" | "note";
  line_id: string;
  from_token: number | null;
  to_token: number | null;
  text: string | null;
  placement: "right" | "above" | "below" | null;
  arrow: boolean;
};

type Font = { xHeight: number; capHeight: number; glyphs: Record<string, { w: number; s: number[][] }> };
const font = hand as Font;

// ---------- randomness that is stable for a given seed ----------
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
export const jitter = (rng: Rng, amount: number) => (rng() * 2 - 1) * amount;

// ---------- a pen that keeps time ----------
export class Pen {
  strokes: PenStroke[] = [];
  t = 0;
  box: Box | null = null;
  speed: number;
  constructor(speed: number) {
    this.speed = speed;
  }

  draw(points: [number, number][], speedFactor = 1) {
    if (points.length < 2) return;
    const pts = resample(points, 2.5);
    const ms = Math.max(60, length(pts) / (this.speed * speedFactor));
    this.strokes.push({ points: pts, start: this.t, end: this.t + ms });
    this.t += ms;
    for (const [x, y] of pts) {
      const b = { x, y, w: 0, h: 0 };
      this.box = this.box ? unionBox(this.box, b) : b;
    }
  }

  lift(ms: number) {
    this.t += ms;
  }
}

function length(pts: [number, number][]) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

function resample(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

// ---------- shapes ----------
type Ellipse = { cx: number; cy: number; rx: number; ry: number };

// A loop started at the upper left and carried a little past where it began,
// slightly tilted and not quite closed: how people actually circle things.
function circle(pen: Pen, box: Box, rng: Rng): Ellipse {
  const e = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2 + 12 + rng() * 6, ry: box.h / 2 + 10 + rng() * 5 };
  const tilt = jitter(rng, 0.07);
  const start = -2.3 + jitter(rng, 0.3);
  const sweep = Math.PI * 2 * (1.06 + rng() * 0.08);
  const phase = rng() * Math.PI * 2;
  const pts: [number, number][] = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = start - sweep * f; // counter-clockwise on screen
    const wobble = 1 + 0.04 * Math.sin(a * 2 + phase) + 0.07 * f; // spirals outward as it closes
    const x = Math.cos(a) * e.rx * wobble;
    const y = Math.sin(a) * e.ry * wobble;
    pts.push([e.cx + x * Math.cos(tilt) - y * Math.sin(tilt), e.cy + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  pen.draw(pts, 1.6);
  return e;
}

function underline(pen: Pen, box: Box, rng: Rng) {
  const y = box.y + box.h + 7;
  const x0 = box.x - 4 + jitter(rng, 3);
  const x1 = box.x + box.w + 6 + jitter(rng, 4);
  const sag = 3 + rng() * 3;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const f = i / 16;
    pts.push([x0 + (x1 - x0) * f, y + Math.sin(f * Math.PI) * sag - f * f * 5 + jitter(rng, 0.6)]);
  }
  pen.draw(pts, 1.8);
}

function strike(pen: Pen, box: Box, rng: Rng) {
  pen.draw(
    [
      [box.x - 6, box.y + box.h * (0.62 + jitter(rng, 0.06))],
      [box.x + box.w / 2, box.y + box.h * 0.5 + jitter(rng, 2)],
      [box.x + box.w + 6, box.y + box.h * (0.36 + jitter(rng, 0.06))],
    ],
    1.8,
  );
}

function check(pen: Pen, box: Box, rng: Rng) {
  const s = Math.max(14, Math.min(26, box.h * 0.5));
  const x = box.x + box.w + 18;
  const y = box.y + box.h / 2;
  pen.draw([
    [x - s * 0.5, y + jitter(rng, 2)],
    [x - s * 0.1, y + s * 0.45],
    [x + s * 0.2, y - s * 0.1],
    [x + s * 0.8 + jitter(rng, 3), y - s * 0.95],
  ]);
}

// A bowed line with a quick two-winged head drawn in one motion.
export function arrow(pen: Pen, from: [number, number], to: [number, number], rng: Rng) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d < 12) return;
  const bow = (rng() < 0.5 ? -1 : 1) * d * (0.12 + rng() * 0.08);
  const nx = -(y1 - y0) / d;
  const ny = (x1 - x0) / d;
  const cx = (x0 + x1) / 2 + nx * bow;
  const cy = (y0 + y1) / 2 + ny * bow;
  const shaft: [number, number][] = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    shaft.push([(1 - f) ** 2 * x0 + 2 * (1 - f) * f * cx + f * f * x1, (1 - f) ** 2 * y0 + 2 * (1 - f) * f * cy + f * f * y1]);
  }
  pen.draw(shaft, 2.2);
  pen.lift(90);
  const ang = Math.atan2(y1 - cy, x1 - cx);
  const wing = Math.min(20, 11 + d * 0.06);
  const spread = 0.48 + jitter(rng, 0.06);
  pen.draw(
    [
      [x1 - wing * Math.cos(ang - spread), y1 - wing * Math.sin(ang - spread)],
      [x1, y1],
      [x1 - wing * 1.05 * Math.cos(ang + spread), y1 - wing * 1.05 * Math.sin(ang + spread)],
    ],
    1.4,
  );
}

// ---------- handwriting ----------
// Characters the hand doesn't have, written as the nearest one it does.
const ALIAS: Record<string, string> = { "−": "–", "′": "'", "″": "\"", "‘": "'", "’": "'", "≈": "~", "∙": "·", "⋅": "·", "∞": "oo" };
const glyph = (ch: string) => font.glyphs[ch] ?? font.glyphs[ALIAS[ch] ?? ""] ?? font.glyphs["?"];

export function measureText(text: string, size: number): number {
  const scale = size / font.capHeight;
  let w = 0;
  for (const ch of text) w += glyph(ch).w * scale * 0.96 * (ch === " " ? SPACE : 1);
  return w;
}

// The font's word space is wide for math; people write "5x + 5" tighter than prose.
const SPACE = 0.55;

// Writes glyph by glyph with a drifting baseline, small changes in size and
// slant, and pauses where the pen lifts.
export function write(pen: Pen, text: string, x: number, baseline: number, size: number, rng: Rng) {
  const scale = size / font.capHeight;
  let cursor = x;
  let drift = 0;
  const slant = jitter(rng, 0.03);
  for (const ch of text) {
    const g = glyph(ch);
    drift = drift * 0.7 + jitter(rng, size * 0.035);
    const s = scale * (1 + jitter(rng, 0.04));
    const rot = slant + jitter(rng, 0.035);
    for (const stroke of g.s) {
      const pts: [number, number][] = [];
      for (let k = 0; k < stroke.length; k += 2) {
        const gx = stroke[k] * s;
        const gy = -stroke[k + 1] * s;
        pts.push([cursor + gx * Math.cos(rot) - gy * Math.sin(rot), baseline + drift + gx * Math.sin(rot) + gy * Math.cos(rot)]);
      }
      // A full stop or decimal point is too small to show at the pen's width; dab it instead.
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < size * 0.2) {
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2, r = Math.max(1.2, size * 0.045);
        pts.length = 0;
        for (let i = 0; i <= 10; i++) pts.push([cx + Math.cos(i * 1.3) * r * (1 - i / 14), cy + Math.sin(i * 1.3) * r * (1 - i / 14)]);
      }
      pen.draw(pts);
      pen.lift(35 + rng() * 30);
    }
    if (ch === " ") pen.lift(90);
    cursor += g.w * scale * (0.96 + jitter(rng, 0.03)) * (ch === " " ? SPACE : 1);
  }
  pen.lift(60);
}

// ---------- a whole turn ----------
export type PlanOptions = {
  // Lines of math the tutor writes in its own space, below everything on the page.
  write?: string[];
  // Graphs, diagrams and tables, drawn below the written lines.
  figures?: Figure[];
  // Earlier tutor ink to keep clear of.
  avoid?: Box[];
  // Where to write on an empty page (top left of the visible area).
  origin?: { x: number; y: number };
  // Paper mode: the tutor writes in the workspace beside the paper, starting
  // near the top of what's on screen rather than below everything. Margin
  // notes keep to a lane next to the paper; drawings go beyond it, in a new
  // lane further right when the current one is full down to `bottom`.
  column?: { x: number; top: number; bottom?: number };
  // Passages in the paper the tutor points at (the app highlights or rules
  // them), each with an optional margin note in the workspace joined by an
  // arrow from the page edge.
  marks?: { boxes: Box[]; kind: "highlight" | "underline"; note: string | null; edge: number }[];
  // Writing size, when it shouldn't follow the student's handwriting (beside a paper's small print).
  size?: number;
};

export function planAnnotations(annotations: Annotation[], lines: InkLine[], seed: number, opts: PlanOptions = {}): PenPlan {
  const rng = seeded(seed);
  const lineH = lines.length ? lines.reduce((s, l) => s + l.box.h, 0) / lines.length : 40;
  const size = opts.size ?? Math.max(20, Math.min(40, lineH * 0.62));
  const pen = new Pen(size * 0.045);
  const occupied: Box[] = lines.map((l) => l.box);

  let lastTarget: { box: Box; line: InkLine; ellipse: Ellipse | null } | null = null;

  for (const a of annotations) {
    const line = lines.find((l) => l.id === a.line_id) ?? lines.at(-1);
    if (!line) continue;
    const box = a.from_token == null ? line.box : spanBox(line, a.from_token, a.to_token ?? a.from_token);

    if (a.kind === "note") {
      if (!a.text?.trim()) continue;
      const anchor = lastTarget && (lastTarget.line.id === line.id || a.line_id === lastTarget.line.id) ? lastTarget : { box, line, ellipse: null };
      const width = measureText(a.text, size);
      const spot = placeNote(a.placement ?? "right", anchor.box, anchor.line.box, width, size, occupied);
      if (a.arrow) {
        const target: [number, number] =
          spot.side === "right" ? [spot.x - 14, spot.baseline - size * 0.4] : [spot.x + Math.min(width, 40) / 2, spot.side === "above" ? spot.baseline + 8 : spot.baseline - size - 6];
        const startPt = anchor.ellipse ? ellipseEdgeToward(anchor.ellipse, target) : boxEdgeToward(anchor.box, target);
        pen.lift(160);
        arrow(pen, startPt, target, rng);
      }
      pen.lift(200);
      write(pen, a.text.trim(), spot.x, spot.baseline, size, rng);
      occupied.push({ x: spot.x, y: spot.baseline - size, w: width, h: size * 1.4 });
      continue;
    }

    pen.lift(lastTarget ? 220 : 0);
    let ellipse: Ellipse | null = null;
    if (a.kind === "circle") ellipse = circle(pen, box, rng);
    else if (a.kind === "underline") underline(pen, box, rng);
    else if (a.kind === "strike") strike(pen, box, rng);
    else if (a.kind === "check") check(pen, box, rng);
    else if (a.kind === "question") write(pen, "?", box.x + box.w + 16, box.y + box.h * 0.85, Math.max(size, box.h * 0.8), rng);
    lastTarget = { box, line, ellipse };
  }

  const col = opts.column;
  const parts: Box[] = [];
  const taken = () => [...occupied, ...(opts.avoid ?? [])];
  // The first free spot at least `h` tall at or below `from`, for something `w` wide at `x`.
  const below = (x: number, from: number, w: number, h: number) => {
    let y = from;
    for (let pass = 0; pass < 60; pass++) {
      const hit = taken().find((o) => o.x < x + w + 12 && o.x + o.w + 12 > x && o.y < y + h + 12 && o.y + o.h + 12 > y);
      if (!hit) break;
      y = hit.y + hit.h + 16;
    }
    return y;
  };
  // The free spot nearest `want`, looking both down and up.
  const nearest = (x: number, want: number, w: number, h: number) => {
    const down = below(x, want, w, h);
    let up = want;
    for (let pass = 0; pass < 60; pass++) {
      const hit = taken().find((o) => o.x < x + w + 12 && o.x + o.w + 12 > x && o.y < up + h + 12 && o.y + o.h + 12 > up);
      if (!hit) break;
      up = hit.y - h - 16;
    }
    return want - up < down - want ? up : down;
  };

  // Margin notes, in a lane beside the paper, as close as they can get to their passage.
  const lane = size * 21;
  for (const m of opts.marks ?? []) {
    if (!m.boxes.length) continue;
    pen.lift(pen.t ? 200 : 0);
    if (!m.note?.trim() || !col) continue;
    const u = m.boxes.reduce(unionBox);
    const rows = wrapWords(m.note.trim(), size, lane);
    const width = Math.max(...rows.map((r) => measureText(r, size)));
    const h = size * 1.5 * rows.length;
    const top = nearest(col.x, u.y + u.h / 2 - size * 0.8, width, h);
    const baseline = top + size * 1.05;
    pen.lift(160);
    arrow(pen, [m.edge + 6, u.y + u.h / 2], [col.x - 12, baseline - size * 0.4], rng);
    pen.lift(120);
    rows.forEach((r, i) => write(pen, r, col.x, baseline + i * size * 1.5, size, rng));
    const box = { x: col.x, y: top, w: width, h };
    occupied.push(box);
    parts.push(box);
  }

  const work = (opts.write ?? []).map((w) => w.trim()).filter(Boolean);
  const figures = opts.figures ?? [];
  const workSize = size * 0.95;
  const figSize = Math.max(workSize, 28);
  // What each written line or figure will cover, measured with a practice pen first.
  const sizeOf = (draw: (p: Pen) => void): Box => {
    const p = new Pen(1);
    draw(p);
    return p.box ?? { x: 0, y: 0, w: 0, h: 0 };
  };
  const put = (b: Box, draw: (x: number, y: number) => void, x: number, y: number) => {
    draw(x - b.x, y - b.y);
    const box = { x, y, w: b.w, h: b.h };
    occupied.push(box);
    parts.push(box);
  };
  if (col && (work.length || figures.length)) {
    // Each piece in the first spot that fits on screen, lane by lane away from the paper.
    const items = [
      ...work.map((text) => ({ draw: (p: Pen, x: number, y: number, r: Rng) => write(p, text, x, y, workSize, r), gap: 180 })),
      ...figures.map((fig) => ({ draw: (p: Pen, x: number, y: number, r: Rng) => drawFigure(p, fig, x, y, figSize, r), gap: 300 })),
    ];
    const lanes = [0, 1, 2, 3].map((k) => col.x + lane + 40 + k * 720);
    pen.lift(pen.t ? 300 : 0);
    for (const it of items) {
      // the practice run uses the same random wobble as the real one, so it measures exactly
      const wobble = Math.floor(rng() * 2 ** 31);
      const b = sizeOf((p) => it.draw(p, 0, 0, seeded(wobble)));
      let spot = { x: lanes[0], y: below(lanes[0], col.top, b.w, b.h) };
      for (const x of lanes) {
        const y = below(x, col.top, b.w, b.h);
        if (col.bottom == null || y + b.h <= col.bottom) {
          spot = { x, y };
          break;
        }
        if (y < spot.y) spot = { x, y };
      }
      pen.lift(it.gap);
      put(b, (dx, dy) => it.draw(pen, dx, dy, seeded(wobble)), spot.x, spot.y);
    }
  } else if (work.length || figures.length) {
    const under = taken();
    const left = lines.length ? Math.min(...lines.map((l) => l.box.x)) : (opts.origin?.x ?? 0) + 60;
    const bottom = under.length ? Math.max(...under.map((b) => b.y + b.h)) : (opts.origin?.y ?? 0) + 80;
    let baseline = bottom + workSize * 1.9;
    pen.lift(pen.t ? 300 : 0);
    for (const text of work) {
      write(pen, text, left + jitter(rng, 6), baseline, workSize, rng);
      pen.lift(180);
      baseline += workSize * 2;
    }
    let figTop = work.length ? baseline - workSize * 0.6 : bottom + workSize * 1.2;
    for (const fig of figures) {
      pen.lift(300);
      // Figures need room to be read, however small the student writes.
      drawFigure(pen, fig, left, figTop, figSize, rng);
      figTop = Math.max(figTop, pen.box ? pen.box.y + pen.box.h : figTop) + workSize * 1.2;
    }
  }
  return { strokes: pen.strokes, duration: pen.t, box: pen.box, parts };
}

// Words broken into rows no wider than `max`.
function wrapWords(text: string, size: number, max: number): string[] {
  const rows: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = rows.at(-1);
    if (last && measureText(`${last} ${word}`, size) <= max) rows[rows.length - 1] = `${last} ${word}`;
    else rows.push(word);
  }
  return rows;
}

function placeNote(
  placement: "right" | "above" | "below",
  target: Box,
  lineBox: Box,
  width: number,
  size: number,
  occupied: Box[],
): { x: number; baseline: number; side: "right" | "above" | "below" } {
  const fits = (b: Box) => !occupied.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  const candidates: { x: number; baseline: number; side: "right" | "above" | "below" }[] = [];
  const right = { x: lineBox.x + lineBox.w + 110, baseline: target.y + target.h / 2 + size * 0.35, side: "right" as const };
  const above = { x: target.x + target.w * 0.3, baseline: target.y - size * 0.9 - 18, side: "above" as const };
  const below = { x: target.x + target.w * 0.3, baseline: target.y + target.h + size * 1.4 + 18, side: "below" as const };
  if (placement === "above") candidates.push(above, right, below);
  else if (placement === "below") candidates.push(below, right, above);
  else candidates.push(right, above, below);
  for (const c of candidates) {
    if (fits({ x: c.x, y: c.baseline - size * 1.1, w: width, h: size * 1.5 })) return c;
  }
  return right; // nothing is free on the right of a line's end, by construction
}

function ellipseEdgeToward(e: Ellipse, [tx, ty]: [number, number]): [number, number] {
  const a = Math.atan2((ty - e.cy) / e.ry, (tx - e.cx) / e.rx);
  return [e.cx + Math.cos(a) * (e.rx + 4), e.cy + Math.sin(a) * (e.ry + 4)];
}

function boxEdgeToward(b: Box, [tx, ty]: [number, number]): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const k = Math.min(Math.abs((b.w / 2 + 8) / (dx || 1e-6)), Math.abs((b.h / 2 + 8) / (dy || 1e-6)));
  return [cx + dx * k, cy + dy * k];
}

// How far along each stroke the pen is at time t, as a point prefix.
export function strokeAt(s: PenStroke, t: number): [number, number][] | null {
  if (t <= s.start) return null;
  if (t >= s.end) return s.points;
  const f = (t - s.start) / (s.end - s.start);
  // ease in and out: pens start and stop slower than they travel
  const e = f * f * (3 - 2 * f);
  return s.points.slice(0, Math.max(2, Math.ceil(s.points.length * e)));
}
