import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("roster fingerprint source hashes only id and name", () => {
  const source = readFileSync(new URL("../src/grok-bot-gateway.ts", import.meta.url), "utf8");
  const match = source.match(/export function rosterFingerprint\([\s\S]*?\n\}/);
  assert(match, "rosterFingerprint source not found");
  assert.match(match[0], /\(\{ id, name \}\)/);
  assert.doesNotMatch(match[0], /is_running/);
});
