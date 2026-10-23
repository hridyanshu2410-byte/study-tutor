// Pure geometry for student ink: strokes live in world coordinates so the
// canvas can pan and zoom without touching stored data.

export type Point = [x: number, y: number, pressure: number];

export type Stroke = {
  id: string;
  points: Point[];
  color: string;
  size: number;
  createdAt: number;
};

export type Box = { x: number; y: number; w: number; h: number };

export type InkToken = { n: number; box: Box; strokeIds: string[] };

export type InkLine = { id: string; box: Box; strokeIds: string[]; tokens: InkToken[] };

export type Camera = { x: number; y: number; z: number };

export function strokeBox(stroke: Stroke): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = stroke.size / 2;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// Groups strokes into handwritten lines: strokes whose vertical extents
// overlap by more than a third of the smaller one belong to the same line.
// Lines are numbered top to bottom so the tutor can point at "L3".
export function groupLines(strokes: Stroke[]): InkLine[] {
  const items = strokes
    .filter((s) => s.points.length > 0)
    .map((s) => ({ id: s.id, box: strokeBox(s) }))
    .sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));

  const lines: { box: Box; strokeIds: string[] }[] = [];
  for (const item of items) {
    const line = lines.find((l) => verticalOverlap(l.box, item.box) > Math.min(l.box.h, item.box.h, 80) / 3);
    if (line) {
      line.box = unionBox(line.box, item.box);
      line.strokeIds.push(item.id);
    } else {
      lines.push({ box: item.box, strokeIds: [item.id] });
    }
  }
  mergeSmallLines(lines);
  const boxes = new Map(items.map((i) => [i.id, i.box]));
  return lines
    .sort((a, b) => a.box.y - b.box.y)
    .map((l, i) => ({ id: `L${i + 1}`, box: l.box, strokeIds: l.strokeIds, tokens: groupTokens(l.strokeIds, boxes, l.box.h) }));
}

// A first pass can leave thin pieces (the second bar of "=", a minus sign, an
// exponent) as lines of their own. Fold any line that is much shorter than a
// neighbour and sits within its band back into it.
function mergeSmallLines(lines: { box: Box; strokeIds: string[] }[]) {
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        const big = lines[i];
        const small = lines[j];
        if (i === j || small.box.h >= big.box.h * 0.7) continue;
        const cy = small.box.y + small.box.h / 2;
        const inBand = cy > big.box.y - big.box.h * 0.3 && cy < big.box.y + big.box.h * 1.3;
        const near = small.box.x < big.box.x + big.box.w + big.box.h && small.box.x + small.box.w > big.box.x - big.box.h;
        if (inBand && near) {
          big.box = unionBox(big.box, small.box);
          big.strokeIds.push(...small.strokeIds);
          lines.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
}

// Splits a line into tokens (roughly symbols or short terms) at horizontal
// gaps, so the tutor can circle "the 2 in x squared" instead of a whole line.
function groupTokens(strokeIds: string[], boxes: Map<string, Box>, lineHeight: number): InkToken[] {
  const gap = Math.min(lineHeight, 70) * 0.12;
  const sorted = strokeIds.map((id) => ({ id, box: boxes.get(id)! })).sort((a, b) => a.box.x - b.box.x);
  const tokens: { box: Box; strokeIds: string[] }[] = [];
  for (const s of sorted) {
    const last = tokens.at(-1);
    if (last && s.box.x <= last.box.x + last.box.w + gap) {
      last.box = unionBox(last.box, s.box);
      last.strokeIds.push(s.id);
    } else {
      tokens.push({ box: s.box, strokeIds: [s.id] });
    }
  }
  return tokens.map((t, i) => ({ n: i + 1, ...t }));
}

export function spanBox(line: InkLine, from: number, to: number): Box {
  const clamp = (n: number) => Math.max(1, Math.min(line.tokens.length, n));
  const lo = clamp(Math.min(from, to));
  const hi = clamp(Math.max(from, to));
  const picked = line.tokens.filter((t) => t.n >= lo && t.n <= hi);
  if (!picked.length) return line.box;
  return picked.slice(1).reduce((b, t) => unionBox(b, t.box), picked[0].box);
}

function verticalOverlap(a: Box, b: Box): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [sx / cam.z + cam.x, sy / cam.z + cam.y];
}

export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.z, (wy - cam.y) * cam.z];
}

// Zooms around a fixed screen point so the ink under the fingers stays put.
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const z = Math.min(8, Math.max(0.1, cam.z * factor));
  const [wx, wy] = screenToWorld(cam, sx, sy);
  return { x: wx - sx / z, y: wy - sy / z, z };
}

export function distanceToStroke(stroke: Stroke, x: number, y: number): number {
  let best = Infinity;
  for (const [px, py] of stroke.points) {
    const d = Math.hypot(px - x, py - y);
    if (d < best) best = d;
  }
  return best;
}

// The strokes a lasso loop encloses: most of a stroke's points must fall
// inside, so a loop drawn a little loosely still picks up a whole expression.
export function strokesInLasso(strokes: Stroke[], loop: [number, number][]): Stroke[] {
  if (loop.length < 3) return [];
  return strokes.filter((s) => {
    if (!s.points.length) return false;
    const inside = s.points.filter(([x, y]) => pointInPolygon(x, y, loop)).length;
    return inside / s.points.length >= 0.6;
  });
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
