// Scenes: the tutor's doodles of who and what is involved, such as people, an
// AI, a document, an app or some data, placed on a grid like a diagram's,
// with speech bubbles, arrows between them and circles around what it points
// out. The model only names the things and their places; the pictures are
// drawn here, so a circle always lands on the thing it names, a crowd looks
// like many people and a pair like two, and nothing overlaps.
//
// Like the other figures, a scene can grow over a turn's phrases, so every
// thing is drawn with its own tag and lays out the same whatever comes later.

import type { Box } from "./ink.ts";
import { arrow, jitter, measureText, write, type Pen, type Rng } from "./handwriting.ts";
import type { Figure } from "./figure-schema.ts";
import { boxExit, curveThrough, dot, line, ring, roundBox, wrapTo, type Pt } from "./pen-shapes.ts";

type Scene = Extract<Figure, { kind: "scene" }>;
type Thing = Scene["things"][number];
type Part = (tag: string) => Rng;

// A cell's bands, in text sizes: a speech bubble, the picture, its caption,
// and a line for a note on a mark. Every cell is the same size, so a thing's
// place depends only on its row and column.
export const SCENE_CELL = { w: 6.2, bubble: 2, pic: 2.6, caption: 1.5, note: 1.1, gapX: 1.3, gapY: 0.6 };
const CELL_H = SCENE_CELL.bubble + SCENE_CELL.pic + SCENE_CELL.caption + SCENE_CELL.note;
export const SCENE_COLS = 4;
export const SCENE_ROWS = 3;

// The pen moves quickly for these little pictures, the way a doodle is dashed off.
function stroke(pen: Pen, pts: Pt[], rng: Rng, speed = 1.8, wobble = 0.5) {
  if (pts.length < 2) return;
  pen.lift(45);
  pen.draw(
    pts.map(([x, y]) => [x + jitter(rng, wobble), y + jitter(rng, wobble)] as Pt),
    speed,
  );
}

function arc(c: Pt, rx: number, ry: number, from: number, to: number, n = 20): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return [c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry] as Pt;
  });
}

// An oval drawn in one go, overshooting its start a little like a hand does.
function oval(pen: Pen, c: Pt, rx: number, ry: number, rng: Rng, speed = 1.6) {
  const start = -Math.PI / 2 + jitter(rng, 0.6);
  stroke(pen, arc(c, rx * (1 + jitter(rng, 0.03)), ry * (1 + jitter(rng, 0.03)), start, start + Math.PI * 2.08, 28), rng, speed, 0.6);
}

// What a picture covers, and where a speech bubble's tail should point.
type Drawn = { body: Box; speaker: Pt };

function stick(pen: Pen, cx: number, top: number, h: number, rng: Rng): Pt {
  const r = h * 0.12;
  ring(pen, [cx, top + r], r, rng);
  const neck = top + r * 2 + 1;
  const hip = top + h * 0.62;
  stroke(pen, [[cx, neck], [cx + jitter(rng, h * 0.02), hip]], rng, 2.2);
  stroke(pen, [[cx - h * 0.22, neck + h * 0.2], [cx, neck + h * 0.08], [cx + h * 0.22, neck + h * 0.2]], rng, 2.2);
  stroke(pen, [[cx - h * 0.18, top + h], [cx, hip], [cx + h * 0.18, top + h]], rng, 2.2);
  return [cx, top];
}

// A head and shoulders, for people in a crowd, with a finer pen when they are small.
function bust(pen: Pen, cx: number, top: number, s: number, rng: Rng) {
  const width = pen.width;
  pen.width = Math.min(width, Math.max(1.4, s * 0.075));
  const r = s * 0.19;
  ring(pen, [cx, top + r], r, rng);
  const sh = top + r * 2 + s * 0.06;
  stroke(pen, curveThrough([[cx - s * 0.4, top + s * 0.92], [cx - s * 0.3, sh + s * 0.1], [cx, sh], [cx + s * 0.3, sh + s * 0.1], [cx + s * 0.4, top + s * 0.92]], false), rng, 2.6, 0.3);
  pen.width = width;
}

// A few people side by side, or a crowd of heads and shoulders, so that how
// many there are shows at a glance.
function people(pen: Pen, n: number, area: Box, rng: Rng): Drawn {
  if (n <= 5) {
    const h = area.h * 0.96;
    const pitch = Math.min(area.w / n, h * 0.62);
    const x0 = area.x + area.w / 2 - (pitch * (n - 1)) / 2;
    let speaker: Pt = [area.x + area.w / 2, area.y];
    for (let i = 0; i < n; i++) {
      const hi = h * (1 - (i % 2) * 0.06 + jitter(rng, 0.02));
      speaker = stick(pen, x0 + i * pitch + jitter(rng, 1.5), area.y + h - hi, hi, rng);
    }
    const w = pitch * (n - 1) + h * 0.5;
    return { body: { x: x0 - h * 0.25, y: area.y, w, h }, speaker };
  }
  // as many to a row as makes each person biggest in the space there is
  const fit = (c: number) => Math.min(area.w / (c + 0.5), (area.h * 1.08) / (Math.ceil(n / c) * 0.78 + 0.25));
  let cols = 2;
  for (let c = 3; c <= n; c++) if (fit(c) > fit(cols)) cols = c;
  const rows = Math.ceil(n / cols);
  const s = fit(cols);
  const w = s * (cols + 0.5), h = s * (rows * 0.78 + 0.25);
  const x0 = area.x + (area.w - w) / 2 + s * 0.5, y0 = area.y + area.h - h;
  let left = n;
  let speaker: Pt = [area.x + area.w / 2, y0];
  for (let r = 0; r < rows; r++) {
    const k = Math.min(cols, left);
    left -= k;
    // back rows sit between the heads in front of them
    const shift = (r % 2) * s * 0.5 + ((cols - k) * s) / 2;
    for (let i = 0; i < k; i++) {
      const cx = x0 + shift + i * s + jitter(rng, s * 0.06);
      const top = y0 + r * s * 0.78 + jitter(rng, s * 0.05);
      bust(pen, cx, top, s * 0.92, rng);
      if (r === 0 && i === k - 1) speaker = [cx, top];
    }
  }
  return { body: { x: x0 - s * 0.5, y: y0, w, h }, speaker };
}

// The pictures, each drawn in a square box (people and dots spread wider).
function picture(pen: Pen, t: Thing, box: Box, wide: Box, rng: Rng): Drawn {
  const S = box.w;
  const P = (u: number, v: number): Pt => [box.x + u * S, box.y + v * S];
  const plain: Drawn = { body: box, speaker: P(0.5, 0.05) };
  const lines = (from: number, to: number, ys: number[]) => ys.forEach((v, i) => stroke(pen, [P(from, v), P(to - (i % 2) * 0.12, v)], rng, 2.4));
  switch (t.what) {
    case "person":
      return { body: { x: box.x + S * 0.25, y: box.y, w: S * 0.5, h: S }, speaker: stick(pen, box.x + S / 2, box.y + S * 0.02, S * 0.96, rng) };
    case "people":
      return people(pen, Math.max(2, Math.min(24, Math.round(t.count ?? 3))), wide, rng);
    case "robot": {
      stroke(pen, [P(0.5, 0.2), P(0.5, 0.07)], rng);
      ring(pen, P(0.5, 0.05), S * 0.04, rng);
      roundBox(pen, { x: box.x + S * 0.22, y: box.y + S * 0.2, w: S * 0.56, h: S * 0.42 }, rng);
      dot(pen, P(0.38, 0.38), S * 0.04);
      dot(pen, P(0.62, 0.38), S * 0.04);
      stroke(pen, [P(0.4, 0.51), P(0.6, 0.51)], rng, 2.4);
      roundBox(pen, { x: box.x + S * 0.3, y: box.y + S * 0.66, w: S * 0.4, h: S * 0.3 }, rng);
      stroke(pen, [P(0.3, 0.74), P(0.16, 0.86)], rng, 2.4);
      stroke(pen, [P(0.7, 0.74), P(0.84, 0.86)], rng, 2.4);
      return { body: box, speaker: P(0.5, 0.04) };
    }
    case "document": {
      const n = Math.max(1, Math.min(3, Math.round(t.count ?? 1)));
      for (let k = n - 1; k > 0; k--) {
        const d = k * 0.07;
        stroke(pen, [P(0.3 + d, 0.06 - d), P(0.86 + d, 0.06 - d), P(0.86 + d, 0.9 - d)], rng);
      }
      stroke(pen, [P(0.64, 0.06), P(0.2, 0.06), P(0.2, 0.95), P(0.8, 0.95), P(0.8, 0.22), P(0.64, 0.06), P(0.64, 0.22), P(0.8, 0.22)], rng, 1.8);
      lines(0.3, 0.7, [0.36, 0.5, 0.64, 0.78]);
      return plain;
    }
    case "screen": {
      roundBox(pen, { x: box.x + S * 0.04, y: box.y + S * 0.1, w: S * 0.92, h: S * 0.62 }, rng);
      stroke(pen, [P(0.04, 0.24), P(0.96, 0.24)], rng, 2.4);
      lines(0.14, 0.62, [0.38, 0.5, 0.6]);
      stroke(pen, [P(0.5, 0.72), P(0.5, 0.84)], rng, 2.4);
      stroke(pen, [P(0.32, 0.86), P(0.68, 0.86)], rng, 2.4);
      return plain;
    }
    case "chat": {
      roundBox(pen, { x: box.x, y: box.y + S * 0.08, w: S * 0.62, h: S * 0.3 }, rng);
      stroke(pen, [P(0.12, 0.38), P(0.08, 0.5), P(0.22, 0.38)], rng, 2.4);
      lines(0.1, 0.5, [0.23]);
      roundBox(pen, { x: box.x + S * 0.36, y: box.y + S * 0.56, w: S * 0.64, h: S * 0.3 }, rng);
      stroke(pen, [P(0.78, 0.86), P(0.9, 0.97), P(0.88, 0.86)], rng, 2.4);
      lines(0.46, 0.88, [0.71]);
      return plain;
    }
    case "database": {
      const c = P(0.5, 0.18), rx = S * 0.34, ry = S * 0.1;
      oval(pen, c, rx, ry, rng);
      stroke(pen, [P(0.16, 0.18), P(0.16, 0.84)], rng, 2.2);
      stroke(pen, arc(P(0.5, 0.84), rx, ry, Math.PI, 0, 16).reverse(), rng);
      stroke(pen, [P(0.84, 0.84), P(0.84, 0.18)], rng, 2.2);
      stroke(pen, arc(P(0.5, 0.51), rx, ry, Math.PI, 0, 16).reverse(), rng);
      return plain;
    }
    case "gear": {
      const c = P(0.5, 0.5), teeth = 8, pts: Pt[] = [];
      for (let i = 0; i <= teeth * 4; i++) {
        const a = (i / (teeth * 4)) * Math.PI * 2;
        const r = (i % 4 < 2 ? 0.44 : 0.33) * S;
        pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
      }
      stroke(pen, pts, rng, 1.6, 0.4);
      ring(pen, c, S * 0.13, rng);
      return plain;
    }
    case "idea": {
      stroke(pen, arc(P(0.5, 0.4), S * 0.25, S * 0.25, Math.PI * 0.72, Math.PI * 2.28, 24), rng);
      stroke(pen, [P(0.38, 0.6), P(0.38, 0.76), P(0.62, 0.76), P(0.62, 0.6)], rng, 2.2);
      stroke(pen, [P(0.41, 0.83), P(0.59, 0.83)], rng, 2.4);
      for (const a of [-150, -115, -90, -65, -30]) {
        const r = (a * Math.PI) / 180;
        stroke(pen, [[P(0.5, 0.4)[0] + Math.cos(r) * S * 0.33, P(0.5, 0.4)[1] + Math.sin(r) * S * 0.33], [P(0.5, 0.4)[0] + Math.cos(r) * S * 0.44, P(0.5, 0.4)[1] + Math.sin(r) * S * 0.44]], rng, 2.6, 0.3);
      }
      return plain;
    }
    case "magnifier": {
      ring(pen, P(0.42, 0.42), S * 0.27, rng);
      const w = pen.width;
      pen.width = w * 1.8;
      stroke(pen, [P(0.62, 0.62), P(0.9, 0.9)], rng, 2);
      pen.width = w;
      return plain;
    }
    case "warning": {
      stroke(pen, [P(0.5, 0.08), P(0.95, 0.88), P(0.05, 0.88), P(0.5, 0.08), P(0.53, 0.13)], rng, 1.8);
      const w = pen.width;
      pen.width = w * 1.3;
      stroke(pen, [P(0.5, 0.34), P(0.5, 0.62)], rng, 2);
      pen.width = w;
      dot(pen, P(0.5, 0.75), S * 0.035);
      return plain;
    }
    case "check":
      stroke(pen, [P(0.16, 0.54), P(0.4, 0.8), P(0.86, 0.18)], rng, 1.8);
      return plain;
    case "cross":
      stroke(pen, [P(0.2, 0.2), P(0.8, 0.8)], rng, 1.8);
      stroke(pen, [P(0.8, 0.2), P(0.2, 0.8)], rng, 1.8);
      return plain;
    case "cloud": {
      // the outline of a few overlapping puffs on a flat bottom
      const puffs: [number, number, number][] = [[0.2, 0.6, 0.16], [0.4, 0.4, 0.23], [0.64, 0.36, 0.21], [0.82, 0.58, 0.16]];
      const c = P(0.5, 0.68);
      const pts: Pt[] = [];
      for (let i = 0; i <= 72; i++) {
        const a = Math.PI + (i / 72) * Math.PI;
        let far = 0;
        for (const [u, v, r] of puffs) {
          // where the ray from the middle leaves this puff
          const [px, py] = P(u, v);
          const dx = Math.cos(a), dy = Math.sin(a), ox = c[0] - px, oy = c[1] - py;
          const b = ox * dx + oy * dy, disc = b * b - (ox * ox + oy * oy - (r * S) ** 2);
          if (disc >= 0) far = Math.max(far, -b + Math.sqrt(disc));
        }
        if (far) pts.push([c[0] + Math.cos(a) * far, c[1] + Math.sin(a) * far]);
      }
      pts.push(pts[0]);
      stroke(pen, pts, rng, 1.6, 0.3);
      return { body: { x: box.x, y: box.y + S * 0.2, w: S, h: S * 0.56 }, speaker: P(0.5, 0.22) };
    }
    case "globe": {
      ring(pen, P(0.5, 0.5), S * 0.42, rng);
      oval(pen, P(0.5, 0.5), S * 0.17, S * 0.42, rng, 2);
      stroke(pen, [P(0.08, 0.5), P(0.92, 0.5)], rng, 2.2);
      stroke(pen, arc(P(0.5, 0.06), S * 0.36, S * 0.2, Math.PI * 0.82, Math.PI * 0.18, 12), rng, 2.2);
      stroke(pen, arc(P(0.5, 0.94), S * 0.36, S * 0.2, -Math.PI * 0.82, -Math.PI * 0.18, 12), rng, 2.2);
      return plain;
    }
    case "chart": {
      stroke(pen, [P(0.1, 0.06), P(0.1, 0.9), P(0.95, 0.9)], rng, 1.8);
      [0.3, 0.52, 0.76].forEach((hgt, i) => {
        const u = 0.22 + i * 0.25;
        stroke(pen, [P(u, 0.9), P(u, 0.9 - hgt), P(u + 0.14, 0.9 - hgt), P(u + 0.14, 0.9)], rng, 2);
      });
      return plain;
    }
    case "clock": {
      ring(pen, P(0.5, 0.5), S * 0.42, rng);
      for (const [u, v, u2, v2] of [[0.5, 0.11, 0.5, 0.17], [0.89, 0.5, 0.83, 0.5], [0.5, 0.89, 0.5, 0.83], [0.11, 0.5, 0.17, 0.5]]) stroke(pen, [P(u, v), P(u2, v2)], rng, 2.6, 0.2);
      stroke(pen, [P(0.5, 0.26), P(0.5, 0.5), P(0.68, 0.6)], rng, 2);
      return plain;
    }
    case "brain": {
      // two lobed halves seen from above, with a few folds
      const pts: Pt[] = [];
      for (let i = 0; i <= 18; i++) {
        const a = Math.PI + (i / 18) * Math.PI * 2;
        const r = (i % 2 ? 0.37 : 0.44) * S;
        pts.push([P(0.5, 0.5)[0] + Math.cos(a) * r * 1.05, P(0.5, 0.5)[1] + Math.sin(a) * r * 0.86]);
      }
      stroke(pen, curveThrough(pts, true), rng, 1.6, 0.3);
      stroke(pen, curveThrough([P(0.5, 0.16), P(0.47, 0.34), P(0.53, 0.5), P(0.47, 0.66), P(0.5, 0.84)], false), rng, 2.2);
      for (const [a, b, c] of [[[0.16, 0.42], [0.26, 0.32], [0.36, 0.42]], [[0.22, 0.62], [0.32, 0.54], [0.4, 0.66]], [[0.62, 0.36], [0.72, 0.28], [0.8, 0.4]], [[0.6, 0.6], [0.7, 0.68], [0.82, 0.58]]] as [number, number][][])
        stroke(pen, curveThrough([P(a[0], a[1]), P(b[0], b[1]), P(c[0], c[1])], false), rng, 2.4, 0.3);
      return plain;
    }
    case "network": {
      const nodes: Pt[] = [P(0.14, 0.3), P(0.46, 0.12), P(0.84, 0.26), P(0.3, 0.74), P(0.6, 0.52), P(0.86, 0.82)];
      const r = S * 0.07;
      for (const [a, b] of [[0, 1], [1, 2], [0, 3], [1, 4], [2, 4], [3, 4], [4, 5], [3, 5]]) {
        const [p, q] = [nodes[a], nodes[b]];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ux = (q[0] - p[0]) / d, uy = (q[1] - p[1]) / d;
        stroke(pen, [[p[0] + ux * r, p[1] + uy * r], [q[0] - ux * r, q[1] - uy * r]], rng, 2.4, 0.3);
      }
      nodes.forEach((n) => ring(pen, n, r, rng));
      return plain;
    }
    case "dots": {
      const n = Math.max(3, Math.min(24, Math.round(t.count ?? 10)));
      const c: Pt = [wide.x + wide.w / 2, wide.y + wide.h / 2];
      const rx = Math.min(wide.w, S * 1.6) * 0.42, ry = wide.h * 0.4;
      for (let i = 0; i < n; i++) {
        // spread like a sunflower's seeds, so the cluster fills evenly
        const a = i * 2.39996 + jitter(rng, 0.3), f = Math.sqrt((i + 0.5) / n);
        dot(pen, [c[0] + Math.cos(a) * rx * f, c[1] + Math.sin(a) * ry * f], Math.max(2.2, S * 0.035));
      }
      return { body: { x: c[0] - rx, y: c[1] - ry, w: rx * 2, h: ry * 2 }, speaker: [c[0], c[1] - ry] };
    }
    case "book": {
      stroke(pen, curveThrough([P(0.5, 0.26), P(0.3, 0.18), P(0.04, 0.22)], false).concat([P(0.04, 0.82)]).concat(curveThrough([P(0.04, 0.82), P(0.3, 0.78), P(0.5, 0.86)], false)), rng, 1.8);
      stroke(pen, curveThrough([P(0.5, 0.26), P(0.7, 0.18), P(0.96, 0.22)], false).concat([P(0.96, 0.82)]).concat(curveThrough([P(0.96, 0.82), P(0.7, 0.78), P(0.5, 0.86)], false)), rng, 1.8);
      stroke(pen, [P(0.5, 0.26), P(0.5, 0.86)], rng, 2.2);
      lines(0.12, 0.42, [0.4, 0.54]);
      lines(0.58, 0.88, [0.4, 0.54]);
      return plain;
    }
    case "money":
      ring(pen, P(0.5, 0.5), S * 0.42, rng);
      write(pen, "$", box.x + S / 2 - measureText("$", S * 0.5) / 2, box.y + S * 0.68, S * 0.5, rng);
      return plain;
    case "flask":
      stroke(pen, [P(0.42, 0.08), P(0.42, 0.38), P(0.12, 0.9), P(0.88, 0.9), P(0.58, 0.38), P(0.58, 0.08)], rng, 1.8);
      stroke(pen, [P(0.36, 0.08), P(0.64, 0.08)], rng, 2.4);
      stroke(pen, [P(0.25, 0.68), P(0.75, 0.68)], rng, 2.4);
      ring(pen, P(0.46, 0.8), S * 0.035, rng);
      ring(pen, P(0.6, 0.76), S * 0.025, rng);
      return plain;
    case "lock":
      stroke(pen, arc(P(0.5, 0.36), S * 0.2, S * 0.24, Math.PI, Math.PI * 2, 14).concat([P(0.7, 0.46)]), rng, 2);
      stroke(pen, [P(0.3, 0.46), P(0.3, 0.36)], rng, 2.4);
      roundBox(pen, { x: box.x + S * 0.18, y: box.y + S * 0.46, w: S * 0.64, h: S * 0.46 }, rng);
      dot(pen, P(0.5, 0.64), S * 0.04);
      stroke(pen, [P(0.5, 0.66), P(0.5, 0.78)], rng, 2.6, 0.2);
      return plain;
    case "heart":
      stroke(pen, curveThrough([P(0.5, 0.9), P(0.2, 0.62), P(0.08, 0.36), P(0.24, 0.14), P(0.42, 0.18), P(0.5, 0.32)], false).concat(curveThrough([P(0.5, 0.32), P(0.58, 0.18), P(0.76, 0.14), P(0.92, 0.36), P(0.8, 0.62), P(0.5, 0.9)], false)), rng, 1.6, 0.3);
      return plain;
    case "cycle": {
      const c = P(0.5, 0.5), r = S * 0.36;
      for (const start of [-0.15, Math.PI - 0.15]) {
        const pts = arc(c, r, r, start + 0.5, start + Math.PI - 0.15, 14);
        stroke(pen, pts, rng, 1.8, 0.3);
        const tip = pts[pts.length - 1], prev = pts[pts.length - 3];
        const ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
        stroke(pen, [[tip[0] - S * 0.12 * Math.cos(ang - 0.5), tip[1] - S * 0.12 * Math.sin(ang - 0.5)], tip, [tip[0] - S * 0.12 * Math.cos(ang + 0.5), tip[1] - S * 0.12 * Math.sin(ang + 0.5)]], rng, 1.6, 0.2);
      }
      return plain;
    }
    case "eye":
      stroke(pen, curveThrough([P(0.04, 0.5), P(0.5, 0.2), P(0.96, 0.5)], false), rng, 1.8);
      stroke(pen, curveThrough([P(0.04, 0.5), P(0.5, 0.8), P(0.96, 0.5)], false), rng, 1.8);
      ring(pen, P(0.5, 0.5), S * 0.15, rng);
      dot(pen, P(0.5, 0.5), S * 0.05);
      return { body: { x: box.x, y: box.y + S * 0.2, w: S, h: S * 0.6 }, speaker: P(0.5, 0.22) };
    case "target":
      ring(pen, P(0.5, 0.5), S * 0.42, rng);
      ring(pen, P(0.5, 0.5), S * 0.27, rng);
      dot(pen, P(0.5, 0.5), S * 0.07);
      return plain;
  }
}

// A speech bubble above a thing, its tail pointing at the one speaking.
function bubble(pen: Pen, text: string, speaker: Pt, cell: Box, top: number, ts: number, rng: Rng): Box {
  const rows = wrapTo(text, ts, cell.w * 0.78).slice(0, 2);
  const w = Math.max(ts * 1.6, ...rows.map((r) => measureText(r, ts))) + ts * 1.1;
  const h = rows.length * ts * 1.3 + ts * 0.55;
  const x = Math.max(cell.x - ts * 0.6, Math.min(speaker[0] - w * 0.3, cell.x + cell.w - w + ts * 0.6));
  const y = Math.max(top - h - ts * 0.35, cell.y);
  const b = { x, y, w, h };
  roundBox(pen, b, rng, 2);
  const tx = Math.max(x + 8, Math.min(x + w - 14, speaker[0] + ts * 0.3));
  stroke(pen, [[tx - 4, y + h], [speaker[0] + ts * 0.15, speaker[1] - ts * 0.25], [tx + 7, y + h]], rng, 2.2, 0.3);
  rows.forEach((r, i) => write(pen, r, x + (w - measureText(r, ts)) / 2, y + ts * 1.15 + i * ts * 1.3, ts, rng));
  return b;
}

const unite = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export function scene(pen: Pen, fig: Scene, x: number, y: number, size: number, part: Part) {
  const ts = Math.max(14, size * 0.52);
  const ls = Math.max(12, size * 0.46);
  const cw = size * SCENE_CELL.w;
  const pitchX = cw + size * SCENE_CELL.gapX, pitchY = size * (CELL_H + SCENE_CELL.gapY);
  let top = y;
  if (fig.title) {
    const rng = part("title");
    write(pen, fig.title, x, top + ts * 1.1, ts * 1.1, rng);
    top += ts * 1.9;
  }
  type Placed = { t: Thing; row: number; col: number; cell: Box; pic: Box; body: Box; all: Box; caption: Box | null };
  const placed = new Map<string, Placed>();
  const taken = new Set<string>();
  for (const t of fig.things.slice(0, 12)) {
    if (!t.id || placed.has(t.id)) continue;
    const row = Math.max(0, Math.min(SCENE_ROWS - 1, Math.round(Number.isFinite(t.row) ? t.row : 0)));
    let col = Math.max(0, Math.min(SCENE_COLS - 1, Math.round(Number.isFinite(t.col) ? t.col : 0)));
    // two things in one cell: the later one moves along to the next free cell
    while (taken.has(`${row},${col}`) && col < SCENE_COLS + 2) col++;
    taken.add(`${row},${col}`);
    const cell = { x: x + col * pitchX, y: top + row * pitchY, w: cw, h: size * CELL_H };
    const S = size * SCENE_CELL.pic;
    const picTop = cell.y + size * SCENE_CELL.bubble;
    const pic = { x: cell.x + (cw - S) / 2, y: picTop, w: S, h: S };
    const wide = { x: cell.x + cw * 0.04, y: picTop, w: cw * 0.92, h: S };
    const rng = part(`thing:${t.id}`);
    pen.lift(140);
    const drawn = picture(pen, t, pic, wide, rng);
    let all = drawn.body;
    let caption: Box | null = null;
    if (t.caption?.trim()) {
      const rows = wrapTo(t.caption.trim().slice(0, 40), ts, cw).slice(0, 2);
      pen.lift(100);
      rows.forEach((r, i) => write(pen, r, cell.x + (cw - measureText(r, ts)) / 2, picTop + S + ts * 1.25 + i * ts * 1.25, ts, rng));
      const w = Math.max(...rows.map((r) => measureText(r, ts)));
      caption = { x: cell.x + (cw - w) / 2, y: picTop + S + ts * 0.3, w, h: rows.length * ts * 1.25 };
    }
    if (t.says?.trim()) {
      pen.lift(150);
      all = unite(all, bubble(pen, t.says.trim().slice(0, 28), drawn.speaker, cell, Math.min(drawn.body.y, drawn.speaker[1]), ts, rng));
    }
    placed.set(t.id, { t, row, col, cell, pic, body: drawn.body, all, caption });
  }

  for (const m of fig.marks.slice(0, 4)) {
    const p = placed.get(m.on);
    if (!p) continue;
    const rng = part(`mark:${m.on}:${m.kind}`);
    // a circle goes round the whole thing, its bubble and its caption too
    const b = p.caption ? unite(p.all, p.caption) : p.all;
    pen.lift(160);
    let below = b.y + b.h;
    if (m.kind === "circle") {
      const ry = (b.h / 2) * 1.28 + ts * 0.2;
      oval(pen, [b.x + b.w / 2, b.y + b.h / 2], (b.w / 2) * 1.3 + ts * 0.2, ry, rng, 1.4);
      below = b.y + b.h / 2 + ry;
    } else if (m.kind === "cross") {
      stroke(pen, [[p.body.x, p.body.y], [p.body.x + p.body.w, p.body.y + p.body.h]], rng, 1.6);
      stroke(pen, [[p.body.x + p.body.w, p.body.y], [p.body.x, p.body.y + p.body.h]], rng, 1.6);
    } else stroke(pen, [[p.body.x + p.body.w + ts * 0.2, p.body.y + ts * 0.5], [p.body.x + p.body.w + ts * 0.6, p.body.y + ts * 1.1], [p.body.x + p.body.w + ts * 1.4, p.body.y - ts * 0.4]], rng, 1.6);
    if (m.note?.trim()) {
      // the note goes just under what it marks
      const text = m.note.trim().slice(0, 24);
      pen.lift(120);
      write(pen, text, b.x + (b.w - measureText(text, ls)) / 2, below + ls * 1.15, ls, rng);
    }
  }

  for (const e of fig.arrows.slice(0, 10)) {
    const a = placed.get(e.from), b = placed.get(e.to);
    if (!a || !b || a === b) continue;
    const rng = part(`arrow:${e.from}>${e.to}`);
    let p0: Pt, p1: Pt;
    let bend = jitter(rng, 0.06);
    if (a.row === b.row) {
      // along a row the arrow runs at the pictures' height, clear of bubbles
      // and captions, sagging a little so its label above stays clear of it
      const dir = Math.sign(b.col - a.col);
      const ya = a.body.y + a.body.h / 2, yb = b.body.y + b.body.h / 2;
      p0 = [dir > 0 ? a.body.x + a.body.w + 8 : a.body.x - 8, ya];
      p1 = [dir > 0 ? b.body.x - 8 : b.body.x + b.body.w + 8, yb];
      bend = -dir * (0.05 + rng() * 0.04);
      if (Math.abs(b.col - a.col) > 1) {
        // past the things between them: arc over their heads
        p0 = [a.body.x + a.body.w / 2 + dir * a.body.w * 0.3, a.body.y - 6];
        p1 = [b.body.x + b.body.w / 2 - dir * b.body.w * 0.3, b.body.y - 6];
        bend = dir * 0.3;
      }
    } else {
      const box = (q: Placed) => (q.caption ? unite(q.all, q.caption) : q.all);
      const ca: Pt = [a.cell.x + a.cell.w / 2, a.pic.y + a.pic.h / 2], cb: Pt = [b.cell.x + b.cell.w / 2, b.pic.y + b.pic.h / 2];
      p0 = boxExit(box(a), cb);
      p1 = boxExit(box(b), ca);
    }
    pen.lift(140);
    arrow(pen, p0, p1, rng, bend);
    if (e.label?.trim()) {
      const text = e.label.trim().slice(0, 24);
      const w = measureText(text, ls);
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      const across = Math.abs(p1[0] - p0[0]) > Math.abs(p1[1] - p0[1]);
      const lift = Math.abs(bend) > 0.1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.18 : 0;
      write(pen, text, across ? mx - w / 2 : mx + 10, across ? my - ls * 0.7 - lift : my + ls * 0.4, ls, rng);
    }
  }
}

// The space a scene may grow into: the rest of its rows, and one more row below.
export function sceneRoom(fig: Scene, size: number): { w: number; h: number } {
  const ts = Math.max(14, size * 0.52);
  const rows = Math.min(SCENE_ROWS, Math.max(0, ...fig.things.map((t) => t.row)) + 2);
  const head = fig.title ? ts * 1.9 : 0;
  return { w: SCENE_COLS * size * (SCENE_CELL.w + SCENE_CELL.gapX), h: head + rows * size * (CELL_H + SCENE_CELL.gapY) };
}
