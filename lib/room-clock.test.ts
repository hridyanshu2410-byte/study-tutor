import { test } from "node:test";
import assert from "node:assert/strict";
import { ClockSync, roomCode, validRoomCode } from "./room-clock.ts";

test("the clock offset comes from the fastest round trip", () => {
  const c = new ClockSync();
  // host clock is 5000 ms ahead; a slow trip with an uneven delay, then a fast one
  c.add(100, 5100 + 300, 500);
  c.add(1000, 6000 + 10, 1020);
  assert.equal(c.best()?.rtt, 20);
  assert.equal(c.toHost(2000), 7000);
});

test("room codes are eight unambiguous characters", () => {
  const code = roomCode();
  assert.ok(validRoomCode(code), code);
  assert.ok(!validRoomCode("ABCDEFGH"));
  assert.ok(!validRoomCode("abc0efgh"));
  assert.ok(!validRoomCode(null));
});
