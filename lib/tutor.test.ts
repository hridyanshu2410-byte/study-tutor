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

test("a turn outside the allowed moves is rejected", () => {
  const turn = {
    private: { reading: [], first_error_line: null, diagnosis: "", solution_sketch: "" },
    move: "simpler_example",
    say: "Try 2y + 3 = 7 first.",
    write: ["Try: 2y + 3 = 7"],
    draw: [],
    highlights: [],
    simulate: null,
    annotations: [],
    skill: { concept: "", evidence: "none" },
    card: null,
    review_result: null,
  };
  assert.equal(tutorTurnSchema(allowedMoves("wait")).safeParse(turn).success, false);
  assert.equal(tutorTurnSchema(allowedMoves("name_concept")).safeParse(turn).success, true);
});

test("a simulation is part of a turn", () => {
  const turn = {
    private: { reading: [], first_error_line: null, diagnosis: "", solution_sketch: "" },
    move: "ask_plan",
    say: "Before you play it, where do you think it lands?",
    write: [],
    draw: [],
    highlights: [],
    simulate: { kind: "projectile", height_m: 0, launches: [{ speed_ms: 15, angle_deg: 30, label: null }, { speed_ms: 15, angle_deg: 60, label: null }], g: null },
    annotations: [],
    skill: { concept: "projectile range", evidence: "none" },
    card: null,
    review_result: null,
  };
  assert.equal(tutorTurnSchema().safeParse(turn).success, true);
  assert.equal(tutorTurnSchema().safeParse({ ...turn, simulate: { kind: "rocket" } }).success, false);
});

test("paper turns can point at sentences and draw diagrams", () => {
  const turn = {
    private: { reading: [], first_error_line: null, diagnosis: "", solution_sketch: "" },
    move: "name_concept",
    say: "Here's the big picture.",
    write: [],
    draw: [{ kind: "diagram", direction: "right", nodes: [{ id: "a", text: "tokens", group: null }, { id: "b", text: "clusters", group: "routing" }], edges: [{ from: "a", to: "b", label: null }] }],
    highlights: [{ ref: "p1.s3", kind: "highlight", note: "the key idea" }],
    simulate: null,
    annotations: [],
    skill: { concept: "sparse attention", evidence: "none" },
    card: null,
    review_result: null,
  };
  assert.equal(tutorTurnSchema().safeParse(turn).success, true);
});
