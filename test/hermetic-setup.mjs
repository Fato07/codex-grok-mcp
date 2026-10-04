import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = Symbol.for("codex-grok-hermetic-setup");

export function scrubGatewayEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    if (name.startsWith("SAND_") || name.startsWith("GROKBOT_")) delete env[name];
  }
}

function createFixture() {
  const existing = globalThis[STATE];
  if (existing !== undefined) return existing;
  const base = mkdtempSync(join(tmpdir(), "codex-grok-hermetic-"));
  chmodSync(base, 0o700);
  const dataRoot = join(base, "sand-data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const state = { base, dataRoot };
  globalThis[STATE] = state;
  return state;
}

export function applyHermeticEnv(env = process.env) {
  const fixture = createFixture();
  scrubGatewayEnv(env);
  env.SAND_DATA_ROOT = fixture.dataRoot;
  env.TMPDIR = fixture.base;
  env.CODEX_GROK_TEST_HERMETIC = "1";
  return fixture;
}

export const hermetic = applyHermeticEnv();
