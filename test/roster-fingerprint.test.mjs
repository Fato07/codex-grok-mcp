import assert from "node:assert/strict";
import { test } from "node:test";
import { rosterFingerprint } from "../dist/grok-bot-gateway.js";

test("roster fingerprint ignores volatile is_running and covers stable identity", () => {
  const idle = [
    { id: "a", name: "Ada", is_running: false },
    { id: "b", name: "Bea", is_running: null },
  ];
  const busy = idle.map((bot) => ({ ...bot, is_running: true }));
  assert.equal(rosterFingerprint(idle), rosterFingerprint(busy));
  assert.notEqual(rosterFingerprint(idle), rosterFingerprint([idle[0]]));
  assert.notEqual(
    rosterFingerprint(idle),
    rosterFingerprint([idle[0], { ...idle[1], name: "Renamed" }]),
  );
});
