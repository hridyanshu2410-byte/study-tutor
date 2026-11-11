import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsCsv, inkBounds, isSessionFile, pageAt, SessionLog, timePoints } from "./session-log.ts";
import { brokenManners, glanceDelay, KEPT, readManners } from "./manners.ts";

function clock() {
  let now = 1000;
  const c = () => now;
  return { c, at: (ms: number) => (now = 1000 + ms) };
}

test("a stroke keeps the time of each point, from pen down", () => {
  const k = clock();
  const log = new SessionLog("s1", KEPT, k.c, 0);
  k.at(100);
  log.strokeBegin("a");
  k.at(120);
  log.strokePoint("a");
  k.at(160);
  log.strokePoint("a");
  log.strokeEnd("student", { id: "a", color: "#000", size: 4, points: [[0, 0, 0.5], [5, 0, 0.5], [10, 0, 0.6]] }, 1000 + 170);
  const e = log.events[0];
  assert.equal(e.type, "stroke");
  if (e.type !== "stroke") return;
  assert.equal(e.t, 100);
  assert.equal(e.end, 170);
  assert.deepEqual(e.pts.map((p) => p[3]), [0, 20, 60]);
});

test("points replaced wholesale are spread evenly over the stroke", () => {
  const pts = timePoints([[0, 0], [1, 0], [2, 0]], [5], 0, 100);
  assert.deepEqual(pts.map((p) => p[3]), [0, 50, 100]);
});

test("the page at a moment shows ink as far as it was drawn, and not after it was erased", () => {
  const k = clock();
  const log = new SessionLog("s2", KEPT, k.c, 0);
  log.strokeBegin("a");
  k.at(50);
  log.strokePoint("a");
  k.at(100);
  log.strokePoint("a");
  log.strokeEnd("student", { id: "a", color: "#000", size: 4, points: [[0, 0, 0.5], [5, 0, 0.5], [10, 0, 0.5]] });
  log.push({ t: 200, type: "tutor_ink", id: "ink1", turn: 1, beat: 1, strokes: [{ points: [[0, 0], [1, 1], [2, 2], [3, 3]], start: 0, end: 400 }], duration: 400 });
  k.at(900);
  log.erase("student", ["a"], "eraser");
  const file = log.toFile();
  assert.equal(pageAt(file, 60).strokes[0].points.length, 2);
  assert.equal(pageAt(file, 60).strokes[0].drawing, true);
  assert.equal(pageAt(file, 150).strokes[0].drawing, false);
  assert.equal(pageAt(file, 150).tutorInk.length, 0);
  assert.equal(pageAt(file, 200).tutorInk[0].strokes.length, 0);
  assert.equal(pageAt(file, 400).tutorInk[0].strokes[0].done, false);
  assert.equal(pageAt(file, 700).tutorInk[0].strokes[0].done, true);
  assert.equal(pageAt(file, 950).strokes.length, 0);
});

test("speech is shown while it is being said", () => {
  const k = clock();
  const log = new SessionLog("s3", KEPT, k.c, 0);
  log.push({ t: 100, type: "speech", who: "tutor", text: "Look here.", end: 900, turn: 1, beat: 1, voice: "audio" });
  const f = log.toFile();
  assert.deepEqual(pageAt(f, 500).speaking, [{ who: "tutor", text: "Look here." }]);
  assert.deepEqual(pageAt(f, 1000).speaking, []);
  assert.equal(f.duration >= 900, true);
});

test("the view is sampled at most four times a second, and only when it moves", () => {
  const k = clock();
  const log = new SessionLog("s4", KEPT, k.c, 0);
  log.view({ x: 0, y: 0, z: 1 }, 800, 600);
  k.at(100);
  log.view({ x: 50, y: 0, z: 1 }, 800, 600);
  k.at(400);
  log.view({ x: 50, y: 0, z: 1 }, 800, 600);
  k.at(800);
  log.view({ x: 51, y: 0, z: 1 }, 800, 600);
  assert.equal(log.events.filter((e) => e.type === "view").length, 2);
});

test("files are recognised, bounded and exported as CSV", () => {
  const k = clock();
  const log = new SessionLog("s5", { ...KEPT, inkAtOnce: true }, k.c, 0);
  log.strokeBegin("a");
  log.strokeEnd("student", { id: "a", color: "#000", size: 4, points: [[10, 20, 0.5], [30, 40, 0.5]] });
  log.push({ t: 5, type: "speech", who: "student", text: 'I said "hi", then stopped', end: 50 });
  const f = log.toFile();
  assert.ok(isSessionFile(JSON.parse(JSON.stringify(f))));
  assert.ok(!isSessionFile({ events: [] }));
  assert.deepEqual(inkBounds(f), { x: 10, y: 20, w: 20, h: 20 });
  const csv = eventsCsv(f).trim().split("\n");
  assert.equal(csv.length, 3);
  assert.match(csv[2], /"I said ""hi"", then stopped"/);
});

test("manner switches read from objects and strings, and set the glance delay", () => {
  assert.deepEqual(readManners({ overLine: true, nonsense: true, inkAtOnce: "yes" }), { ...KEPT, overLine: true });
  assert.deepEqual(brokenManners(readManners("speakAtOnce, inkAtOnce bogus")), ["speakAtOnce", "inkAtOnce"]);
  assert.equal(glanceDelay(KEPT, false), 1500);
  assert.equal(glanceDelay(KEPT, true), 3500);
  assert.equal(glanceDelay({ ...KEPT, speakAtOnce: true }, true), 300);
});

test("ink put back by undo comes back after it was erased", () => {
  const k = clock();
  const log = new SessionLog("s6", KEPT, k.c, 0);
  log.strokeBegin("a");
  log.strokeEnd("student", { id: "a", color: "#000", size: 4, points: [[0, 0, 0.5]] });
  k.at(100);
  log.erase("student", ["a"], "eraser");
  k.at(200);
  log.push({ t: log.now(), type: "restore", who: "student", ids: ["a"] });
  const f = log.toFile();
  assert.equal(pageAt(f, 50).strokes.length, 1);
  assert.equal(pageAt(f, 150).strokes.length, 0);
  assert.equal(pageAt(f, 250).strokes.length, 1);
});
