import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = Symbol.for("codex-grok-hermetic-setup");

export function scrubGatewayEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    if (name.startsWith("SAND_") || name.startsWith("GROKBOT_")) delete env[name];
  }
}

export function removeHermeticFixtureBase(base) {
  try {
    const details = lstatSync(base);
    if (details.isSymbolicLink()) {
      unlinkSync(base);
      return;
    }
    if (!details.isDirectory()) return;
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Best effort: never follow a replaced base, and never fail the process.
  }
}

function createFixture() {
  const existing = globalThis[STATE];
  if (existing !== undefined) return existing;
  const base = mkdtempSync(join(tmpdir(), "codex-grok-hermetic-"));
  chmodSync(base, 0o700);
  const dataRoot = join(base, "sand-data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const accountHome = join(base, "home");
  mkdirSync(accountHome, { mode: 0o700 });
  const xdgConfigHome = join(accountHome, ".config");
  const xdgDataHome = join(accountHome, ".local", "share");
  const xdgStateHome = join(accountHome, ".local", "state");
  mkdirSync(xdgConfigHome, { mode: 0o700 });
  mkdirSync(xdgDataHome, { recursive: true, mode: 0o700 });
  mkdirSync(xdgStateHome, { recursive: true, mode: 0o700 });
  const defaultSandRoot = join(base, "default-sand");
  const legacySandRoot = join(base, "legacy-sand");
  mkdirSync(defaultSandRoot, { mode: 0o700 });
  mkdirSync(legacySandRoot, { mode: 0o700 });
  const state = {
    base,
    dataRoot,
    accountHome,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    defaultSandRoot,
    legacySandRoot,
  };
  globalThis[STATE] = state;
  process.on("exit", () => removeHermeticFixtureBase(base));
  return state;
}

export function applyHermeticEnv(env = process.env) {
  const fixture = createFixture();
  scrubGatewayEnv(env);
  env.SAND_DATA_ROOT = fixture.dataRoot;
  env.TMPDIR = fixture.base;
  env.HOME = fixture.accountHome;
  env.XDG_CONFIG_HOME = fixture.xdgConfigHome;
  env.XDG_DATA_HOME = fixture.xdgDataHome;
  env.XDG_STATE_HOME = fixture.xdgStateHome;
  env.CODEX_GROK_TEST_HERMETIC = "1";
  delete env.CODEX_GROK_TEST_ACCOUNT_HOME;
  return fixture;
}

export const hermetic = applyHermeticEnv();

export function spyChildEnv(env = {}) {
  const next = { ...env };
  const spy = fileURLToPath(new URL("./real-root-fs-spy.cjs", import.meta.url));
  const flag = `--require ${spy}`;
  const current = next.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "";
  if (current.includes("real-root-fs-spy") === false) {
    next.NODE_OPTIONS = current.trim() === "" ? flag : `${current} ${flag}`;
  } else if (next.NODE_OPTIONS === undefined) {
    next.NODE_OPTIONS = current;
  }
  return next;
}
