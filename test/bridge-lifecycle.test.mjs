import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BridgeLifecycle,
  BridgeLifecycleError,
  preflightLifecycleRelease,
  stageLifecycleRelease,
  startLifecycleRelease,
} from "../dist/bridge-lifecycle.js";
import {
  generatePairCode,
  loadPairingConfigSnapshot,
  parsePairCode,
  savePairingConfig,
} from "../dist/bridge-pairing.js";
import {
  clearStaleCompanionLease,
  clearStaleForegroundCompanionLease,
  inspectCompanionLease,
  stopManagedCompanion,
  waitForCompanionStop,
} from "../dist/bridge-runtime.js";
import { CODEX_GROK_VERSION } from "../dist/version.js";

function release(version, byte) {
  return {
    version,
    integrity: `sha512-${Buffer.alloc(64, byte).toString("base64")}`,
    protocol_versions: [1, 2, 3],
  };
}

function harness(root) {
  let current = release("0.2.0-beta.5", 1);
  let processStatus = { state: "stopped" };
  let pairing = Buffer.from("pairing-a");
  const actions = [];
  const controls = {
    failStart: undefined,
    mutatePairingDuringPreflight: false,
    onStop: undefined,
    setCurrent(next) {
      current = next;
    },
    setFailStart(version, code, active = false) {
      controls.failStart = { version, code, active };
    },
    setStatus(status) {
      processStatus = status;
    },
    setOnStop(callback) {
      controls.onStop = callback;
    },
    mutatePairing() {
      pairing = Buffer.from("pairing-b");
    },
  };
  const hooks = {
    currentRelease: async () => ({ ...current, protocol_versions: [...current.protocol_versions] }),
    pairingIdentity: async () => Buffer.from(pairing),
    preflight: async (candidate) => {
      actions.push(`preflight:${candidate.version}`);
      if (controls.mutatePairingDuringPreflight) controls.mutatePairing();
    },
    start: async (candidate) => {
      actions.push(`start:${candidate.version}`);
      const failure = controls.failStart;
      if (failure?.version === candidate.version) {
        controls.failStart = undefined;
        if (failure.active) {
          processStatus = {
            state: "active",
            managed: true,
            companionVersion: candidate.version,
            protocolVersions: [...candidate.protocol_versions],
            releaseIntegrity: candidate.integrity,
          };
        }
        throw new BridgeLifecycleError(failure.code);
      }
      processStatus = {
        state: "active",
        managed: true,
        companionVersion: candidate.version,
        protocolVersions: [...candidate.protocol_versions],
        releaseIntegrity: candidate.integrity,
      };
    },
    inspect: async () => processStatus,
    recoverStale: async () => {
      actions.push("recover-stale");
      processStatus = { state: "stopped" };
    },
    recoverForegroundStale: async () => {
      actions.push("recover-foreground-stale");
      processStatus = { state: "stopped" };
    },
    stop: async () => {
      actions.push("stop");
      processStatus = { state: "stopped" };
      await controls.onStop?.();
    },
  };
  return {
    actions,
    controls,
    lifecycle: new BridgeLifecycle({ root, hooks }),
  };
}

test("managed lifecycle is idempotent and preserves exact current/previous releases", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls } = harness(root);
  const v1 = release("0.2.0-beta.5", 1);
  const v2 = release("0.2.0-beta.6", 2);

  assert.deepEqual(await lifecycle.run("status"), {
    command: "status",
    state: "not_installed",
    changed: false,
    active_version: null,
    previous_version: null,
    protocol_versions: [],
    pairing_valid: true,
  });

  let result = await lifecycle.run("install");
  assert.equal(result.state, "running");
  assert.equal(result.changed, true);
  assert.equal(result.active_version, v1.version);
  assert.equal(result.previous_version, null);
  assert.deepEqual(result.protocol_versions, [1, 2, 3]);
  assert.equal((await lstat(root)).mode & 0o7777, 0o700);
  assert.equal((await lstat(join(root, "state.json"))).mode & 0o7777, 0o600);
  assert(!String(await readFile(join(root, "state.json"))).includes("pairing-a"));

  assert.equal((await lifecycle.run("start")).changed, false);
  assert.equal((await lifecycle.run("ensure")).changed, false);

  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: v1.version,
    protocolVersions: [...v1.protocol_versions],
    releaseIntegrity: v1.integrity,
  });
  assert.equal((await lifecycle.run("ensure")).changed, true);

  controls.setCurrent(release("0.2.0-beta.5", 9));
  await assert.rejects(lifecycle.run("update"), { message: "version_conflict" });

  controls.setCurrent(v2);
  result = await lifecycle.run("update");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, v2.version);
  assert.equal(result.previous_version, v1.version);

  assert.equal((await lifecycle.run("restart")).changed, true);
  result = await lifecycle.run("rollback");
  assert.equal(result.active_version, v1.version);
  assert.equal(result.previous_version, null);
  assert.equal((await lifecycle.run("rollback")).changed, false);

  result = await lifecycle.run("stop");
  assert.equal(result.state, "stopped");
  assert.equal(result.changed, true);
  assert.equal((await lifecycle.run("stop")).changed, false);
  result = await lifecycle.run("start");
  assert.equal(result.state, "running");
  assert.equal(result.changed, true);
});

test("uninstall stops only the managed companion and removes only managed lifecycle data", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "companion");
  const unrelated = join(parent, "keep.txt");
  const { lifecycle, actions } = harness(root);
  await lifecycle.run("install");
  await mkdir(join(root, "releases", "owned"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "releases", "owned", "release.txt"), "owned\n", {
    mode: 0o600,
  });
  await writeFile(unrelated, "keep\n", { mode: 0o600 });

  const result = await lifecycle.run("uninstall");
  assert.deepEqual(result, {
    command: "uninstall",
    state: "not_installed",
    changed: true,
    active_version: null,
    previous_version: null,
    protocol_versions: [],
    pairing_valid: true,
  });
  assert.equal(actions.at(-1), "stop");
  await assert.rejects(lstat(join(root, "state.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "releases")), { code: "ENOENT" });
  assert.equal(await readFile(unrelated, "utf8"), "keep\n");
  assert.equal((await lifecycle.run("uninstall")).changed, false);
});

test("uninstall refuses an unsafe release store before stopping the companion", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-unsafe-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "companion");
  const outside = join(parent, "outside");
  const { lifecycle, actions } = harness(root);
  await lifecycle.run("install");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "keep.txt"), "keep\n", { mode: 0o600 });
  await symlink(outside, join(root, "releases"), "dir");
  const before = actions.length;

  await assert.rejects(lifecycle.run("uninstall"), { message: "lifecycle_state_invalid" });
  assert.deepEqual(actions.slice(before), []);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n");
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

test("uninstall never stops an unmanaged companion or removes installed state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-unmanaged-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  controls.setStatus({ state: "active", managed: false });
  const before = actions.length;

  await assert.rejects(lifecycle.run("uninstall"), { message: "companion_not_managed" });
  assert.deepEqual(actions.slice(before), []);
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

test("uninstall revalidates the release store after stopping", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-race-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "companion");
  const releases = join(root, "releases");
  const outside = join(parent, "outside");
  const { lifecycle, controls } = harness(root);
  await lifecycle.run("install");
  await mkdir(join(releases, "owned"), { recursive: true, mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "keep.txt"), "keep\n", { mode: 0o600 });
  controls.setOnStop(async () => {
    await rm(releases, { recursive: true, force: true });
    await symlink(outside, releases, "dir");
  });

  await assert.rejects(lifecycle.run("uninstall"), { message: "lifecycle_state_invalid" });
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n");
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

test("install migrates a revalidated stale foreground lease into managed lifecycle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);

  controls.setStatus({ state: "stale", managed: false });
  assert.deepEqual(await lifecycle.run("status"), {
    command: "status",
    state: "stale",
    changed: false,
    active_version: null,
    previous_version: null,
    protocol_versions: [],
    pairing_valid: true,
  });
  await assert.rejects(lifecycle.run("ensure"), { message: "not_installed" });
  const result = await lifecycle.run("install");

  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.5");
  assert.equal(result.pairing_valid, true);
  assert.deepEqual(actions, [
    "preflight:0.2.0-beta.5",
    "recover-foreground-stale",
    "start:0.2.0-beta.5",
  ]);
  assert.equal((await lifecycle.run("install")).changed, false);
  assert.equal((await lifecycle.run("ensure")).changed, false);
});

test("install never reclaims an active foreground lease", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);

  controls.setStatus({ state: "active", managed: false });
  await assert.rejects(lifecycle.run("install"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
});

test("install leaves a stale foreground lease intact when preflight changes pairing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);

  controls.setStatus({ state: "stale", managed: false });
  controls.mutatePairingDuringPreflight = true;
  await assert.rejects(lifecycle.run("install"), { message: "pairing_changed" });
  assert.deepEqual(actions, ["preflight:0.2.0-beta.5"]);
});

test("install never reclaims an unknown foreground lease", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);

  controls.setStatus({ state: "unknown", managed: false });
  await assert.rejects(lifecycle.run("install"), { message: "candidate_start_failed" });
  assert.deepEqual(actions, []);
});

test("initial install recovers only an exact stale managed candidate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const exact = release("0.2.0-beta.5", 1);
  const { lifecycle, controls, actions } = harness(root);

  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: exact.version,
    protocolVersions: [...exact.protocol_versions],
    releaseIntegrity: exact.integrity,
  });
  assert.equal((await lifecycle.run("install")).state, "running");
  assert.deepEqual(actions, [
    "recover-stale",
    "preflight:0.2.0-beta.5",
    "start:0.2.0-beta.5",
  ]);

  const otherRoot = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(otherRoot, { recursive: true, force: true }));
  const other = harness(otherRoot);
  other.controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: "0.2.0-beta.4",
    protocolVersions: [1, 2, 3],
    releaseIntegrity: release("0.2.0-beta.4", 4).integrity,
  });
  await assert.rejects(other.lifecycle.run("install"), {
    message: "candidate_start_failed",
  });
  assert.deepEqual(other.actions, []);
});

test("pairing changes abort update before the running companion is stopped", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.mutatePairingDuringPreflight = true;
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), { message: "pairing_changed" });
  assert(!actions.slice(before).includes("stop"));
  const status = await lifecycle.run("status");
  assert.equal(status.state, "running");
  assert.equal(status.active_version, "0.2.0-beta.5");
});

test("a pre-activation failure restores the retained release exactly once", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.setFailStart("0.2.0-beta.6", "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), { message: "update_failed_restored" });
  assert.deepEqual(actions.slice(before), [
    "preflight:0.2.0-beta.6",
    "stop",
    "start:0.2.0-beta.6",
    "start:0.2.0-beta.5",
  ]);
  const status = await lifecycle.run("status");
  assert.equal(status.state, "running");
  assert.equal(status.active_version, "0.2.0-beta.5");
  assert.equal(status.previous_version, null);
});

test("an ambiguous activation never triggers an automatic second cutover", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.setFailStart("0.2.0-beta.6", "cutover_unknown", true);
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), { message: "cutover_unknown" });
  assert.deepEqual(actions.slice(before), [
    "preflight:0.2.0-beta.6",
    "stop",
    "start:0.2.0-beta.6",
  ]);
  const status = await lifecycle.run("status");
  assert.equal(status.state, "cutover_unknown");
  assert.equal(status.active_version, "0.2.0-beta.6");
  assert.equal(status.previous_version, "0.2.0-beta.5");

  const recovered = await lifecycle.run("update");
  assert.equal(recovered.state, "running");
  assert.equal(recovered.active_version, "0.2.0-beta.6");
  assert.equal(recovered.previous_version, "0.2.0-beta.5");
});

test("rollback restores persisted state after an ambiguous state commit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls } = harness(root);
  await lifecycle.run("install");
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.setFailStart("0.2.0-beta.6", "cutover_unknown", true);

  await assert.rejects(lifecycle.run("update"), { message: "cutover_unknown" });
  let result = await lifecycle.run("rollback");
  assert.equal(result.changed, true);
  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.5");
  assert.equal(result.previous_version, null);

  result = await lifecycle.run("rollback");
  assert.equal(result.changed, false);
  assert.equal(result.active_version, "0.2.0-beta.5");
});

test("rollback clears an exact stale ambiguous candidate before restoring persisted state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  const candidate = release("0.2.0-beta.6", 2);
  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: candidate.version,
    protocolVersions: [...candidate.protocol_versions],
    releaseIntegrity: candidate.integrity,
  });
  const before = actions.length;

  const result = await lifecycle.run("rollback");
  assert.equal(result.changed, true);
  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.5");
  assert.deepEqual(actions.slice(before), [
    "preflight:0.2.0-beta.5",
    "recover-stale",
    "start:0.2.0-beta.5",
  ]);
});

test("concurrent lifecycle mutations fail closed behind one private lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let releaseCurrent;
  let markStarted;
  const currentBlocked = new Promise((resolve) => (releaseCurrent = resolve));
  const started = new Promise((resolve) => (markStarted = resolve));
  const blocker = new BridgeLifecycle({
    root,
    hooks: {
      currentRelease: async () => {
        markStarted();
        await currentBlocked;
        return release("0.2.0-beta.5", 1);
      },
      pairingIdentity: async () => Buffer.from("pairing"),
      preflight: async () => undefined,
      start: async () => undefined,
      inspect: async () => ({ state: "stopped" }),
      recoverStale: async () => undefined,
      stop: async () => undefined,
    },
  });
  const competing = harness(root).lifecycle;
  const pending = blocker.run("install");
  await started;
  await assert.rejects(competing.run("install"), { message: "lifecycle_busy" });
  releaseCurrent();
  await pending;
});

test("staging installs the currently invoked package bytes without a registry package fetch", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-stage-current-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const packageRoot = join(sandbox, "package");
  const lifecycleRoot = join(sandbox, "lifecycle");
  await mkdir(join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "codex-grok-mcp",
      version: CODEX_GROK_VERSION,
      type: "module",
      files: ["dist"],
      bin: { "codex-grok-bridge": "dist/bridge-companion.js" },
      scripts: {
        prepack: 'node -e "require(\'node:fs\').writeFileSync(\'prepack-ran\',\'yes\')"',
        postinstall:
          'node -e "require(\'node:fs\').writeFileSync(\'postinstall-ran\',\'yes\')"',
      },
    })}\n`,
    { mode: 0o644 },
  );
  await writeFile(
    join(packageRoot, "dist", "bridge-companion.js"),
    '#!/usr/bin/env node\nprocess.stdout.write("fixture\\n");\n',
    { mode: 0o755 },
  );

  const staged = await stageLifecycleRelease(lifecycleRoot, packageRoot);
  assert.equal(staged.version, CODEX_GROK_VERSION);
  assert.match(staged.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(staged.protocol_versions, [1, 2, 3]);
  const digest = Buffer.from(staged.integrity.slice("sha512-".length), "base64").toString(
    "base64url",
  );
  const releaseRoot = join(lifecycleRoot, "releases", staged.version, digest);
  const installed = JSON.parse(
    await readFile(join(releaseRoot, "node_modules", "codex-grok-mcp", "package.json"), "utf8"),
  );
  const lock = JSON.parse(await readFile(join(releaseRoot, "package-lock.json"), "utf8"));
  assert.equal(installed.version, staged.version);
  assert.equal(lock.packages["node_modules/codex-grok-mcp"].integrity, staged.integrity);
  assert.match(lock.packages["node_modules/codex-grok-mcp"].resolved, /^file:/);
  await assert.rejects(lstat(join(releaseRoot, ".candidate")), { code: "ENOENT" });
  await assert.rejects(lstat(join(packageRoot, "prepack-ran")), { code: "ENOENT" });
  await assert.rejects(
    lstat(join(releaseRoot, "node_modules", "codex-grok-mcp", "postinstall-ran")),
    { code: "ENOENT" },
  );
});

async function createFixtureRelease(root, version, byte) {
  const candidate = release(version, byte);
  const digest = Buffer.from(candidate.integrity.slice("sha512-".length), "base64").toString(
    "base64url",
  );
  const directory = join(root, "releases", version, digest);
  const packageDirectory = join(directory, "node_modules", "codex-grok-mcp");
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await cp(join(process.cwd(), "dist"), join(packageDirectory, "dist"), { recursive: true });
  const versionPath = join(packageDirectory, "dist", "version.js");
  const versionSource = await readFile(versionPath, "utf8");
  assert.match(versionSource, /export const CODEX_GROK_VERSION = "[^"]+";/);
  await writeFile(
    versionPath,
    versionSource.replace(
      /export const CODEX_GROK_VERSION = "[^"]+";/,
      `export const CODEX_GROK_VERSION = ${JSON.stringify(version)};`,
    ),
    { mode: 0o644 },
  );
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  packageJson.version = version;
  await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify(packageJson)}\n`, {
    mode: 0o644,
  });
  for (const dependency of ["ws", "zod"]) {
    await symlink(
      join(process.cwd(), "node_modules", dependency),
      join(directory, "node_modules", dependency),
      "dir",
    );
  }
  await writeFile(join(directory, "release.json"), `${JSON.stringify(candidate)}\n`, {
    mode: 0o600,
  });
  return candidate;
}

test("Linux kills a candidate that acquires its lease then emits malformed readiness", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-failure-linux-"));
  const root = join(sandbox, "lifecycle");
  const configPath = join(sandbox, "config", "bridge.json");
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(sandbox, "config"), { mode: 0o700 });
  const candidate = await createFixtureRelease(root, "0.2.0-beta.5", 7);
  const digest = Buffer.from(candidate.integrity.slice("sha512-".length), "base64").toString(
    "base64url",
  );
  const fixtureDirectory = join(root, "releases", candidate.version, digest);
  const entry = join(
    fixtureDirectory,
    "node_modules",
    "codex-grok-mcp",
    "dist",
    "bridge-companion.js",
  );
  const candidateProcessPath = `${configPath}.candidate-process`;
  const runtimeUrl = pathToFileURL(join(process.cwd(), "dist", "bridge-runtime.js")).href;
  await writeFile(
    entry,
    `import { writeFile } from "node:fs/promises";
import { CompanionLease } from ${JSON.stringify(runtimeUrl)};
const configPath = process.env.CODEX_GROK_MANAGED_CONFIG_PATH;
const readyPath = process.env.CODEX_GROK_MANAGED_READY_PATH;
const launchToken = process.env.CODEX_GROK_MANAGED_READY_NONCE;
const lease = await CompanionLease.acquire(configPath, {
  companionVersion: ${JSON.stringify(candidate.version)},
  launchToken,
  protocolVersions: ${JSON.stringify(candidate.protocol_versions)},
  releaseIntegrity: ${JSON.stringify(candidate.integrity)},
});
const stop = async () => {
  await lease.release();
  process.exit(0);
};
process.once("SIGTERM", stop);
await writeFile(
  ${JSON.stringify(candidateProcessPath)},
  JSON.stringify({ pid: process.pid, launchToken }) + "\\n",
  { mode: 0o600 },
);
await writeFile(readyPath, JSON.stringify({ ok: false, nonce: launchToken }) + "\\n", { mode: 0o600 });
setInterval(() => {}, 1_000);
`,
    { mode: 0o644 },
  );
  context.after(async () => {
    const candidateProcess = await readFile(candidateProcessPath, "utf8")
      .then((value) => JSON.parse(value))
      .catch(() => undefined);
    const pid = candidateProcess?.pid;
    const launchToken = candidateProcess?.launchToken;
    const exactFixtureIsAlive = async () => {
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof launchToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(launchToken)
      ) {
        return false;
      }
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        const argv = (await readFile(`/proc/${pid}/cmdline`))
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        return cwd === fixtureDirectory && argv[1] === entry && argv[2] === "_managed-run";
      } catch {
        return false;
      }
    };
    if (await exactFixtureIsAlive()) process.kill(pid, "SIGTERM");
    if (Number.isSafeInteger(pid) && pid > 0) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && (await exactFixtureIsAlive())) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (await exactFixtureIsAlive()) process.kill(pid, "SIGKILL");
    }
    const status = await inspectCompanionLease(configPath).catch(() => ({ state: "stopped" }));
    if (
      status.state === "stale" &&
      status.managed &&
      status.companionVersion === candidate.version &&
      status.releaseIntegrity === candidate.integrity
    ) {
      await clearStaleCompanionLease(configPath, {
        companionVersion: candidate.version,
        releaseIntegrity: candidate.integrity,
        ...(typeof launchToken === "string" ? { launchToken } : {}),
      }).catch(() => undefined);
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  await assert.rejects(startLifecycleRelease(root, configPath, candidate), {
    message: "candidate_start_failed",
  });
  const childPid = JSON.parse(await readFile(candidateProcessPath, "utf8")).pid;
  assert.throws(
    () => process.kill(childPid, 0),
    (caught) => caught?.code === "ESRCH",
  );
  assert.deepEqual(await inspectCompanionLease(configPath), { state: "stopped" });
});

test("Linux lifecycle performs a real detached install, update, restart, and rollback", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-linux-"));
  const root = join(sandbox, "lifecycle");
  const dataRoot = join(sandbox, "sand-data");
  const configPath = join(sandbox, "config", "bridge.json");
  const stateRoot = join(sandbox, "state");
  await mkdir(root, { mode: 0o700 });
  await mkdir(dataRoot, { mode: 0o700 });
  const gateway = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ ok: true, isBusy: false }));
    else if (request.url === "/api/listAgents") response.end("[]");
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  gateway.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    gateway.once("listening", resolve);
    gateway.once("error", reject);
  });
  const address = gateway.address();
  assert(address && typeof address === "object");
  await writeFile(
    join(dataRoot, "gateway.json"),
    `${JSON.stringify({
      port: address.port,
      pid: process.pid,
      startedAt: Date.now(),
      host: "127.0.0.1",
      token: "test-gateway-token",
    })}\n`,
    { mode: 0o600 },
  );
  await savePairingConfig(
    parsePairCode(generatePairCode("ws://127.0.0.1:9/v1/connect")),
    configPath,
  );
  const beforePairing = await loadPairingConfigSnapshot(configPath);
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.XDG_STATE_HOME = stateRoot;
  let current = await createFixtureRelease(root, "0.2.0-beta.4", 4);
  const next = await createFixtureRelease(root, "0.2.0-beta.5", 5);
  const hooks = {
    currentRelease: async () => current,
    pairingIdentity: async () => (await loadPairingConfigSnapshot(configPath)).identity,
    preflight: (candidate) => preflightLifecycleRelease(root, configPath, candidate),
    start: (candidate) => startLifecycleRelease(root, configPath, candidate),
    inspect: () => inspectCompanionLease(configPath),
    recoverStale: async (candidate) => {
      await clearStaleCompanionLease(configPath, {
        companionVersion: candidate.version,
        releaseIntegrity: candidate.integrity,
      });
    },
    recoverForegroundStale: async () => {
      await clearStaleForegroundCompanionLease(configPath);
    },
    stop: async () => {
      await stopManagedCompanion(configPath);
      await waitForCompanionStop(configPath, 5_000);
    },
  };
  const lifecycle = new BridgeLifecycle({ root, hooks });
  const runtimeUrl = pathToFileURL(join(process.cwd(), "dist", "bridge-runtime.js")).href;
  const foreground = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { CompanionLease } from ${JSON.stringify(runtimeUrl)};
await CompanionLease.acquire(process.argv[1]);
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`,
      configPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  context.after(async () => {
    if (foreground.exitCode === null && foreground.signalCode === null) {
      foreground.kill("SIGKILL");
      await once(foreground, "exit").catch(() => undefined);
    }
  });
  await Promise.race([
    once(foreground.stdout, "data"),
    once(foreground, "exit").then(() => {
      throw new Error("foreground fixture exited before acquiring its lease");
    }),
  ]);
  assert.deepEqual(await inspectCompanionLease(configPath), {
    state: "active",
    managed: false,
  });
  const foregroundExited = once(foreground, "exit");
  foreground.kill("SIGKILL");
  await foregroundExited;
  assert.deepEqual(await inspectCompanionLease(configPath), {
    state: "stale",
    managed: false,
  });
  context.after(async () => {
    const status = await inspectCompanionLease(configPath).catch(() => ({ state: "stopped" }));
    if (status.state === "active" && status.managed) {
      await stopManagedCompanion(configPath).catch(() => undefined);
      await waitForCompanionStop(configPath, 5_000).catch(() => undefined);
    } else if (status.state === "stale") {
      await clearStaleCompanionLease(configPath).catch(() => undefined);
    }
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateRoot;
    await new Promise((resolve) => gateway.close(resolve));
    await rm(sandbox, { recursive: true, force: true });
  });

  let result = await lifecycle.run("install");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.4");

  current = next;
  result = await lifecycle.run("update");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.5");
  assert.equal(result.previous_version, "0.2.0-beta.4");

  result = await lifecycle.run("restart");
  assert.equal(result.state, "running");
  result = await lifecycle.run("rollback");
  assert.equal(result.active_version, "0.2.0-beta.4");
  assert.equal(result.previous_version, null);
  assert.equal((await lifecycle.run("rollback")).changed, false);

  const afterPairing = await loadPairingConfigSnapshot(configPath);
  assert.deepEqual(afterPairing.identity, beforePairing.identity);
  result = await lifecycle.run("stop");
  assert.equal(result.state, "stopped");
});
