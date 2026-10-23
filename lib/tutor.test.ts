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
    annotations: [],
    skill: { concept: "", evidence: "none" },
    card: null,
    review_result: null,
  };
  assert.equal(tutorTurnSchema(allowedMoves("wait")).safeParse(turn).success, false);
  assert.equal(tutorTurnSchema(allowedMoves("name_concept")).safeParse(turn).success, true);
});
