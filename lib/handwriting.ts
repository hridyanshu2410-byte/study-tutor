// Turns what the tutor wants to do on the page (circle this, arrow to there,
// write that) into timed pen strokes, so the ink appears the way a person's
// pen moves: one stroke at a time, at hand speed, never quite perfect.

import type { Box, InkLine } from "./ink.ts";
import { spanBox, unionBox } from "./ink.ts";
import hand from "./tutor-hand/ems-felix.json" with { type: "json" };

export type PenStroke = { points: [number, number][]; start: number; end: number };
export type PenPlan = { strokes: PenStroke[]; duration: number; box: Box | null };

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
type Rng = () => number;
const jitter = (rng: Rng, amount: number) => (rng() * 2 - 1) * amount;

// ---------- a pen that keeps time ----------
class Pen {
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
function arrow(pen: Pen, from: [number, number], to: [number, number], rng: Rng) {
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
export function measureText(text: string, size: number): number {
  const scale = size / font.capHeight;
  let w = 0;
  for (const ch of text) w += (font.glyphs[ch] ?? font.glyphs["?"]).w * scale * 0.96 * (ch === " " ? SPACE : 1);
  return w;
}

// The font's word space is wide for math; people write "5x + 5" tighter than prose.
const SPACE = 0.55;

// Writes glyph by glyph with a drifting baseline, small changes in size and
// slant, and pauses where the pen lifts.
function write(pen: Pen, text: string, x: number, baseline: number, size: number, rng: Rng) {
  const scale = size / font.capHeight;
  let cursor = x;
  let drift = 0;
  const slant = jitter(rng, 0.03);
  for (const ch of text) {
    const g = font.glyphs[ch] ?? font.glyphs["?"];
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
  // Earlier tutor ink to keep clear of.
  avoid?: Box[];
  // Where to write on an empty page (top left of the visible area).
  origin?: { x: number; y: number };
};

export function planAnnotations(annotations: Annotation[], lines: InkLine[], seed: number, opts: PlanOptions = {}): PenPlan {
  const rng = seeded(seed);
  const lineH = lines.length ? lines.reduce((s, l) => s + l.box.h, 0) / lines.length : 40;
  const size = Math.max(20, Math.min(40, lineH * 0.62));
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

  const work = (opts.write ?? []).map((w) => w.trim()).filter(Boolean);
  if (work.length) {
    const workSize = size * 0.95;
    const below = [...occupied, ...(opts.avoid ?? [])];
    const left = lines.length ? Math.min(...lines.map((l) => l.box.x)) : (opts.origin?.x ?? 0) + 60;
    const bottom = below.length ? Math.max(...below.map((b) => b.y + b.h)) : (opts.origin?.y ?? 0) + 80;
    let baseline = bottom + workSize * 1.9;
    pen.lift(pen.t ? 300 : 0);
    for (const text of work) {
      write(pen, text, left + jitter(rng, 6), baseline, workSize, rng);
      pen.lift(180);
      baseline += workSize * 1.65;
    }
  }

  return { strokes: pen.strokes, duration: pen.t, box: pen.box };
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
