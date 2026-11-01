// A 3D model as it sits on the page: a frame with its title and a live
// readout, the rendered view, labels off to the sides with leader lines to
// the parts they name, and a row of view buttons (whole, explode, cut open,
// x-ray, play). Drawing and hit-testing only; the 3D itself is model3d-render.

import type { Box } from "./ink.ts";
import type { PageModel } from "./model3d.ts";

export const MODEL_HEAD = 38;
export const MODEL_FOOT = 44;
const ACCENT = "#ea580c";

export type ModelLabelBox = { id: string; text: string; ax: number; ay: number; box: Box; focused: boolean };
export type ModelButton = { id: string; label: string; box: Box; on: boolean };

// The part of the frame the 3D view fills, in page coordinates.
export const modelView = (m: PageModel): Box => ({ x: m.x + 1, y: m.y + MODEL_HEAD, w: m.w - 2, h: m.h - MODEL_HEAD - MODEL_FOOT });

export function modelButtons(ctx: CanvasRenderingContext2D, m: PageModel, views: { id: string; label: string }[], animated: boolean): ModelButton[] {
  ctx.save();
  ctx.font = "600 14px system-ui, sans-serif";
  const items = [...views.map((v) => ({ id: `view:${v.id}`, label: v.label, on: m.state.view === v.id }))];
  if (animated) items.push({ id: "play", label: m.state.playing ? "Pause" : "Play", on: false });
  items.push({ id: "reset", label: "Reset", on: false });
  const out: ModelButton[] = [];
  let x = m.x + 10;
  const y = m.y + m.h - MODEL_FOOT + 8;
  for (const it of items) {
    const w = ctx.measureText(it.label).width + 22;
    out.push({ ...it, box: { x, y, w, h: 28 } });
    x += w + 6;
  }
  ctx.restore();
  return out;
}

// Labels at the left and right edges of the view, each at the height of its
// part where they can be, nudged apart so none overlap.
export function placeLabels(ctx: CanvasRenderingContext2D, m: PageModel, labels: { id: string; text: string; x: number; y: number; focused: boolean }[]): ModelLabelBox[] {
  const v = modelView(m);
  ctx.save();
  ctx.font = "13px system-ui, sans-serif";
  const sides: Record<"l" | "r", ModelLabelBox[]> = { l: [], r: [] };
  for (const l of labels) {
    const ax = v.x + l.x, ay = v.y + l.y;
    if (ax < v.x - 4 || ax > v.x + v.w + 4 || ay < v.y - 4 || ay > v.y + v.h + 4) continue;
    const text = l.text.length > 42 ? `${l.text.slice(0, 40)}…` : l.text;
    const w = ctx.measureText(text).width + 12;
    const side = ax < v.x + v.w / 2 ? "l" : "r";
    sides[side].push({ id: l.id, text, ax, ay, focused: l.focused, box: { x: side === "l" ? v.x + 8 : v.x + v.w - 8 - w, y: ay - 11, w, h: 22 } });
  }
  ctx.restore();
  for (const list of Object.values(sides)) {
    list.sort((a, b) => a.box.y - b.box.y);
    for (let i = 0; i < list.length; i++) {
      const prev = list[i - 1];
      list[i].box.y = Math.max(list[i].box.y, v.y + 6, prev ? prev.box.y + 25 : -Infinity);
    }
    // pushed off the bottom: pull the column back up
    const over = list.length ? list[list.length - 1].box.y + 22 - (v.y + v.h - 4) : 0;
    if (over > 0) for (let i = list.length - 1; i >= 0; i--) list[i].box.y = Math.max(v.y + 4, Math.min(list[i].box.y - over, i < list.length - 1 ? list[i + 1].box.y - 25 : Infinity));
  }
  return [...sides.l, ...sides.r];
}

export function drawModelFrame(
  ctx: CanvasRenderingContext2D,
  m: PageModel,
  picture: CanvasImageSource | null,
  title: string,
  readout: string | null,
  labels: ModelLabelBox[],
  buttons: ModelButton[],
  z: number,
) {
  const v = modelView(m);
  ctx.save();
  // card
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1 / z;
  ctx.beginPath();
  ctx.roundRect(m.x, m.y, m.w, m.h, 14);
  ctx.fill();
  ctx.stroke();
  if (picture) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.clip();
    ctx.drawImage(picture, v.x, v.y, v.w, v.h);
    ctx.restore();
  } else {
    ctx.fillStyle = "#f7f5f0";
    ctx.fillRect(v.x, v.y, v.w, v.h);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("Building the model…", v.x + 16, v.y + 28);
  }
  ctx.fillStyle = "#111827";
  ctx.font = "600 16px system-ui, sans-serif";
  ctx.fillText(title, m.x + 14, m.y + 24);
  if (readout) {
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = ACCENT;
    const w = ctx.measureText(readout).width;
    ctx.fillText(readout, m.x + m.w - 14 - w, m.y + 24);
  }
  // labels and leaders
  ctx.font = "13px system-ui, sans-serif";
  for (const l of labels) {
    const left = l.box.x < v.x + v.w / 2;
    const ex = left ? l.box.x + l.box.w : l.box.x;
    const ey = l.box.y + l.box.h / 2;
    ctx.strokeStyle = l.focused ? ACCENT : "rgba(31, 41, 55, 0.55)";
    ctx.lineWidth = (l.focused ? 1.6 : 1) / Math.max(z, 0.5);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(l.ax, l.ay);
    ctx.stroke();
    ctx.fillStyle = l.focused ? ACCENT : "#1f2937";
    ctx.beginPath();
    ctx.arc(l.ax, l.ay, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = l.focused ? "#fff7ed" : "rgba(255, 255, 255, 0.9)";
    ctx.strokeStyle = l.focused ? ACCENT : "#e5e7eb";
    ctx.beginPath();
    ctx.roundRect(l.box.x, l.box.y, l.box.w, l.box.h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = l.focused ? "#9a3412" : "#1f2937";
    ctx.fillText(l.text, l.box.x + 6, l.box.y + 15.5);
  }
  // buttons
  ctx.font = "600 14px system-ui, sans-serif";
  for (const b of buttons) {
    ctx.fillStyle = b.on ? "#1f2a44" : "#f3f4f6";
    ctx.beginPath();
    ctx.roundRect(b.box.x, b.box.y, b.box.w, b.box.h, 8);
    ctx.fill();
    ctx.fillStyle = b.on ? "#ffffff" : "#374151";
    ctx.fillText(b.label, b.box.x + 11, b.box.y + 19);
  }
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "#9ca3af";
  const hint = "drag to turn";
  ctx.fillText(hint, m.x + m.w - 12 - ctx.measureText(hint).width, m.y + m.h - 18);
  ctx.restore();
}

const inside = (b: Box, x: number, y: number, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

// What a tap at (x, y) on the page hits on this model.
export function hitModel(m: PageModel, x: number, y: number, buttons: ModelButton[], labels: ModelLabelBox[]): { kind: "button"; id: string } | { kind: "label"; id: string } | { kind: "view" } | { kind: "frame" } | null {
  if (!inside({ x: m.x, y: m.y, w: m.w, h: m.h }, x, y)) return null;
  const b = buttons.find((b) => inside(b.box, x, y, 3));
  if (b) return { kind: "button", id: b.id };
  const l = labels.find((l) => inside(l.box, x, y, 2));
  if (l) return { kind: "label", id: l.id };
  if (inside(modelView(m), x, y)) return { kind: "view" };
  return { kind: "frame" };
}
