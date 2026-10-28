// Turns what the tutor wants to do on the page (circle this, arrow to there,
// write that) into timed pen strokes, so the ink appears the way a person's
// pen moves: one stroke at a time, at hand speed, never quite perfect.

import type { Box, InkLine } from "./ink.ts";
import { spanBox, unionBox } from "./ink.ts";
import hand from "./tutor-hand/kalam.json" with { type: "json" };
import { drawFigure, extendFigure, figureRoom, type FigureLayout } from "./figures.ts";
import type { Figure } from "./figure-schema.ts";

// `w` is the pen's width for the stroke, thinner for small writing.
export type PenStroke = { points: [number, number][]; start: number; end: number; w?: number };
// `parts` are the boxes of what was written or drawn (not the arrows between),
// so later turns can tuck their own work into the gaps.
// `figure` is the whole of the figure this plan drew or added to, so far.
export type PenPlan = { strokes: PenStroke[]; duration: number; box: Box | null; parts?: Box[]; figure?: Box };

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

// How wide the pen draws for writing of a given size: a ballpoint, a little
// bolder than the font it was traced from so small notes stay readable.
export const penWidth = (size: number) => Math.max(1.9, Math.min(3.8, size * 0.115));

// ---------- a pen that keeps time ----------
export class Pen {
  strokes: (PenStroke & { tag?: string })[] = [];
  t = 0;
  box: Box | null = null;
  speed: number;
  width = 3.2;
  // Which part of a figure the strokes belong to, so a figure can be grown part by part.
  tag: string | undefined;
  constructor(speed: number) {
    this.speed = speed;
  }

  draw(points: [number, number][], speedFactor = 1) {
    if (points.length < 2) return;
    const pts = resample(points, 2.5);
    const ms = Math.max(60, length(pts) / (this.speed * speedFactor));
    this.strokes.push({ points: pts, start: this.t, end: this.t + ms, w: this.width, ...(this.tag != null ? { tag: this.tag } : {}) });
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

// A bowed line with a quick two-winged head drawn in one motion. `bend` sets
// the bow (a fraction of the length, signed); otherwise it's a light random one.
export function arrow(pen: Pen, from: [number, number], to: [number, number], rng: Rng, bend?: number) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d < 12) return;
  const bow = bend != null ? -d * bend : (rng() < 0.5 ? -1 : 1) * d * (0.12 + rng() * 0.08);
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
const ALIAS: Record<string, string> = {
  "‐": "-", "‑": "-", "∙": "·", "⋅": "·", "∗": "*", "⟶": "→", "⟹": "⇒", "⟺": "⇔", "≡": "=", "∼": "~", "≅": "≈",
  "ϵ": "ε", "∘": "°", "⊆": "⊂", "ℓ": "l", "ℝ": "R", "ℕ": "N", "ℤ": "Z", "ℚ": "Q", "ℂ": "C", "⟨": "<", "⟩": ">",
  "∣": "|", "∥": "|", "⁄": "/", "∕": "/", "⋯": "…", "✓": "√", "\u00a0": " ",
};
// Anything else falls back to its plain letter (é to e), or to a gap.
const glyph = (ch: string) =>
  font.glyphs[ch] ?? font.glyphs[ALIAS[ch] ?? ""] ?? font.glyphs[ch.normalize("NFKD")[0] ?? ""] ?? font.glyphs[" "];
// Small raised and lowered letters (Qᵀ, xᵢ) the hand has no glyph for: the
// plain letter, written small, above or below the line.
const SUPERS = "ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁺⁻⁼⁽⁾";
const SUBS = "ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₊₋₌₍₎";
function small(ch: string): { g: Font["glyphs"][string]; k: number; dy: number } | null {
  if (font.glyphs[ch]) return null;
  const up = SUPERS.includes(ch), down = !up && SUBS.includes(ch);
  if (!up && !down) return null;
  const plain = ch.normalize("NFKD");
  const g = font.glyphs[plain] ?? font.glyphs[plain === "−" ? "-" : ""];
  return g ? { g, k: 0.6, dy: up ? font.capHeight * 0.5 : -font.capHeight * 0.18 } : null;
}
// How far the pen moves on after a character, in font units.
function advance(ch: string): number {
  const mini = small(ch);
  if (mini) return mini.g.w * mini.k + 8;
  // what's under a root sign starts clear of its long arm
  return ch === "√" ? ROOT_W : glyph(ch).w;
}

// People write a little tighter than the font: letters closer, word gaps
// about the width of a narrow letter (and tighter still in "5x + 5").
const TRACK = 0.93;
const SPACE = 0.62;

// What a root sign is the root of: the number, letters or bracket after it.
function radicand(chars: string[], from: number): string {
  if (chars[from] === "(") {
    let depth = 0;
    for (let j = from; j < chars.length; j++) {
      if (chars[j] === "(") depth++;
      else if (chars[j] === ")" && --depth === 0) return chars.slice(from, j + 1).join("");
    }
    return chars.slice(from).join("");
  }
  let j = from;
  while (j < chars.length && /[\p{L}\p{N}.²³⁴ⁿ′]/u.test(chars[j])) j++;
  return chars.slice(from, j).join("");
}
// A glyph stroke [x0, y0, x1, y1, ...] run the other way.
function reversePoints(flat: number[]): number[] {
  const out: number[] = [];
  for (let k = flat.length - 2; k >= 0; k -= 2) out.push(flat[k], flat[k + 1]);
  return out;
}
// The top of the root sign's long arm, and how far along it ends, in font units.
const ROOT_TOP = Math.max(...(font.glyphs["√"]?.s ?? [[0, 0]]).flatMap((st) => st.filter((_, k) => k % 2 === 1)));
const ROOT_W = Math.max(font.glyphs["√"]?.w ?? 0, ...(font.glyphs["√"]?.s ?? [[0, 0]]).flatMap((st) => st.filter((_, k) => k % 2 === 0)).map((x) => x + 16));

export function measureText(text: string, size: number): number {
  const scale = size / font.capHeight;
  let w = 0;
  for (const ch of text) w += advance(ch) * scale * (ch === " " ? SPACE : TRACK);
  return w;
}

// Writes glyph by glyph the way a hand does: the baseline wanders, letters
// vary a little in size, slope and spacing, each word leans its own way, and
// the pen travels in the air between strokes, pausing longer between words.
export function write(pen: Pen, text: string, x: number, baseline: number, size: number, rng: Rng) {
  const scale = size / font.capHeight;
  const width = pen.width;
  pen.width = penWidth(size);
  let cursor = x;
  let drift = 0;
  let lean = 0.1 + jitter(rng, 0.04);
  let last: [number, number] | null = null;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const g = glyph(ch);
    if (ch === " ") {
      lean = 0.1 + jitter(rng, 0.04);
      pen.lift(70 + rng() * 60);
      cursor += g.w * scale * SPACE * (1 + jitter(rng, 0.15));
      continue;
    }
    drift = drift * 0.75 + jitter(rng, size * 0.03);
    const mini = small(ch);
    const s = scale * (1 + jitter(rng, 0.045)) * (mini?.k ?? 1);
    const rot = jitter(rng, 0.03);
    const shear = lean + jitter(rng, 0.03);
    // A root sign carries on as a bar over what it is the root of, and
    // stretches up to clear tall letters and digits.
    const under = ch === "√" ? radicand(chars, i + 1) : "";
    const tall = under && /[^acemnorsuvwxz]/.test(under) ? (font.capHeight * 1.14) / ROOT_TOP : 1;
    for (const traced of (mini?.g ?? g).s) {
      // a root sign is written from its little tick on the left
      const stroke = ch === "√" && traced[0] > traced[traced.length - 2] ? reversePoints(traced) : traced;
      const pts: [number, number][] = [];
      for (let k = 0; k < stroke.length; k += 2) {
        const gy = stroke[k + 1] * s * tall + (mini ? mini.dy * scale : 0);
        const gx = stroke[k] * s + gy * shear; // y is up here: leaning forward moves the top right
        pts.push([cursor + gx * Math.cos(rot) + gy * Math.sin(rot), baseline + drift + gx * Math.sin(rot) - gy * Math.cos(rot)]);
      }
      // A full stop or decimal point is too small to show at the pen's width; dab it instead.
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < size * 0.16) {
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2, r = Math.max(1, size * 0.04);
        pts.length = 0;
        for (let i = 0; i <= 10; i++) pts.push([cx + Math.cos(i * 1.3) * r * (1 - i / 14), cy + Math.sin(i * 1.3) * r * (1 - i / 14)]);
      }
      if (under) {
        // the bar, in the same movement, from the top of the long arm
        const [tx, ty] = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
        const end = cursor + advance(ch) * scale * TRACK + measureText(under, size) + size * 0.08;
        const tilt = jitter(rng, size * 0.04);
        pts.splice(pts.findIndex((p) => p[0] === tx && p[1] === ty) + 1);
        for (let k = 1; k <= 6; k++) pts.push([tx + ((end - tx) * k) / 6, ty + (tilt * k) / 6]);
      }
      // the pen's trip through the air to where this stroke starts
      if (last) pen.lift(25 + Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) / (pen.speed * 1.6) + rng() * 20);
      pen.draw(pts);
      last = pts[pts.length - 1];
    }
    cursor += advance(ch) * scale * TRACK * (1 + jitter(rng, 0.04));
  }
  pen.lift(60);
  pen.width = width;
}

// ---------- a whole turn ----------
export type Mark = { boxes: Box[]; kind: "highlight" | "underline"; note: string | null; edge: number };

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
  marks?: Mark[];
  // Writing size, when it shouldn't follow the student's handwriting (beside a paper's small print).
  size?: number;
};

// What the pen does during one spoken phrase.
export type BeatInk = {
  annotations?: Annotation[];
  marks?: Mark[];
  write?: string[];
  figures?: Figure[];
  // The first figure adds its parts to the figure drawn last in this turn, instead of starting a new one.
  continueFigure?: boolean;
};

// A figure being built up over a turn: where it is and what of it is drawn.
type Build = { fig: Figure; x: number; y: number; size: number; seed: number; layout: FigureLayout; drawn: Set<string>; part: Box };

// Plans a turn's ink phrase by phrase. Each phrase's ink is timed from zero
// so it can start the moment that phrase is heard; placement carries over,
// so nothing a later phrase writes lands on an earlier one.
export class TurnPlanner {
  readonly size: number;
  // Everything this turn wrote or drew, for later turns to keep clear of.
  readonly parts: Box[] = [];
  private rng: Rng;
  private occupied: Box[];
  // Space held for figures that may still grow this turn.
  private room: Box[] = [];
  private lastTarget: { box: Box; line: InkLine; ellipse: Ellipse | null } | null = null;
  private build: Build | null = null;
  private lines: InkLine[];
  private opts: PlanOptions;

  constructor(lines: InkLine[], seed: number, opts: PlanOptions = {}) {
    this.lines = lines;
    this.opts = opts;
    this.rng = seeded(seed);
    const lineH = lines.length ? lines.reduce((s, l) => s + l.box.h, 0) / lines.length : 40;
    this.size = opts.size ?? Math.max(20, Math.min(40, lineH * 0.62));
    this.occupied = lines.map((l) => l.box);
  }

  private taken() {
    return [...this.occupied, ...this.room, ...(this.opts.avoid ?? [])];
  }

  // The first free spot at least `h` tall at or below `from`, for something `w` wide at `x`.
  private below(x: number, from: number, w: number, h: number) {
    const taken = this.taken();
    let y = from;
    for (let pass = 0; pass < 60; pass++) {
      const hit = taken.find((o) => o.x < x + w + 12 && o.x + o.w + 12 > x && o.y < y + h + 12 && o.y + o.h + 12 > y);
      if (!hit) break;
      y = hit.y + hit.h + 16;
    }
    return y;
  }

  // The free spot nearest `want`, looking both down and up.
  private nearest(x: number, want: number, w: number, h: number) {
    const taken = this.taken();
    const down = this.below(x, want, w, h);
    let up = want;
    for (let pass = 0; pass < 60; pass++) {
      const hit = taken.find((o) => o.x < x + w + 12 && o.x + o.w + 12 > x && o.y < up + h + 12 && o.y + o.h + 12 > up);
      if (!hit) break;
      up = hit.y - h - 16;
    }
    return want - up < down - want ? up : down;
  }

  // Where the top left of something `w` by `h` goes: in paper mode the lane
  // nearest the paper with room on screen or just below it (the view follows
  // the pen there), otherwise below everything on the page.
  private spot(w: number, h: number): { x: number; y: number } {
    const col = this.opts.column;
    if (col) {
      const lanes = [0, 1, 2, 3].map((k) => col.x + this.size * 21 + 40 + k * 720);
      const reach = col.bottom == null ? Infinity : col.bottom + (col.bottom - col.top) * 0.75;
      let best = { x: lanes[0], y: this.below(lanes[0], col.top, w, h) };
      for (const x of lanes) {
        const y = this.below(x, col.top, w, h);
        if (y + h <= reach) return { x, y };
        if (y < best.y) best = { x, y };
      }
      return best;
    }
    const taken = this.taken();
    const left = this.lines.length ? Math.min(...this.lines.map((l) => l.box.x)) : (this.opts.origin?.x ?? 0) + 60;
    const bottom = taken.length ? Math.max(...taken.map((b) => b.y + b.h)) : (this.opts.origin?.y ?? 0) + 80;
    return { x: left + jitter(this.rng, 6), y: bottom + this.size * 1.1 };
  }

  plan(ink: BeatInk): PenPlan {
    const rng = this.rng;
    const size = this.size;
    const pen = new Pen(size * 0.045);
    const before = this.parts.length;
    const lines = this.lines;
    const occupied = this.occupied;
    let figure: Box | undefined;

    for (const a of ink.annotations ?? []) {
      const line = lines.find((l) => l.id === a.line_id) ?? lines.at(-1);
      if (!line) continue;
      const box = a.from_token == null ? line.box : spanBox(line, a.from_token, a.to_token ?? a.from_token);
      pen.width = penWidth(size);

      if (a.kind === "note") {
        if (!a.text?.trim()) continue;
        const last = this.lastTarget;
        const anchor = last && (last.line.id === line.id || a.line_id === last.line.id) ? last : { box, line, ellipse: null };
        const width = measureText(a.text, size);
        const spot = placeNote(a.placement ?? "right", anchor.box, anchor.line.box, width, size, this.taken());
        if (a.arrow) {
          const target: [number, number] =
            spot.side === "right" ? [spot.x - 14, spot.baseline - size * 0.4] : [spot.x + Math.min(width, 40) / 2, spot.side === "above" ? spot.baseline + 8 : spot.baseline - size - 6];
          const startPt = anchor.ellipse ? ellipseEdgeToward(anchor.ellipse, target) : boxEdgeToward(anchor.box, target);
          pen.lift(pen.t ? 160 : 0);
          arrow(pen, startPt, target, rng);
        }
        pen.lift(pen.t ? 200 : 0);
        write(pen, a.text.trim(), spot.x, spot.baseline, size, rng);
        const noteBox = { x: spot.x, y: spot.baseline - size, w: width, h: size * 1.4 };
        occupied.push(noteBox);
        this.parts.push(noteBox);
        continue;
      }

      pen.lift(pen.t ? 220 : 0);
      let ellipse: Ellipse | null = null;
      if (a.kind === "circle") ellipse = circle(pen, box, rng);
      else if (a.kind === "underline") underline(pen, box, rng);
      else if (a.kind === "strike") strike(pen, box, rng);
      else if (a.kind === "check") check(pen, box, rng);
      else if (a.kind === "question") write(pen, "?", box.x + box.w + 16, box.y + box.h * 0.85, Math.max(size, box.h * 0.8), rng);
      this.lastTarget = { box, line, ellipse };
    }

    // Margin notes, in a lane beside the paper, as close as they can get to their passage.
    const col = this.opts.column;
    const lane = size * 21;
    for (const m of ink.marks ?? []) {
      if (!m.boxes.length) continue;
      pen.lift(pen.t ? 200 : 0);
      if (!m.note?.trim() || !col) continue;
      const u = m.boxes.reduce(unionBox);
      const rows = wrapWords(m.note.trim(), size, lane);
      const width = Math.max(...rows.map((r) => measureText(r, size)));
      const h = size * 1.5 * rows.length;
      const top = this.nearest(col.x, u.y + u.h / 2 - size * 0.8, width, h);
      const baseline = top + size * 1.05;
      pen.width = penWidth(size);
      pen.lift(160);
      arrow(pen, [m.edge + 6, u.y + u.h / 2], [col.x - 12, baseline - size * 0.4], rng);
      pen.lift(120);
      rows.forEach((r, i) => write(pen, r, col.x, baseline + i * size * 1.5, size, rng));
      const box = { x: col.x, y: top, w: width, h };
      occupied.push(box);
      this.parts.push(box);
    }

    const work = (ink.write ?? []).map((w) => w.trim()).filter(Boolean);
    const workSize = size * 0.95;
    const figSize = Math.max(workSize, 28);
    // What a written line or figure will cover, measured with a practice pen first.
    const sizeOf = (draw: (p: Pen) => void): Box => {
      const p = new Pen(1);
      draw(p);
      return p.box ?? { x: 0, y: 0, w: 0, h: 0 };
    };
    for (const text of work) {
      // the practice run uses the same random wobble as the real one, so it measures exactly
      const wobble = Math.floor(rng() * 2 ** 31);
      const b = sizeOf((p) => write(p, text, 0, 0, workSize, seeded(wobble)));
      const at = this.spot(b.w, b.h);
      pen.lift(pen.t ? 180 : 0);
      write(pen, text, at.x - b.x, at.y - b.y, workSize, seeded(wobble));
      const box = { x: at.x, y: at.y, w: b.w, h: b.h };
      occupied.push(box);
      this.parts.push(box);
    }

    (ink.figures ?? []).forEach((fig, i) => {
      pen.width = penWidth(figSize) * 0.9;
      const grown = i === 0 && ink.continueFigure && this.build ? extendFigure(this.build.fig, fig) : null;
      if (grown && this.build) {
        this.grow(pen, this.build, grown);
        figure = { ...this.build.part };
        return;
      }
      const wobble = Math.floor(rng() * 2 ** 31);
      let layout: FigureLayout = {};
      const b = sizeOf((p) => (layout = drawFigure(p, fig, 0, 0, figSize, seeded(wobble))));
      // hold the space this figure may grow into while the turn goes on
      const room = figureRoom(fig, figSize, b, 0, 0);
      const at = this.spot(room.w, room.h);
      const ox = at.x - room.x, oy = at.y - room.y;
      pen.lift(pen.t ? 300 : 0);
      const first = pen.strokes.length;
      drawFigure(pen, fig, ox, oy, figSize, seeded(wobble), layout);
      const drawn = new Set(pen.strokes.slice(first).map((s) => s.tag ?? ""));
      const part = { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h };
      occupied.push(part);
      this.parts.push(part);
      this.room.push({ x: at.x, y: at.y, w: room.w, h: room.h });
      this.build = { fig, x: ox, y: oy, size: figSize, seed: wobble, layout, drawn, part };
      figure = { ...part };
    });

    const strokes = pen.strokes.map(({ tag: _tag, ...s }) => s);
    return { strokes, duration: pen.t, box: pen.box, parts: this.parts.slice(before), ...(figure ? { figure } : {}) };
  }

  // Draws only what's new in a figure that has grown, in the place of the
  // parts already drawn.
  private grow(pen: Pen, build: Build, fig: Figure) {
    const scratch = new Pen(pen.speed);
    scratch.width = pen.width;
    drawFigure(scratch, fig, build.x, build.y, build.size, seeded(build.seed), build.layout);
    const fresh = scratch.strokes.filter((s) => !build.drawn.has(s.tag ?? ""));
    build.fig = fig;
    if (!fresh.length) return;
    pen.lift(pen.t ? 200 : 0);
    let prevEnd: number | null = null;
    let box: Box | null = null;
    for (const s of fresh) {
      // keep the pauses between the new strokes, but not the time spent on old ones
      if (prevEnd != null) pen.lift(Math.min(300, Math.max(0, s.start - prevEnd)));
      const ms = s.end - s.start;
      pen.strokes.push({ ...s, start: pen.t, end: pen.t + ms });
      pen.t += ms;
      prevEnd = s.end;
      for (const [x, y] of s.points) {
        const b = { x, y, w: 0, h: 0 };
        box = box ? unionBox(box, b) : b;
      }
      build.drawn.add(s.tag ?? "");
    }
    if (!box) return;
    pen.box = pen.box ? unionBox(pen.box, box) : box;
    // the figure's part box (kept with its first phrase's ink) grows to cover it
    Object.assign(build.part, unionBox(build.part, box));
  }
}

// A whole turn's ink at once: marks, notes, then written lines, then figures.
export function planAnnotations(annotations: Annotation[], lines: InkLine[], seed: number, opts: PlanOptions = {}): PenPlan {
  return new TurnPlanner(lines, seed, opts).plan({ annotations, marks: opts.marks, write: opts.write, figures: opts.figures });
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
