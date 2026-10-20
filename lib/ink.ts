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

export type InkLine = { id: string; box: Box; strokeIds: string[] };

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
  return lines
    .sort((a, b) => a.box.y - b.box.y)
    .map((l, i) => ({ id: `L${i + 1}`, box: l.box, strokeIds: l.strokeIds }));
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
