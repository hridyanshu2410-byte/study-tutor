import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedMoves, tutorTurnSchema } from "./tutor.ts";

test("the hint ladder climbs one rung at a time", () => {
  assert.deepEqual(
    allowedMoves("wait").filter((m) => !["wait", "affirm", "check_understanding"].includes(m)),
    ["ask_plan"],
  );
  assert.ok(allowedMoves("point").includes("name_concept"));
  assert.ok(!allowedMoves("point").includes("simpler_example"));
  assert.ok(!allowedMoves("name_concept").includes("worked_solution"));
  assert.ok(allowedMoves("next_step").includes("worked_solution"));
  // stepping back down is always allowed
  assert.ok(allowedMoves("next_step").includes("ask_plan"));
});

const beat = (say: string, more: Record<string, unknown> = {}) => ({
  say,
  write: [],
  draw: null,
  continue_figure: false,
  highlights: [],
  annotations: [],
  ...more,
});

const base = {
  private: { reading: [], first_error_line: null, diagnosis: "", solution_sketch: "" },
  simulate: null,
  skill: { concept: "", evidence: "none" },
  card: null,
  review_result: null,
};

test("a turn outside the allowed moves is rejected", () => {
  const turn = { ...base, move: "simpler_example", beats: [beat("Try a smaller one first.", { write: ["Try: 2y + 3 = 7"] })] };
  assert.equal(tutorTurnSchema(allowedMoves("wait")).safeParse(turn).success, false);
  assert.equal(tutorTurnSchema(allowedMoves("name_concept")).safeParse(turn).success, true);
});

test("a turn is spoken and written phrase by phrase", () => {
  const turn = {
    ...base,
    move: "next_step",
    beats: [
      beat("Start by taking five from both sides.", { draw: { kind: "steps", lines: [{ math: "2x + 5 = 11", note: "−5" }, { math: "2x = 6", note: null }] } }),
      beat("Now what would you divide by?", { continue_figure: true, draw: { kind: "steps", lines: [{ math: "x = ?", note: null }] } }),
    ],
  };
  assert.equal(tutorTurnSchema().safeParse(turn).success, true);
  // the beats come before the rest of the turn, so the first can be spoken while the rest is written
  const keys = Object.keys(tutorTurnSchema().shape);
  assert.ok(keys.indexOf("beats") < keys.indexOf("simulate") && keys.indexOf("beats") < keys.indexOf("card"));
  assert.equal(keys.indexOf("private"), 0);
});

test("a simulation is part of a turn", () => {
  const turn = {
    ...base,
    move: "ask_plan",
    beats: [beat("Before you play it, where do you think it lands?")],
    simulate: { kind: "projectile", height_m: 0, launches: [{ speed_ms: 15, angle_deg: 30, label: null }, { speed_ms: 15, angle_deg: 60, label: null }], g: null },
    skill: { concept: "projectile range", evidence: "none" },
  };
  assert.equal(tutorTurnSchema().safeParse(turn).success, true);
  assert.equal(tutorTurnSchema().safeParse({ ...turn, simulate: { kind: "rocket" } }).success, false);
});

test("paper turns can point at sentences and build a diagram as they go", () => {
  const turn = {
    ...base,
    move: "name_concept",
    beats: [
      beat("Here's the big picture: tokens come in,", {
        draw: { kind: "diagram", title: "The method", nodes: [{ id: "a", text: "tokens", row: 0, col: 0 }], edges: [], frames: [] },
      }),
      beat("and get routed into clusters.", {
        continue_figure: true,
        draw: { kind: "diagram", title: null, nodes: [{ id: "b", text: "clusters", row: 0, col: 1 }], edges: [{ from: "a", to: "b", label: null }], frames: [{ label: "routing", nodes: ["b"] }] },
        highlights: [{ ref: "p1.s3", kind: "highlight", note: "the key idea" }],
      }),
    ],
    skill: { concept: "sparse attention", evidence: "none" },
  };
  assert.equal(tutorTurnSchema().safeParse(turn).success, true);
});
