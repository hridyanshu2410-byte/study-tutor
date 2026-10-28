import { test } from "node:test";
import assert from "node:assert/strict";
import { Pen, seeded, TurnPlanner } from "./handwriting.ts";
import { drawFigure, extendFigure } from "./figures.ts";
import { THINGS, type Figure } from "./figure-schema.ts";
import type { Box } from "./ink.ts";

type Scene = Extract<Figure, { kind: "scene" }>;
type Thing = Scene["things"][number];
const thing = (id: string, what: Thing["what"], row: number, col: number, more: Partial<Thing> = {}): Thing => ({ id, what, row, col, count: null, caption: null, says: null, ...more });
const scene = (things: Thing[], more: Partial<Scene> = {}): Scene => ({ kind: "scene", title: null, things, arrows: [], marks: [], ...more });

// Draws a figure and returns the box each part's strokes cover, by tag.
function parts(fig: Figure, seed = 1) {
  const pen = new Pen(1);
  drawFigure(pen, fig, 0, 0, 28, seeded(seed));
  const boxes = new Map<string, Box>();
  const strokes = new Map<string, number>();
  for (const s of pen.strokes) {
    const tag = s.tag ?? "";
    strokes.set(tag, (strokes.get(tag) ?? 0) + 1);
    for (const [x, y] of s.points) {
      const b = boxes.get(tag);
      if (!b) boxes.set(tag, { x, y, w: 0, h: 0 });
      else {
        const x0 = Math.min(b.x, x), y0 = Math.min(b.y, y);
        boxes.set(tag, { x: x0, y: y0, w: Math.max(b.x + b.w, x) - x0, h: Math.max(b.y + b.h, y) - y0 });
      }
    }
  }
  return { boxes, strokes, pen };
}
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Box, outer: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

test("every picture draws, each in its own cell, with its caption", () => {
  const things = THINGS.slice(0, 12).map((what, i) => thing(what, what, Math.floor(i / 4), i % 4, { caption: what, count: what === "people" ? 8 : null }));
  const { boxes } = parts(scene(things));
  for (const t of things) assert.ok(boxes.get(`thing:${t.id}`)!.w > 20, `${t.what} draws`);
  for (let i = 0; i < things.length; i++)
    for (let j = i + 1; j < things.length; j++) assert.ok(!overlap(boxes.get(`thing:${things[i].id}`)!, boxes.get(`thing:${things[j].id}`)!), `${things[i].id} and ${things[j].id} apart`);
  // the rest of the pictures draw too
  const rest = THINGS.slice(12).map((what, i) => thing(what, what, Math.floor(i / 4) % 3, i % 4));
  for (const t of rest) assert.ok(parts(scene([t])).boxes.get(`thing:${t.id}`)!.w > 10, `${t.what} draws`);
});

test("a few people look like a few and a crowd like a crowd", () => {
  const { strokes } = parts(scene([thing("few", "people", 0, 0, { count: 3 }), thing("many", "people", 0, 1, { count: 20 })]));
  assert.ok(strokes.get("thing:many")! > strokes.get("thing:few")! * 3);
});

test("a circle goes round the thing it names, bubble and caption too, and nothing else", () => {
  const fig = scene([thing("ai", "robot", 0, 0, { caption: "GPT-3" }), thing("crowd", "people", 0, 1, { count: 12, caption: "simulated members", says: "this is dumb" })], {
    arrows: [{ from: "ai", to: "crowd", label: "generates" }],
    marks: [{ on: "crowd", kind: "circle", note: "anti-social" }],
  });
  const { boxes } = parts(fig);
  const ring = boxes.get("mark:crowd:circle")!;
  assert.ok(inside(boxes.get("thing:crowd")!, ring), "the crowd, its bubble and its caption are inside the circle");
  const ai = boxes.get("thing:ai")!;
  assert.ok(!inside({ x: ai.x + ai.w / 2, y: ai.y + ai.h / 2, w: 0, h: 0 }, ring), "the robot is not");
  // the arrow runs between the two pictures
  const arrow = boxes.get("arrow:ai>crowd")!;
  assert.ok(arrow.x >= ai.x + ai.w * 0.5 && arrow.x + arrow.w <= boxes.get("thing:crowd")!.x + boxes.get("thing:crowd")!.w);
});

test("a circle stays close round what it circles and clear of the arrow's label", () => {
  const fig = scene([thing("ai", "robot", 0, 0, { caption: "GPT-3" }), thing("crowd", "people", 0, 1, { count: 12, caption: "simulated members", says: "this is dumb" })], {
    arrows: [{ from: "ai", to: "crowd", label: "generates" }],
    marks: [{ on: "crowd", kind: "circle", note: null }],
  });
  const { boxes, pen } = parts(fig);
  const ring = boxes.get("mark:crowd:circle")!, crowd = boxes.get("thing:crowd")!;
  assert.ok(ring.x > crowd.x - 28 && ring.x + ring.w < crowd.x + crowd.w + 28, "no wider than the crowd and a margin");
  // apart from where the arrow's head meets it, the circle touches nothing of the arrow or its label
  const loop = pen.strokes.filter((s) => s.tag === "mark:crowd:circle").flatMap((s) => s.points);
  const arrowPts = pen.strokes.filter((s) => s.tag === "arrow:ai>crowd").flatMap((s) => s.points);
  const tip = Math.max(...arrowPts.map(([x]) => x));
  const near = arrowPts.filter(([x]) => x < tip - 20).filter(([x, y]) => loop.some(([lx, ly]) => Math.hypot(lx - x, ly - y) < 4));
  assert.equal(near.length, 0);
});

test("marks and arrows on things that aren't there are left out", () => {
  const { boxes } = parts(scene([thing("a", "person", 0, 0)], { arrows: [{ from: "a", to: "ghost", label: null }], marks: [{ on: "ghost", kind: "circle", note: "?" }] }));
  assert.deepEqual([...boxes.keys()], ["thing:a"]);
});

test("a scene grows phrase by phrase without moving what is already drawn", () => {
  const first = scene([thing("d", "person", 0, 0, { caption: "designer" }), thing("doc", "document", 0, 1, { caption: "rules" })], { title: "Social simulacra", arrows: [{ from: "d", to: "doc", label: "writes" }] });
  const more = scene([thing("crowd", "people", 0, 2, { count: 10 })], { arrows: [{ from: "doc", to: "crowd", label: null }], marks: [{ on: "crowd", kind: "circle", note: null }] });
  const grown = extendFigure(first, more)!;
  assert.equal(grown.kind, "scene");
  const a = parts(first, 5).pen.strokes, b = parts(grown, 5).pen.strokes;
  for (const tag of ["title", "thing:d", "thing:doc", "arrow:d>doc"])
    assert.deepEqual(
      b.filter((s) => s.tag === tag).map((s) => s.points),
      a.filter((s) => s.tag === tag).map((s) => s.points),
      `${tag} stays where it was`,
    );
  // in a turn, the second phrase draws only the new parts, beside the first ones
  const planner = new TurnPlanner([], 3, { column: { x: 0, top: 0 }, size: 19 });
  const p1 = planner.plan({ figures: [first] });
  const p2 = planner.plan({ figures: [more], continueFigure: true });
  assert.ok(p2.strokes.length > 0 && p2.strokes.length < p1.strokes.length + 40);
  const left = Math.min(...p2.strokes.filter((s) => s.points.length > 8).flatMap((s) => s.points.map(([x]) => x)));
  assert.ok(left > p1.box!.x + p1.box!.w * 0.5, "the new parts are to the right of the old ones");
});
