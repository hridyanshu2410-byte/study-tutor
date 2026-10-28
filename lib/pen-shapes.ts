// The pen's basic shapes, shared by the figures and the scenes: lines with a
// hand's slight bow, arrowheads, rings, dots, rounded boxes and smooth curves.

import type { Box } from "./ink.ts";
import { jitter, measureText, type Pen, type Rng } from "./handwriting.ts";

export type Pt = [number, number];

// A ruler-free straight line: a slight bow and wobble, like a confident hand.
export function line(pen: Pen, a: Pt, b: Pt, rng: Rng, speed = 1.6) {
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

export function head(pen: Pen, tip: Pt, ang: number, wing: number, rng: Rng) {
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

export function ring(pen: Pen, c: Pt, r: number, rng: Rng) {
  const pts: Pt[] = [];
  const start = rng() * Math.PI * 2;
  for (let i = 0; i <= 18; i++) {
    const a = start + (i / 18) * Math.PI * 2.1;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  pen.draw(pts, 1.2);
}

// A filled dot: a tight spiral, the way a pen fills one in, with the pen
// pressed a little wider so no paper shows between the turns.
export function dot(pen: Pen, c: Pt, r: number) {
  const pts: Pt[] = [];
  for (let i = 0; i <= 30; i++) {
    const a = (i / 30) * Math.PI * 5;
    const rr = r * (1 - i / 32);
    pts.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
  }
  const width = pen.width;
  pen.width = Math.max(width, r * 0.75);
  pen.draw(pts, 1.2);
  pen.width = width;
}

// Words broken into at most three rows no wider than `max` at text size `ts`.
export function wrapTo(text: string, ts: number, max: number): string[] {
  const rows: string[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const last = rows.at(-1);
    if (last && measureText(`${last} ${word}`, ts) <= max) rows[rows.length - 1] = `${last} ${word}`;
    else rows.push(word);
  }
  return rows.slice(0, 3);
}

export function roundBox(pen: Pen, b: Box, rng: Rng, speed = 1.8) {
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
export function boxExit(b: Box, toward: Pt): Pt {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = toward[0] - cx, dy = toward[1] - cy;
  const k = Math.min(Math.abs((b.w / 2 + 6) / (dx || 1e-6)), Math.abs((b.h / 2 + 6) / (dy || 1e-6)));
  return [cx + dx * k, cy + dy * k];
}

// A smooth curve through the points (Catmull-Rom), the way a hand rounds an outline.
export function curveThrough(pts: Pt[], closed: boolean): Pt[] {
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
