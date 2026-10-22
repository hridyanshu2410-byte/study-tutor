import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyTutorLimit, inviteOk, parseIntake, startOfUtcDay, toCsv } from "./study.ts";

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
  assert.equal(dailyTutorLimit(), 300);
  assert.equal(startOfUtcDay(new Date("2026-10-22T23:59:00-07:00")), "2026-10-23T00:00:00.000Z");
});
