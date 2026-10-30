import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionOf, dailyTutorLimit, inviteOk, parseIntake, pickCondition, startOfUtcDay, studyConditions, testOpen, toCsv } from "./study.ts";
import { publicItems, scoreTest, TESTS } from "./study-tests.ts";

test("csv quotes commas, quotes, newlines and objects", () => {
  const csv = toCsv([{ a: 'say "hi", ok', b: { move: "wait" }, c: null }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\r\n"say ""hi"", ok","{""move"":""wait""}",\r\n');
});

test("intake accepts only listed answers", () => {
  const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.deepEqual(parseIntake(form({ level: "Undergraduate", aiUse: "Weekly", course: " Calc I " })), {
    level: "Undergraduate",
    aiUse: "Weekly",
    course: "Calc I",
  });
  assert.equal(parseIntake(form({ level: "Wizard", aiUse: "Weekly" })), null);
});

test("invite code is optional and case-insensitive", () => {
  delete process.env.STUDY_INVITE_CODE;
  assert.equal(inviteOk(undefined), true);
  process.env.STUDY_INVITE_CODE = "Calc2026";
  assert.equal(inviteOk(" calc2026 "), true);
  assert.equal(inviteOk("nope"), false);
  delete process.env.STUDY_INVITE_CODE;
});

test("daily limit and day boundary", () => {
  process.env.DAILY_TUTOR_LIMIT = "50";
  assert.equal(dailyTutorLimit(), 50);
  process.env.DAILY_TUTOR_LIMIT = "abc";
  assert.equal(dailyTutorLimit(), 800);
  assert.equal(startOfUtcDay(new Date("2026-10-22T23:59:00-07:00")), "2026-10-23T00:00:00.000Z");
});

test("conditions come from STUDY_CONDITIONS, ignoring unknown arms", () => {
  process.env.STUDY_CONDITIONS = "socratic, explain,bogus";
  assert.deepEqual(studyConditions(), ["socratic", "explain"]);
  delete process.env.STUDY_CONDITIONS;
  assert.deepEqual(studyConditions(), []);
  assert.equal(conditionOf("on_request"), "on_request");
  assert.equal(conditionOf(null), "socratic");
});

test("assignment fills the smallest arm first", () => {
  assert.equal(pickCondition(["socratic", "explain"], { socratic: 3, explain: 1 }), "explain");
  assert.equal(pickCondition(["socratic", "explain"], {}, () => 0.99), "explain");
  assert.equal(pickCondition(["socratic", "explain"], {}, () => 0), "socratic");
  assert.equal(pickCondition([], {}), null);
});

test("quizzes open only when switched on", () => {
  process.env.STUDY_PRETEST = "on";
  assert.equal(testOpen("pre"), true);
  assert.equal(testOpen("post"), false);
  delete process.env.STUDY_PRETEST;
  assert.equal(testOpen("pre"), false);
});

test("quiz forms are parallel and scored on the server", () => {
  assert.equal(TESTS.pre.length, TESTS.post.length);
  assert.deepEqual(TESTS.pre.map((i) => i.skill), TESTS.post.map((i) => i.skill));
  for (const it of [...TESTS.pre, ...TESTS.post]) assert.ok(it.answer >= 0 && it.answer < it.choices.length);
  assert.ok(!("answer" in publicItems("pre")[0]));
  const right = Object.fromEntries(TESTS.pre.map((i) => [i.id, i.answer]));
  assert.equal(scoreTest("pre", right).score, TESTS.pre.length);
  assert.equal(scoreTest("pre", { ...right, a1: 3, a2: null }).score, TESTS.pre.length - 2);
});
