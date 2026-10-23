import { test } from "node:test";
import assert from "node:assert/strict";
import { flight, measuredPeriod, runSeconds, sanitizeSim, simResult, swing } from "./sims.ts";

test("projectile range and peak match the textbook formulas", () => {
  const f = flight(20, 45, 0, 9.8);
  assert.ok(Math.abs(f.range - 400 / 9.8) < 1e-9);
  assert.ok(Math.abs(f.peak - 200 / 9.8 / 2) < 1e-9);
  assert.deepEqual(f.at(f.time + 5), f.at(f.time)); // stays where it landed
  // complementary angles land in the same place
  assert.ok(Math.abs(flight(15, 30, 0, 9.8).range - flight(15, 60, 0, 9.8).range) < 1e-9);
  // launched from a height, it flies further
  assert.ok(flight(10, 0, 20, 9.8).range > 0);
  assert.ok(Math.abs(flight(10, 0, 20, 9.8).time - Math.sqrt(40 / 9.8)) < 1e-9);
});

test("pendulum period is 2π√(L/g) for small swings and longer for big ones", () => {
  const small = measuredPeriod(swing(1, 5, 9.8, 10))!;
  assert.ok(Math.abs(small - 2 * Math.PI * Math.sqrt(1 / 9.8)) < 0.01, `${small}`);
  const big = measuredPeriod(swing(1, 70, 9.8, 10))!;
  assert.ok(big > small * 1.08, `${big} vs ${small}`);
  assert.ok(Math.abs(measuredPeriod(swing(4, 5, 9.8, 20))! / small - 2) < 0.01); // 4x length, 2x period
});

test("model numbers are clamped to something drawable", () => {
  const s = sanitizeSim({ kind: "projectile", height_m: -3, launches: [{ speed_ms: 1e6, angle_deg: 120, label: null }, { speed_ms: 5, angle_deg: 10, label: "b" }, { speed_ms: 5, angle_deg: 10, label: "c" }], g: null });
  assert.equal(s.kind, "projectile");
  if (s.kind === "projectile") {
    assert.equal(s.height_m, 0);
    assert.equal(s.launches.length, 2);
    assert.equal(s.launches[0].speed_ms, 200);
    assert.equal(s.launches[0].angle_deg, 90);
  }
  const p = sanitizeSim({ kind: "pendulum", lengths_m: [], amplitude_deg: 0, g: 100 });
  assert.deepEqual(p, { kind: "pendulum", lengths_m: [1], amplitude_deg: 1, g: 30 });
  assert.ok(runSeconds(p) >= 6);
});

test("results read naturally for the tutor", () => {
  assert.match(simResult({ kind: "projectile", height_m: 0, launches: [{ speed_ms: 20, angle_deg: 45, label: null }], g: null }), /landed 40\.8 m away/);
  assert.match(simResult({ kind: "pendulum", lengths_m: [1, 4], amplitude_deg: 5, g: null }), /the 1 m pendulum swung with a period of 2\.01 s; the 4 m pendulum swung with a period of 4\.02 s/);
});
