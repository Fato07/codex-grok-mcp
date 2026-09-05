import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  CompanionLease,
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

async function createStagingPackage(packageRoot) {
  await mkdir(join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "codex-grok-mcp",
      version: CODEX_GROK_VERSION,
      type: "module",
      files: ["dist", "npm-shrinkwrap.json"],
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
    join(packageRoot, "npm-shrinkwrap.json"),
    `${JSON.stringify({
      name: "codex-grok-mcp",
      version: CODEX_GROK_VERSION,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "codex-grok-mcp",
          version: CODEX_GROK_VERSION,
        },
      },
    })}\n`,
    { mode: 0o644 },
  );
  await writeFile(
    join(packageRoot, "dist", "bridge-companion.js"),
    '#!/usr/bin/env node\nprocess.stdout.write("fixture\\n");\n',
    { mode: 0o755 },
  );
}

function harness(root, configPath = join(root, "config", "bridge.json")) {
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
    owns: async (candidate) =>
      processStatus.state === "active" &&
      processStatus.managed === true &&
      processStatus.companionVersion === candidate.version &&
      processStatus.releaseIntegrity === candidate.integrity,
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
    hooks,
    lifecycle: new BridgeLifecycle({ root, configPath, hooks }),
  };
}

async function runDefaultLifecycle(command, environment) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "bridge-lifecycle.js")).href;
  const source = `
    import { BridgeLifecycle } from ${JSON.stringify(moduleUrl)};
    try {
      const result = await new BridgeLifecycle().run(${JSON.stringify(command)});
      process.stdout.write(JSON.stringify({ ok: true, state: result.state }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error?.message }) + "\\n");
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  const [code] = await once(child, "exit");
  return {
    code,
    result: JSON.parse(Buffer.concat(output).toString("utf8")),
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

test("uninstall preserves unowned release data when state and binding are absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-unowned-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "releases", "unowned", "keep.txt");
  await mkdir(join(root, "releases", "unowned"), { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  const { lifecycle, actions } = harness(root);

  const result = await lifecycle.run("uninstall");
  assert.equal(result.changed, false);
  assert.equal(result.state, "not_installed");
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  assert.deepEqual(actions, []);
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

test("uninstall never stops a managed companion without lifecycle state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-no-state-active-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  const unrelated = release("9.9.9", 9);
  controls.setStatus({
    state: "active",
    managed: true,
    companionVersion: unrelated.version,
    protocolVersions: [...unrelated.protocol_versions],
    releaseIntegrity: unrelated.integrity,
  });

  await assert.rejects(lifecycle.run("uninstall"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
});

test("uninstall never recovers a stale managed companion without lifecycle state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-no-state-stale-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  const unrelated = release("9.9.9", 9);
  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: unrelated.version,
    protocolVersions: [...unrelated.protocol_versions],
    releaseIntegrity: unrelated.integrity,
  });

  await assert.rejects(lifecycle.run("uninstall"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
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

test("uninstall revalidates state before deleting releases", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-state-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "releases", "owned", "keep.txt");
  const { lifecycle, controls } = harness(root);
  await lifecycle.run("install");
  await mkdir(join(root, "releases", "owned"), { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  controls.setOnStop(async () => chmod(join(root, "state.json"), 0o644));

  await assert.rejects(lifecycle.run("uninstall"), { message: "lifecycle_state_invalid" });
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

test("an incomplete uninstall retains its root binding for retry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-partial-"));
  context.after(async () => {
    await chmod(join(root, "releases", "blocked"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const configPath = join(root, "config", "bridge.json");
  const blocked = join(root, "releases", "blocked");
  const { lifecycle } = harness(root, configPath);
  await lifecycle.run("install");
  await mkdir(blocked, { recursive: true, mode: 0o700 });
  await writeFile(join(blocked, "keep.txt"), "keep\n", { mode: 0o600 });
  await chmod(blocked, 0o000);

  await assert.rejects(lifecycle.run("uninstall"), { message: "uninstall_incomplete" });
  await assert.rejects(lstat(join(root, "state.json")), { code: "ENOENT" });
  assert.equal((await lstat(`${configPath}.lifecycle.json`)).isFile(), true);

  await chmod(blocked, 0o700);
  assert.equal((await lifecycle.run("uninstall")).changed, true);
  await assert.rejects(lstat(join(root, "releases")), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lifecycle.json`), { code: "ENOENT" });
});

test("lifecycle mutations reject protected config paths beneath the release store", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-protected-path-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const releases = join(root, "releases");
  const sentinel = join(releases, "keep.txt");
  const configPath = join(releases, "config", "bridge.json");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  const { lifecycle, actions } = harness(root, configPath);

  await assert.rejects(lifecycle.run("install"), { message: "lifecycle_state_invalid" });
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  assert.deepEqual(actions, []);
});

test("protected path checks resolve symlinked parent aliases", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-protected-alias-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const target = join(root, "releases", "config-home");
  const alias = join(parent, "config-alias");
  const sentinel = join(target, "keep.txt");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  await symlink(target, alias, "dir");
  const { lifecycle, actions } = harness(root, join(alias, "bridge.json"));

  await assert.rejects(lifecycle.run("install"), { message: "lifecycle_state_invalid" });
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  assert.deepEqual(actions, []);
});

test("default lifecycle rejects config, replay, and Grok data beneath releases", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-default-protected-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const dataHome = join(parent, "data");
  const lifecycleRoot = join(dataHome, "codex-grok-mcp", "companion");
  const releases = join(lifecycleRoot, "releases");
  const sentinel = join(releases, "keep.txt");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });

  for (const protectedKind of ["config", "replay", "grok-data"]) {
    const environment = {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: join(parent, "config"),
      XDG_STATE_HOME: join(parent, "state"),
      SAND_DATA_ROOT: join(parent, "sand-data"),
    };
    delete environment.SAND_USER_DATA_DIR;
    if (protectedKind === "config") {
      environment.XDG_CONFIG_HOME = join(releases, "config-home");
    } else if (protectedKind === "replay") {
      environment.XDG_STATE_HOME = join(releases, "state-home");
    } else {
      environment.SAND_DATA_ROOT = join(releases, "sand-data");
    }
    const attempt = await runDefaultLifecycle("install", environment);
    assert.equal(attempt.code, 1);
    assert.deepEqual(attempt.result, { ok: false, error: "lifecycle_state_invalid" });
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  }
});

test("a shared XDG parent does not conflict with a sibling release store", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-shared-xdg-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    XDG_DATA_HOME: parent,
    XDG_CONFIG_HOME: parent,
    XDG_STATE_HOME: parent,
    SAND_DATA_ROOT: join(parent, "sand-data"),
  };
  delete environment.SAND_USER_DATA_DIR;

  const attempt = await runDefaultLifecycle("uninstall", environment);
  assert.equal(attempt.code, 0);
  assert.deepEqual(attempt.result, { ok: true, state: "not_installed" });
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

test("initial install recovers an exact stale managed candidate only with a root binding", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const exact = release("0.2.0-beta.5", 1);
  const { lifecycle, controls, actions } = harness(root);

  await lifecycle.run("install");
  await rm(join(root, "state.json"));
  actions.length = 0;
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
    message: "companion_not_managed",
  });
  assert.deepEqual(other.actions, []);
});

test("a stale pre-binding managed state cannot claim unverifiable ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const { lifecycle, controls, actions } = harness(root, configPath);
  const exact = release("0.2.0-beta.5", 1);
  await lifecycle.run("install");
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: exact.version,
    protocolVersions: [...exact.protocol_versions],
    releaseIntegrity: exact.integrity,
  });
  const before = actions.length;

  await assert.rejects(lifecycle.run("ensure"), { message: "companion_not_managed" });
  assert.deepEqual(actions.slice(before), []);
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

test("an active exact pre-binding managed candidate establishes paired ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-active-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const { lifecycle, actions } = harness(root, configPath);
  await lifecycle.run("install");
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  const before = actions.length;

  const result = await lifecycle.run("ensure");
  assert.equal(result.state, "running");
  assert.equal(result.changed, false);
  assert.deepEqual(actions.slice(before), []);
  const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
  const configBinding = JSON.parse(
    await readFile(`${configPath}.lifecycle.json`, "utf8"),
  );
  assert.equal(rootBinding.binding_id, configBinding.binding_id);
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
  const configPath = join(root, "config", "bridge.json");
  context.after(() => rm(root, { recursive: true, force: true }));
  let releaseCurrent;
  let markStarted;
  const currentBlocked = new Promise((resolve) => (releaseCurrent = resolve));
  const started = new Promise((resolve) => (markStarted = resolve));
  const blocker = new BridgeLifecycle({
    root,
    configPath,
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
      owns: async () => false,
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

test("different lifecycle roots sharing one config serialize mutations", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-config-lock-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const rootA = join(parent, "lifecycle-a");
  const rootB = join(parent, "lifecycle-b");
  const configPath = join(parent, "config", "bridge.json");
  let releaseCurrent;
  let markStarted;
  const currentBlocked = new Promise((resolve) => (releaseCurrent = resolve));
  const started = new Promise((resolve) => (markStarted = resolve));
  const blocker = new BridgeLifecycle({
    root: rootA,
    configPath,
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
      owns: async () => false,
      recoverStale: async () => undefined,
      recoverForegroundStale: async () => undefined,
      stop: async () => undefined,
    },
  });
  const competing = harness(rootB, configPath).lifecycle;

  const pending = blocker.run("install");
  await started;
  await assert.rejects(competing.run("install"), { message: "lifecycle_busy" });
  releaseCurrent();
  await pending;
});

test("one config remains bound to one canonical lifecycle root", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-root-binding-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const configPath = join(parent, "config", "bridge.json");
  const first = harness(join(parent, "lifecycle-a"), configPath);
  const second = harness(join(parent, "lifecycle-b"), configPath);

  await first.lifecycle.run("install");
  await assert.rejects(second.lifecycle.run("install"), {
    message: "lifecycle_root_conflict",
  });
  assert.deepEqual(second.actions, []);
});

test("one lifecycle root remains bound to one canonical config", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-config-binding-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const first = harness(root, join(parent, "config-a", "bridge.json"));
  const second = harness(root, join(parent, "config-b", "bridge.json"));

  await first.lifecycle.run("install");
  await assert.rejects(second.lifecycle.run("install"), {
    message: "lifecycle_root_conflict",
  });
  await assert.rejects(second.lifecycle.run("uninstall"), {
    message: "lifecycle_root_conflict",
  });
  assert.deepEqual(second.actions, []);
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
  assert.equal((await first.lifecycle.run("status")).state, "running");
});

test("a root-only binding repairs, while a config-only binding fails closed", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-binding-repair-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const configPath = join(parent, "config", "bridge.json");
  const { lifecycle, actions } = harness(root, configPath);
  await lifecycle.run("install");
  const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));

  await unlink(`${configPath}.lifecycle.json`);
  await lifecycle.run("ensure");
  const repaired = JSON.parse(await readFile(`${configPath}.lifecycle.json`, "utf8"));
  assert.equal(repaired.binding_id, rootBinding.binding_id);

  await unlink(join(root, "binding.json"));
  const before = actions.length;
  await assert.rejects(lifecycle.run("ensure"), { message: "lifecycle_state_invalid" });
  assert.deepEqual(actions.slice(before), []);
  assert.equal((await lstat(`${configPath}.lifecycle.json`)).isFile(), true);
});

test("binding publication recovers a fully written hard-link temp", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-binding-publish-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const configPath = join(parent, "config", "bridge.json");
  const { lifecycle } = harness(root, configPath);
  await lifecycle.run("install");

  for (const binding of [join(root, "binding.json"), `${configPath}.lifecycle.json`]) {
    const temporary = join(
      dirname(binding),
      ".binding-999-0123456789abcdef.tmp",
    );
    await link(binding, temporary);
    assert.equal((await lstat(binding)).nlink, 2);
    await lifecycle.run("ensure");
    assert.equal((await lstat(binding)).nlink, 1);
    await assert.rejects(lstat(temporary), { code: "ENOENT" });
  }
});

test("binding growth fails before replacing the last valid receipt", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-binding-size-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const configPath = join(parent, "config", "bridge.json");
  const first = harness(root, configPath);
  await first.lifecycle.run("install");
  const bindingPath = join(root, "binding.json");
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  const currentReplayRoot = binding.replay_roots[0];
  let oversizedCandidate;
  for (let width = 120; width <= 320; width += 1) {
    const replayRoots = Array.from(
      { length: 15 },
      (_, index) => `/protected/${index}-${"x".repeat(width)}`,
    );
    const candidate = { ...binding, replay_roots: replayRoots };
    const beforeBytes = Buffer.byteLength(`${JSON.stringify(candidate)}\n`);
    const afterBytes = Buffer.byteLength(
      `${JSON.stringify({ ...candidate, replay_roots: [...replayRoots, currentReplayRoot] })}\n`,
    );
    if (beforeBytes <= 4_096 && afterBytes > 4_096) {
      oversizedCandidate = candidate;
      break;
    }
  }
  assert.ok(oversizedCandidate, "test fixture must straddle the binding size limit");
  const before = `${JSON.stringify(oversizedCandidate)}\n`;
  await writeFile(bindingPath, before, { mode: 0o600 });

  await assert.rejects(first.lifecycle.run("ensure"), {
    message: "lifecycle_state_invalid",
  });
  assert.equal(await readFile(bindingPath, "utf8"), before);
});

test("uninstall loses safely when another process acquires the companion lease", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-uninstall-lease-race-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "lifecycle");
  const configPath = join(parent, "config", "bridge.json");
  const { lifecycle, controls } = harness(root, configPath);
  await lifecycle.run("install");
  await mkdir(join(root, "releases", "owned"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "releases", "owned", "keep.txt"), "keep\n", {
    mode: 0o600,
  });
  let competingLease;
  controls.setOnStop(async () => {
    competingLease = await CompanionLease.acquire(configPath);
  });

  await assert.rejects(lifecycle.run("uninstall"), { message: "cutover_unknown" });
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
  assert.equal(
    await readFile(join(root, "releases", "owned", "keep.txt"), "utf8"),
    "keep\n",
  );
  assert.equal((await lstat(join(root, "binding.json"))).isFile(), true);
  await competingLease.release();
  controls.setOnStop(undefined);
  assert.equal((await lifecycle.run("uninstall")).state, "not_installed");
});

test("paired bindings persist every replay and Grok data root used by lifecycle", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-protected-binding-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousSandRoot = process.env.SAND_DATA_ROOT;
  context.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousSandRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousSandRoot;
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, "lifecycle");
  const configPath = join(parent, "config", "bridge.json");
  const replayA = join(parent, "state-a", "codex-grok-mcp", "replay");
  const grokA = join(parent, "sand-a");
  process.env.XDG_STATE_HOME = join(parent, "state-a");
  process.env.SAND_DATA_ROOT = grokA;
  const first = harness(root, configPath);
  await first.lifecycle.run("install");

  const replayB = join(parent, "state-b", "codex-grok-mcp", "replay");
  const grokB = join(parent, "sand-b");
  process.env.XDG_STATE_HOME = join(parent, "state-b");
  process.env.SAND_DATA_ROOT = grokB;
  const second = new BridgeLifecycle({ root, configPath, hooks: first.hooks });
  await second.run("ensure");

  const binding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
  const canonicalParent = await realpath(parent);
  assert.deepEqual(binding.replay_roots, [
    join(canonicalParent, "state-a", "codex-grok-mcp", "replay"),
    join(canonicalParent, "state-b", "codex-grok-mcp", "replay"),
  ]);
  assert.deepEqual(binding.grok_data_roots, [
    join(canonicalParent, "sand-a"),
    join(canonicalParent, "sand-b"),
  ]);
  const configBinding = JSON.parse(
    await readFile(`${configPath}.lifecycle.json`, "utf8"),
  );
  assert.equal(configBinding.binding_id, binding.binding_id);
  assert.equal(binding.config_path, join(canonicalParent, "config", "bridge.json"));
});

test("release removal cannot be nested inside current Grok or replay data", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-current-protected-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousSandRoot = process.env.SAND_DATA_ROOT;
  context.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousSandRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousSandRoot;
    await rm(parent, { recursive: true, force: true });
  });

  for (const kind of ["grok", "replay"]) {
    const stateHome = join(parent, `${kind}-state`);
    const grokRoot = join(parent, `${kind}-sand`);
    process.env.XDG_STATE_HOME = stateHome;
    process.env.SAND_DATA_ROOT = grokRoot;
    const protectedRoot =
      kind === "grok" ? grokRoot : join(stateHome, "codex-grok-mcp", "replay");
    const root = join(protectedRoot, "managed");
    const sentinel = join(root, "releases", "unowned", "keep.txt");
    await mkdir(dirname(sentinel), { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "keep\n", { mode: 0o600 });
    const { lifecycle, actions } = harness(
      root,
      join(parent, "config", kind, "bridge.json"),
    );

    await assert.rejects(lifecycle.run("install"), {
      message: "lifecycle_state_invalid",
    });
    assert.deepEqual(actions, []);
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  }
});

test("release removal cannot be nested inside persisted Grok or replay data", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-historical-protected-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousSandRoot = process.env.SAND_DATA_ROOT;
  context.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousSandRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousSandRoot;
    await rm(parent, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = join(parent, "current-state");
  process.env.SAND_DATA_ROOT = join(parent, "current-sand");

  for (const field of ["grok_data_roots", "replay_roots"]) {
    const caseRoot = join(parent, field);
    const root = join(caseRoot, "managed");
    const configPath = join(parent, "config", field, "bridge.json");
    const { lifecycle, actions } = harness(root, configPath);
    await lifecycle.run("install");
    const sentinel = join(root, "releases", "unowned", "keep.txt");
    await mkdir(dirname(sentinel), { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "keep\n", { mode: 0o600 });
    const bindingPath = join(root, "binding.json");
    const binding = JSON.parse(await readFile(bindingPath, "utf8"));
    binding[field] = [...binding[field], await realpath(caseRoot)];
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    const before = actions.length;

    await assert.rejects(lifecycle.run("uninstall"), {
      message: "lifecycle_state_invalid",
    });
    assert.deepEqual(actions.slice(before), []);
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
    assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
  }
});

test("staging installs the currently invoked package bytes without a registry package fetch", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-stage-current-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const packageRoot = join(sandbox, "package");
  const lifecycleRoot = join(sandbox, "lifecycle");
  await createStagingPackage(packageRoot);

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

test("staging preserves the published non-development dependency closure", async (context) => {
  const lifecycleRoot = await mkdtemp(join(tmpdir(), "codex-grok-stage-closure-"));
  context.after(() => rm(lifecycleRoot, { recursive: true, force: true }));
  const staged = await stageLifecycleRelease(lifecycleRoot);
  const digest = Buffer.from(staged.integrity.slice("sha512-".length), "base64").toString(
    "base64url",
  );
  const installedLock = JSON.parse(
    await readFile(
      join(lifecycleRoot, "releases", staged.version, digest, "package-lock.json"),
      "utf8",
    ),
  );
  const publishedLock = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8"));
  const productionRows = (lock, omitted) =>
    Object.entries(lock.packages)
      .filter(([path, value]) => path !== "" && path !== omitted && value.dev !== true)
      .map(([path, value]) => ({ path, version: value.version, integrity: value.integrity }))
      .sort((left, right) => left.path.localeCompare(right.path));

  const expected = productionRows(publishedLock);
  assert(expected.length > 0);
  assert.deepEqual(
    productionRows(installedLock, "node_modules/codex-grok-mcp"),
    expected,
  );
});

test("staging rejects package and lifecycle root overlap before mutation", async (context) => {
  for (const relation of ["lifecycle-inside-package", "package-inside-lifecycle", "same-root"]) {
    const sandbox = await mkdtemp(join(tmpdir(), `codex-grok-stage-overlap-${relation}-`));
    context.after(() => rm(sandbox, { recursive: true, force: true }));
    let packageRoot;
    let lifecycleRoot;
    if (relation === "lifecycle-inside-package") {
      packageRoot = join(sandbox, "package");
      lifecycleRoot = join(packageRoot, "dist", "managed");
    } else if (relation === "package-inside-lifecycle") {
      lifecycleRoot = join(sandbox, "lifecycle");
      packageRoot = join(lifecycleRoot, "package");
    } else {
      packageRoot = join(sandbox, "package");
      lifecycleRoot = packageRoot;
    }
    await createStagingPackage(packageRoot);

    await assert.rejects(stageLifecycleRelease(lifecycleRoot, packageRoot), {
      message: "candidate_invalid",
    });
    await assert.rejects(lstat(join(lifecycleRoot, "releases")), { code: "ENOENT" });
  }
});

test("staging resolves symlinked parents before checking package/root overlap", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-stage-alias-overlap-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const actualParent = join(sandbox, "actual");
  const packageRoot = join(actualParent, "package");
  const aliasParent = join(sandbox, "alias");
  await createStagingPackage(packageRoot);
  await symlink(actualParent, aliasParent, "dir");

  await assert.rejects(
    stageLifecycleRelease(join(packageRoot, "managed"), join(aliasParent, "package")),
    { message: "candidate_invalid" },
  );
  await assert.rejects(lstat(join(packageRoot, "managed")), { code: "ENOENT" });
});

test("staging rejects a package beneath an untrusted writable ancestor", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-stage-ancestor-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const unsafeParent = join(sandbox, "unsafe");
  const packageRoot = join(unsafeParent, "package");
  await mkdir(unsafeParent, { mode: 0o700 });
  await chmod(unsafeParent, 0o1777);
  await createStagingPackage(packageRoot);

  await assert.rejects(stageLifecycleRelease(join(sandbox, "lifecycle"), packageRoot), {
    message: "candidate_invalid",
  });
});

test("staging rejects writable package roots and packed source files", async (context) => {
  const rootWritable = await mkdtemp(join(tmpdir(), "codex-grok-stage-writable-root-"));
  const fileWritable = await mkdtemp(join(tmpdir(), "codex-grok-stage-writable-file-"));
  context.after(async () => {
    await chmod(join(rootWritable, "package"), 0o700).catch(() => undefined);
    await chmod(join(fileWritable, "package", "dist", "bridge-companion.js"), 0o700).catch(
      () => undefined,
    );
    await rm(rootWritable, { recursive: true, force: true });
    await rm(fileWritable, { recursive: true, force: true });
  });

  const writablePackageRoot = join(rootWritable, "package");
  await createStagingPackage(writablePackageRoot);
  await chmod(writablePackageRoot, 0o777);
  await assert.rejects(
    stageLifecycleRelease(join(rootWritable, "lifecycle"), writablePackageRoot),
    { message: "candidate_invalid" },
  );

  const writableFilePackageRoot = join(fileWritable, "package");
  await createStagingPackage(writableFilePackageRoot);
  await chmod(join(writableFilePackageRoot, "dist", "bridge-companion.js"), 0o777);
  await assert.rejects(
    stageLifecycleRelease(join(fileWritable, "lifecycle"), writableFilePackageRoot),
    { message: "candidate_invalid" },
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

test("Linux lifecycle performs a real detached install, update, restart, rollback, and uninstall", async (context) => {
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
    owns: async (candidate) => {
      const status = await inspectCompanionLease(configPath);
      return (
        status.state === "active" &&
        status.managed &&
        status.companionVersion === candidate.version &&
        status.releaseIntegrity === candidate.integrity
      );
    },
    recoverStale: async (candidate) => {
      await clearStaleCompanionLease(configPath, {
        companionVersion: candidate.version,
        releaseIntegrity: candidate.integrity,
      });
    },
    recoverForegroundStale: async () => {
      await clearStaleForegroundCompanionLease(configPath);
    },
    stop: async (candidate) => {
      await stopManagedCompanion(configPath, {
        companionVersion: candidate.version,
        releaseIntegrity: candidate.integrity,
      });
      await waitForCompanionStop(configPath, 5_000);
    },
  };
  const lifecycle = new BridgeLifecycle({ root, configPath, hooks });
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

  result = await lifecycle.run("uninstall");
  assert.equal(result.state, "not_installed");
  assert.equal(result.changed, true);
  assert.equal(result.active_version, null);
  assert.equal(result.previous_version, null);
  assert.deepEqual((await loadPairingConfigSnapshot(configPath)).identity, beforePairing.identity);
  await assert.rejects(lstat(join(root, "state.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "releases")), { code: "ENOENT" });
  assert.equal((await lifecycle.run("uninstall")).changed, false);
});
