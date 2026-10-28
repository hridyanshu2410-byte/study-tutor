import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_LINES, shortTitle, thinkingAloud } from "./thinking-aloud.ts";

test("something short is said while thinking, never the same twice in a row", () => {
  let before = "";
  for (let i = 0; i < 30; i++) {
    const line = thinkingAloud("asked", null, null)!;
    assert.notEqual(line.text, before);
    assert.ok(line.after <= 400, "said within a moment of asking");
    before = line.text;
  }
  for (const text of ALL_LINES) assert.ok(text.split(" ").length <= 5, `"${text}" is short`);
});

test("nothing is said when the tutor only glances at the page", () => {
  assert.equal(thinkingAloud("pause", null, null), null);
});

test("a question gets a thinking sound, a statement a nod", () => {
  for (let i = 0; i < 10; i++) {
    assert.match(thinkingAloud("spoke", "why does the chain rule work?", null)!.text, /Hmm|Ooh|good question/);
    assert.match(thinkingAloud("spoke", "I think it's x squared", null)!.text, /^(Mm|Okay)/);
  }
});

test("a paper is named only when its name is short enough to say in passing", () => {
  assert.equal(shortTitle("Social Simulacra: Creating Populated Prototypes for Social Computing Systems"), "Social Simulacra");
  assert.equal(shortTitle("Sparse Routing Transformers for Long Documents"), null);
  assert.match(thinkingAloud("paper_opened", null, "Social Simulacra: Creating Populated Prototypes")!.text, /Social Simulacra\.$/);
  assert.ok(thinkingAloud("paper_opened", null, "Sparse Routing Transformers for Long Documents")!.text.split(" ").length <= 5);
});
