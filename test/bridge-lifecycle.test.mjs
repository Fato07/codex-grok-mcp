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
  readdir,
  readFile,
  realpath,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  applyHermeticEnv,
  hermetic,
  removeHermeticFixtureBase,
  scrubGatewayEnv,
  spyChildEnv,
} from "./hermetic-setup.mjs";
import {
  BridgeLifecycle,
  BridgeLifecycleError,
  managedChildEnvironment,
  migrateReleaseTreePermissions,
  npmCommand,
  npmLifecycleEnvironment,
  preflightLifecycleRelease,
  stageLifecycleRelease,
  startLifecycleRelease,
} from "../dist/bridge-lifecycle.js";
import {
  DEFAULT_GROK_BOT_DATA_ROOT,
  grokBotDataRoot,
  sandUserDataDir,
  TestRealDataRootError,
} from "../dist/grok-bot-client.js";
import { runBridgeCompanion } from "../dist/bridge-companion.js";
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
  companionLeasePath,
  inspectCompanionLease,
  managedCompanionMatches,
  stopManagedCompanion,
  waitForCompanionStop,
} from "../dist/bridge-runtime.js";
import { CODEX_GROK_VERSION } from "../dist/version.js";

function assertHermeticManagedChildRoot() {
  const child = managedChildEnvironment({
    CODEX_GROK_MANAGED_CONFIG_PATH: "/tmp/codex-grok-managed.json",
  });
  assert.equal(child.SAND_DATA_ROOT, hermetic.dataRoot);
  assert.equal(child.SAND_DATA_ROOT.startsWith(hermetic.base), true);
}

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
    failPreflight: undefined,
    failCurrentRelease: undefined,
    failStart: undefined,
    mutatePairingDuringPreflight: false,
    mutatePairingDuringStart: false,
    onStop: undefined,
    ownsResult: undefined,
    setCurrent(next) {
      current = next;
    },
    setFailStart(version, code, active = false) {
      controls.failStart = { version, code, active };
    },
    setFailPreflight(code, version) {
      controls.failPreflight = { code, version };
    },
    setFailCurrentRelease(code) {
      controls.failCurrentRelease = code;
    },
    setOwnsResult(value) {
      controls.ownsResult = value;
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
    currentRelease: async () => {
      if (controls.failCurrentRelease !== undefined) {
        throw new BridgeLifecycleError(controls.failCurrentRelease);
      }
      return { ...current, protocol_versions: [...current.protocol_versions] };
    },
    pairingIdentity: async () => Buffer.from(pairing),
    preflight: async (candidate) => {
      actions.push(`preflight:${candidate.version}`);
      const preflightFailure = controls.failPreflight;
      if (
        preflightFailure !== undefined &&
        (preflightFailure.version === undefined || preflightFailure.version === candidate.version)
      ) {
        throw new BridgeLifecycleError(preflightFailure.code);
      }
      if (controls.mutatePairingDuringPreflight) controls.mutatePairing();
    },
    start: async (candidate) => {
      actions.push(`start:${candidate.version}`);
      if (controls.mutatePairingDuringStart) controls.mutatePairing();
      const failure = controls.failStart;
      if (failure !== undefined && (failure.version === "*" || failure.version === candidate.version)) {
        if (failure.version !== "*") controls.failStart = undefined;
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
      controls.ownsResult ??
      (processStatus.state === "active" &&
        processStatus.managed === true &&
        processStatus.companionVersion === candidate.version &&
        processStatus.releaseIntegrity === candidate.integrity),
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

async function assertBindingsAbsent(root, configPath) {
  await assert.rejects(lstat(join(root, "binding.json")), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lifecycle.json`), { code: "ENOENT" });
}

async function assertNoStagingLeftovers(root) {
  const names = await readdir(root).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(
    names.filter((name) => name.startsWith(".stage-")),
    [],
  );
  const releaseNames = await readdir(join(root, "releases")).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(
    releaseNames.filter((name) => name.startsWith(".stage-")),
    [],
  );
}

async function runDefaultLifecycle(command, environment) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "bridge-lifecycle.js")).href;
  const source = `
    import { BridgeLifecycle } from ${JSON.stringify(moduleUrl)};
    try {
      const result = await new BridgeLifecycle().run(${JSON.stringify(command)});
      process.stdout.write(JSON.stringify({ ok: true, state: result.state }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error?.code ?? error?.message, message: error?.message }) + "\\n");
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: spyChildEnv(environment),
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

test("status tightens a legacy owned lifecycle root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);

  const { lifecycle } = harness(root);
  assert.equal((await lifecycle.run("status")).state, "not_installed");
  assert.equal((await lstat(root)).mode & 0o7777, 0o700);
});

test("status does not broaden a restrictive lifecycle root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(async () => {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await chmod(root, 0o500);

  const { lifecycle } = harness(root);
  await assert.rejects(lifecycle.run("status"), { message: "lifecycle_state_invalid" });
  assert.equal((await lstat(root)).mode & 0o7777, 0o500);
});

test("status never follows a lifecycle root symlink while tightening", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  const target = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-target-"));
  context.after(async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
  await chmod(target, 0o755);
  const root = join(parent, "root");
  await symlink(target, root, "dir");

  const { lifecycle } = harness(root);
  await assert.rejects(lifecycle.run("status"), { message: "lifecycle_state_invalid" });
  assert.equal((await lstat(target)).mode & 0o7777, 0o755);
});

test("default lifecycle tightens a legacy owned config directory", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-config-mode-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const configHome = join(parent, "config");
  const configDirectory = join(configHome, "codex-grok-mcp");
  await mkdir(configDirectory, { recursive: true, mode: 0o755 });
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(parent, "data"),
    XDG_STATE_HOME: join(parent, "state"),
    SAND_DATA_ROOT: join(parent, "sand-data"),
  };
  delete environment.SAND_USER_DATA_DIR;

  const result = await runDefaultLifecycle("uninstall", environment);
  assert.deepEqual(result, {
    code: 0,
    result: { ok: true, state: "not_installed" },
  });
  assert.equal((await lstat(configDirectory)).mode & 0o7777, 0o700);
});

test("lifecycle never changes an explicit config directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDirectory = join(root, "custom-config");
  await mkdir(configDirectory, { mode: 0o755 });

  const { lifecycle } = harness(root, join(configDirectory, "bridge.json"));
  await assert.rejects(lifecycle.run("uninstall"), { message: "companion_lease_invalid" });
  assert.equal((await lstat(configDirectory)).mode & 0o7777, 0o755);
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
  const defaultConfigDir = join(parent, "config", "codex-grok-mcp");
  await mkdir(defaultConfigDir, { recursive: true, mode: 0o700 });
  await savePairingConfig(
    parsePairCode(generatePairCode("ws://127.0.0.1:9/v1/connect")),
    join(defaultConfigDir, "bridge.json"),
  );

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
      const configDir = join(environment.XDG_CONFIG_HOME, "codex-grok-mcp");
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await savePairingConfig(
        parsePairCode(generatePairCode("ws://127.0.0.1:9/v1/connect")),
        join(configDir, "bridge.json"),
      );
    } else if (protectedKind === "replay") {
      environment.XDG_STATE_HOME = join(releases, "state-home");
    } else {
      environment.SAND_DATA_ROOT = join(releases, "sand-data");
    }
    const attempt = await runDefaultLifecycle("install", environment);
    assert.equal(attempt.code, 1);
    assert.equal(attempt.result.ok, false);
    assert.equal(attempt.result.error, "lifecycle_state_invalid");
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

for (const command of ["start", "ensure", "restart", "update", "rollback"]) {
  test(`${command} recovers a stale pre-binding release before proceeding`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-migration-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config", "bridge.json");
    const { lifecycle, controls, actions } = harness(root, configPath);
    const previous = release("0.2.0-beta.5", 1);
    const exact = release("0.2.0-beta.6", 2);
    const next = release("0.2.0-beta.7", 3);
    await lifecycle.run("install");
    controls.setCurrent(exact);
    await lifecycle.run("update");
    controls.setCurrent(next);
    const stateBefore = await readFile(join(root, "state.json"), "utf8");
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

    const result = await lifecycle.run(command);
    const target = command === "update" ? next : command === "rollback" ? previous : exact;
    assert.equal(result.state, "running");
    assert.equal(result.changed, true);
    assert.equal(result.active_version, target.version);
    assert.equal(
      result.previous_version,
      command === "update" ? exact.version : command === "rollback" ? null : previous.version,
    );
    assert.deepEqual(actions.slice(before), [
      `preflight:${target.version}`,
      "recover-stale",
      `start:${target.version}`,
    ]);
    const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
    const configBinding = JSON.parse(await readFile(`${configPath}.lifecycle.json`, "utf8"));
    assert.equal(rootBinding.binding_id, configBinding.binding_id);
    if (target === exact) {
      assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
    } else {
      const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
      assert.deepEqual(state.active, target);
      assert.deepEqual(state.previous, command === "update" ? exact : null);
    }
  });
}

for (const command of ["start", "ensure", "restart"]) {
  test(`stale pre-binding ${command} fails closed before publication`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-migration-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config", "bridge.json");
    const { lifecycle, controls, actions } = harness(root, configPath);
    const exact = release("0.2.0-beta.5", 1);
    await lifecycle.run("install");
    const stateBefore = await readFile(join(root, "state.json"), "utf8");
    await unlink(join(root, "binding.json"));
    await unlink(`${configPath}.lifecycle.json`);
    controls.setStatus({
      state: "stale",
      managed: true,
      companionVersion: exact.version,
      protocolVersions: [...exact.protocol_versions],
      releaseIntegrity: exact.integrity,
    });

    actions.length = 0;
    controls.setFailPreflight("candidate_invalid");
    await assert.rejects(lifecycle.run(command), { message: "candidate_invalid" });
    assert.deepEqual(actions, ["preflight:0.2.0-beta.5"]);
    await assertBindingsAbsent(root, configPath);

    controls.failPreflight = undefined;
    actions.length = 0;
    controls.mutatePairingDuringPreflight = true;
    await assert.rejects(lifecycle.run(command), { message: "pairing_changed" });
    assert.deepEqual(actions, ["preflight:0.2.0-beta.5"]);
    await assertBindingsAbsent(root, configPath);

    controls.mutatePairingDuringPreflight = false;
    actions.length = 0;
    controls.setFailStart(exact.version, "candidate_start_failed");
    await assert.rejects(lifecycle.run(command), { message: "candidate_start_failed" });
    assert.deepEqual(actions, [
      "preflight:0.2.0-beta.5",
      "recover-stale",
      "start:0.2.0-beta.5",
    ]);
    await assertBindingsAbsent(root, configPath);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
  });
}

test("stale pre-binding recovery detects pairing changes during start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const { lifecycle, controls } = harness(root, configPath);
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
  controls.mutatePairingDuringStart = true;

  await assert.rejects(lifecycle.run("ensure"), { message: "cutover_unknown" });
  await assertBindingsAbsent(root, configPath);
});

test("stale pre-binding recovery requires the full exact release", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const { lifecycle, controls, actions } = harness(root, configPath);
  const exact = release("0.2.0-beta.5", 1);
  await lifecycle.run("install");
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  actions.length = 0;
  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: exact.version,
    protocolVersions: [1, 2, 4],
    releaseIntegrity: exact.integrity,
  });

  await assert.rejects(lifecycle.run("ensure"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
});

test("stale pre-binding recovery publishes nothing after an uncertain start", async (context) => {
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
  actions.length = 0;
  controls.setOwnsResult(false);

  await assert.rejects(lifecycle.run("ensure"), { message: "cutover_unknown" });
  assert.deepEqual(actions, [
    "preflight:0.2.0-beta.5",
    "recover-stale",
    "start:0.2.0-beta.5",
  ]);
  await assertBindingsAbsent(root, configPath);
  assert.equal((await lstat(join(root, "state.json"))).isFile(), true);
});

async function stalePreBinding(root, configPath, retained, statusOverrides = {}) {
  const setup = harness(root, configPath);
  await setup.lifecycle.run("install");
  if (retained.version !== release("0.2.0-beta.5", 1).version) {
    setup.controls.setCurrent(retained);
    await setup.lifecycle.run("update");
  }
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  setup.controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: retained.version,
    protocolVersions: [...retained.protocol_versions],
    releaseIntegrity: retained.integrity,
    ...statusOverrides,
  });
  setup.actions.length = 0;
  return setup;
}

test("update from stale preflights only the target when the retained preflight would fail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-target-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const target = release("0.2.0-beta.7", 3);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setCurrent(target);
  controls.setFailPreflight("candidate_invalid", retained.version);

  const result = await lifecycle.run("update");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, target.version);
  assert.deepEqual(actions, [`preflight:${target.version}`, "recover-stale", `start:${target.version}`]);
  assert(!actions.includes(`preflight:${retained.version}`));
  assert(!actions.includes(`start:${retained.version}`));
  const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
  const configBinding = JSON.parse(await readFile(`${configPath}.lifecycle.json`, "utf8"));
  assert.equal(rootBinding.binding_id, configBinding.binding_id);
});

test("rollback from stale preflights only the previous release", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-target-rollback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const previous = release("0.2.0-beta.5", 1);
  const retained = release("0.2.0-beta.6", 2);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setFailPreflight("candidate_invalid", retained.version);

  const result = await lifecycle.run("rollback");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, previous.version);
  assert.equal(result.previous_version, null);
  assert.deepEqual(actions, [
    `preflight:${previous.version}`,
    "recover-stale",
    `start:${previous.version}`,
  ]);
  assert(!actions.includes(`preflight:${retained.version}`));
});

test("rollback with no previous release keeps retained preflight and start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-rollback-none-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.5", 1);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);

  const result = await lifecycle.run("rollback");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, retained.version);
  assert.deepEqual(actions, [
    `preflight:${retained.version}`,
    "recover-stale",
    `start:${retained.version}`,
  ]);
  controls.setFailPreflight("candidate_invalid", retained.version);
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  controls.setStatus({
    state: "stale",
    managed: true,
    companionVersion: retained.version,
    protocolVersions: [...retained.protocol_versions],
    releaseIntegrity: retained.integrity,
  });
  actions.length = 0;
  await assert.rejects(lifecycle.run("rollback"), { message: "candidate_invalid" });
  assert.deepEqual(actions, [`preflight:${retained.version}`]);
});

test("start ensure and restart still fail when the retained preflight fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-retained-fail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.5", 1);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setFailPreflight("candidate_invalid", retained.version);
  for (const command of ["start", "ensure", "restart"]) {
    actions.length = 0;
    await assert.rejects(lifecycle.run(command), { message: "candidate_invalid" });
    assert.deepEqual(actions, [`preflight:${retained.version}`]);
    await assertBindingsAbsent(root, configPath);
  }
});

for (const command of ["update", "rollback"]) {
  test(`${command} preflight never clears a stale lease`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-preflight-lease-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config", "bridge.json");
    const retained = release("0.2.0-beta.6", 2);
    const target = command === "update" ? release("0.2.0-beta.7", 3) : release("0.2.0-beta.5", 1);
    const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
    const stateBefore = await readFile(join(root, "state.json"), "utf8");
    controls.setCurrent(target);
    controls.setFailPreflight("candidate_invalid", target.version);

    await assert.rejects(lifecycle.run(command), { message: "candidate_invalid" });
    assert.deepEqual(actions, [`preflight:${target.version}`]);
    await assertBindingsAbsent(root, configPath);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);

    controls.failPreflight = undefined;
    controls.mutatePairingDuringPreflight = true;
    actions.length = 0;
    await assert.rejects(lifecycle.run(command), { message: "pairing_changed" });
    assert.deepEqual(actions, [`preflight:${target.version}`]);
    await assertBindingsAbsent(root, configPath);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
  });
}

for (const command of ["update", "rollback"]) {
  test(`${command} rejects a stale lease that is not the retained release`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-not-ours-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, "config", "bridge.json");
    const retained = release("0.2.0-beta.6", 2);
    const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
    controls.setCurrent(release("0.2.0-beta.7", 3));
    for (const status of [
      { companionVersion: "0.2.0-beta.4" },
      { releaseIntegrity: release("0.2.0-beta.6", 9).integrity },
      { protocolVersions: [1, 2, 4] },
    ]) {
      controls.setStatus({
        state: "stale",
        managed: true,
        companionVersion: retained.version,
        protocolVersions: [...retained.protocol_versions],
        releaseIntegrity: retained.integrity,
        ...status,
      });
      actions.length = 0;
      await assert.rejects(lifecycle.run(command), { message: "companion_not_managed" });
      assert.deepEqual(actions, []);
      await assertBindingsAbsent(root, configPath);
    }
  });
}

test("failed target start from stale leaves the retained release stopped without publishing bindings", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const target = release("0.2.0-beta.7", 3);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  const stateBefore = await readFile(join(root, "state.json"), "utf8");
  controls.setCurrent(target);
  controls.setFailStart(target.version, "candidate_start_failed");

  await assert.rejects(lifecycle.run("update"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "update_failed_restored");
    return true;
  });
  assert.deepEqual(actions, [
    `preflight:${target.version}`,
    "recover-stale",
    `start:${target.version}`,
  ]);
  await assertBindingsAbsent(root, configPath);
  assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
  await assertNoStagingLeftovers(root);
  assert.equal((await lifecycle.run("status")).state, "stopped");
});

test("uncertain target start from stale publishes nothing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-uncertain-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const target = release("0.2.0-beta.7", 3);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  const stateBefore = await readFile(join(root, "state.json"), "utf8");
  controls.setCurrent(target);
  controls.setOwnsResult(false);

  await assert.rejects(lifecycle.run("update"), { message: "cutover_unknown" });
  assert.deepEqual(actions, [
    `preflight:${target.version}`,
    "recover-stale",
    `start:${target.version}`,
  ]);
  await assertBindingsAbsent(root, configPath);
  assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
});

test("same-release update from stale keeps retained preflight and start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-same-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setCurrent(retained);

  const result = await lifecycle.run("update");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, retained.version);
  assert.deepEqual(actions, [
    `preflight:${retained.version}`,
    "recover-stale",
    `start:${retained.version}`,
  ]);
});

test("version_conflict from stale fails before any action", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-version-conflict-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setCurrent(release("0.2.0-beta.6", 9));

  await assert.rejects(lifecycle.run("update"), { message: "version_conflict" });
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
});

function leaseToken() {
  return randomBytes(32).toString("base64url");
}

async function writeStaleManagedLease(configPath, candidate) {
  const lockPath = companionLeasePath(configPath);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      version: 2,
      pid: 999_999,
      process_start_id: "linux:00000000-0000-0000-0000-000000000000:1",
      owner_token: leaseToken(),
      launch_token: leaseToken(),
      mode: "managed",
      companion_version: candidate.version,
      protocol_versions: [...candidate.protocol_versions],
      release_integrity: candidate.integrity,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return lockPath;
}

async function readMaybeFile(path) {
  try {
    return (await readFile(path)).toString("base64");
  } catch (caught) {
    if (caught?.code === "ENOENT") return null;
    throw caught;
  }
}

async function listTreeModes(rootPath) {
  const entries = [];
  const walk = async (path) => {
    const details = await lstat(path);
    entries.push({
      path: relative(rootPath, path) || ".",
      mode: details.mode & 0o7777,
      symlink: details.isSymbolicLink(),
      kind: details.isDirectory() ? "dir" : details.isFile() ? "file" : "other",
    });
    if (details.isDirectory() && !details.isSymbolicLink()) {
      for (const name of (await readdir(path)).sort()) {
        await walk(join(path, name));
      }
    }
  };
  try {
    await walk(rootPath);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotOnDiskLifecycle(root, configPath) {
  return {
    leaseBytes: await readMaybeFile(companionLeasePath(configPath)),
    configBinding: await readMaybeFile(`${configPath}.lifecycle.json`),
    rootBinding: await readMaybeFile(join(root, "binding.json")),
    state: await readMaybeFile(join(root, "state.json")),
    releases: await listTreeModes(join(root, "releases")),
    companionStatus: await inspectCompanionLease(configPath),
    rootMode: (await lstat(root)).mode & 0o7777,
  };
}

test("update from stale is a no-op when target staging fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-stage-fail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const { hooks, actions } = await stalePreBinding(root, configPath, retained);
  const releasesRoot = join(root, "releases");
  const versionDir = join(releasesRoot, retained.version);
  const releaseDir = join(
    versionDir,
    Buffer.from(retained.integrity.slice("sha512-".length), "base64").toString("base64url"),
  );
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await chmod(releasesRoot, 0o700);
  await chmod(versionDir, 0o700);
  await chmod(releaseDir, 0o700);
  await writeStaleManagedLease(configPath, retained);
  await chmod(root, 0o755);
  const started = [];
  const lifecycle = new BridgeLifecycle({
    root,
    configPath,
    hooks: {
      ...hooks,
      inspect: () => inspectCompanionLease(configPath),
      currentRelease: async () => {
        throw new BridgeLifecycleError("install_failed");
      },
      recoverStale: async (candidate) => {
        actions.push("recover-stale");
        await clearStaleCompanionLease(configPath, {
          companionVersion: candidate.version,
          releaseIntegrity: candidate.integrity,
        });
      },
      start: async (candidate) => {
        started.push(candidate.version);
        actions.push(`start:${candidate.version}`);
      },
    },
  });
  const before = await snapshotOnDiskLifecycle(root, configPath);
  assert.equal(before.rootMode, 0o755);
  assert.equal(before.leaseBytes !== null, true);
  assert.equal(before.configBinding, null);
  assert.equal(before.rootBinding, null);
  assert.equal(before.companionStatus.state, "stale");

  await assert.rejects(lifecycle.run("update"), { message: "install_failed" });
  assert.deepEqual(actions, []);
  assert.deepEqual(started, []);
  const after = await snapshotOnDiskLifecycle(root, configPath);
  assert.equal(after.rootMode, 0o700);
  assert.deepEqual(
    { ...after, rootMode: before.rootMode },
    before,
  );
});

test("deferred update from stale still applies removal-safety before the switch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-stale-deferred-protect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const target = release("0.2.0-beta.7", 3);
  const { hooks, actions } = await stalePreBinding(root, configPath, retained);
  const nested = join(root, "releases", "sand-data");
  await mkdir(nested, { recursive: true, mode: 0o700 });
  const previous = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = nested;
  context.after(() => {
    if (previous === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previous;
    applyHermeticEnv();
  });
  const lifecycle = new BridgeLifecycle({
    root,
    configPath,
    hooks: {
      ...hooks,
      currentRelease: async () => target,
    },
  });
  await assert.rejects(lifecycle.run("update"), { message: "lifecycle_state_invalid" });
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
});

test("update never clears a foreign active lease", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-foreign-lease-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const retained = release("0.2.0-beta.6", 2);
  const { lifecycle, controls, actions } = await stalePreBinding(root, configPath, retained);
  controls.setCurrent(release("0.2.0-beta.7", 3));
  controls.setStatus({ state: "active", managed: false });

  await assert.rejects(lifecycle.run("update"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
});

test("install and teardown commands never revive a stale pre-binding release", async (context) => {
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
  actions.length = 0;

  for (const command of ["install", "stop", "uninstall"]) {
    await assert.rejects(lifecycle.run(command), { message: "companion_not_managed" });
  }
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
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

test("an active pre-binding release must match the full release identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-active-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const { lifecycle, controls, actions } = harness(root, configPath);
  const exact = release("0.2.0-beta.5", 1);
  await lifecycle.run("install");
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  controls.setStatus({
    state: "active",
    managed: true,
    companionVersion: exact.version,
    protocolVersions: [1, 2, 4],
    releaseIntegrity: exact.integrity,
  });
  actions.length = 0;

  await assert.rejects(lifecycle.run("ensure"), { message: "companion_not_managed" });
  assert.deepEqual(actions, []);
  await assertBindingsAbsent(root, configPath);
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
  const stateBefore = await readFile(join(root, "state.json"));
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.setFailStart("0.2.0-beta.6", "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "update_failed_restored");
    return true;
  });
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
  assert.deepEqual(await readFile(join(root, "state.json")), stateBefore);
  await assertNoStagingLeftovers(root);
});

test("a failed update start from stopped leaves the retained release stopped", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-update-stopped-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  const retained = release("0.2.0-beta.5", 1);
  const target = release("0.2.0-beta.6", 2);
  await lifecycle.run("install");
  await lifecycle.run("stop");
  const stateBefore = await readFile(join(root, "state.json"));
  controls.setCurrent(target);
  controls.setFailStart(target.version, "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "update_failed_restored");
    return true;
  });
  assert.deepEqual(actions.slice(before), [
    `preflight:${target.version}`,
    `start:${target.version}`,
  ]);
  const status = await lifecycle.run("status");
  assert.equal(status.state, "stopped");
  assert.equal(status.active_version, retained.version);
  assert.equal(status.previous_version, null);
  assert.deepEqual(await readFile(join(root, "state.json")), stateBefore);
  await assertNoStagingLeftovers(root);
});

test("a failed rollback start from running restores the retained release", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-rollback-running-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  const previous = release("0.2.0-beta.5", 1);
  const current = release("0.2.0-beta.6", 2);
  await lifecycle.run("install");
  controls.setCurrent(current);
  await lifecycle.run("update");
  const stateBefore = await readFile(join(root, "state.json"));
  controls.setFailStart(previous.version, "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("rollback"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "update_failed_restored");
    return true;
  });
  assert.deepEqual(actions.slice(before), [
    `preflight:${previous.version}`,
    "stop",
    `start:${previous.version}`,
    `start:${current.version}`,
  ]);
  const status = await lifecycle.run("status");
  assert.equal(status.state, "running");
  assert.equal(status.active_version, current.version);
  assert.equal(status.previous_version, previous.version);
  assert.deepEqual(await readFile(join(root, "state.json")), stateBefore);
  await assertNoStagingLeftovers(root);
});

test("a failed rollback start from stopped leaves the retained release stopped", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-rollback-stopped-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  const previous = release("0.2.0-beta.5", 1);
  const current = release("0.2.0-beta.6", 2);
  await lifecycle.run("install");
  controls.setCurrent(current);
  await lifecycle.run("update");
  await lifecycle.run("stop");
  const stateBefore = await readFile(join(root, "state.json"));
  controls.setFailStart(previous.version, "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("rollback"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "update_failed_restored");
    return true;
  });
  assert.deepEqual(actions.slice(before), [
    `preflight:${previous.version}`,
    `start:${previous.version}`,
  ]);
  const status = await lifecycle.run("status");
  assert.equal(status.state, "stopped");
  assert.equal(status.active_version, current.version);
  assert.equal(status.previous_version, previous.version);
  assert.deepEqual(await readFile(join(root, "state.json")), stateBefore);
  await assertNoStagingLeftovers(root);
});

test("a failed restore start from running still returns restore_failed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-restore-failed-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { lifecycle, controls, actions } = harness(root);
  await lifecycle.run("install");
  const stateBefore = await readFile(join(root, "state.json"));
  controls.setCurrent(release("0.2.0-beta.6", 2));
  controls.setFailStart("*", "candidate_start_failed");
  const before = actions.length;

  await assert.rejects(lifecycle.run("update"), (error) => {
    assert(error instanceof BridgeLifecycleError);
    assert.equal(error.code, "restore_failed");
    return true;
  });
  assert.deepEqual(actions.slice(before), [
    "preflight:0.2.0-beta.6",
    "stop",
    "start:0.2.0-beta.6",
    "start:0.2.0-beta.5",
  ]);
  assert.deepEqual(await readFile(join(root, "state.json")), stateBefore);
  await assertNoStagingLeftovers(root);
});

test("install before pairing fails with PAIRING_REQUIRED and writes nothing", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-pairing-required-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const dataHome = join(parent, "data");
  const configHome = join(parent, "config");
  const environment = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: join(parent, "state"),
    SAND_DATA_ROOT: join(parent, "sand-data"),
  };
  delete environment.SAND_USER_DATA_DIR;

  const attempt = await runDefaultLifecycle("install", environment);
  assert.equal(attempt.code, 1);
  assert.equal(attempt.result.ok, false);
  assert.equal(attempt.result.error, "PAIRING_REQUIRED");
  assert.match(attempt.result.message, /pair first/i);
  assert.deepEqual(await readdir(parent), []);

  const root = join(dataHome, "codex-grok-mcp", "companion");
  const configPath = join(configHome, "codex-grok-mcp", "bridge.json");
  await assert.rejects(lstat(join(root, "releases")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "binding.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "state.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "lifecycle-control")), { code: "ENOENT" });
  await assert.rejects(lstat(`${join(root, "lifecycle-control")}.lock`), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lifecycle.json`), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lock`), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lifecycle-control`), { code: "ENOENT" });
  await assert.rejects(lstat(`${configPath}.lifecycle-control.lock`), { code: "ENOENT" });
  await assert.rejects(lstat(companionLeasePath(configPath)), { code: "ENOENT" });
  await assertNoStagingLeftovers(root);
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

async function npmRegistryReachable() {
  try {
    const response = await fetch("https://registry.npmjs.org/", {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function registryProbeEnabled() {
  return (
    /^(true|1)$/i.test(process.env.CI ?? "") ||
    process.env.CODEX_GROK_TEST_REGISTRY === "1"
  );
}

test("staging preserves the published non-development dependency closure", async (context) => {
  if (!registryProbeEnabled()) {
    return context.skip(
      "registry probe skipped; set CI or CODEX_GROK_TEST_REGISTRY=1 to run the live shrinkwrap closure test",
    );
  }
  if (!(await npmRegistryReachable())) {
    throw new Error("registry unreachable in CI; shrinkwrap closure test cannot skip");
  }
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

test("npmCommand uses sibling npm-cli.js when npm_execpath is npx-cli.js", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-npm-npx-sibling-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const npxCli = join(root, "npx-cli.js");
  const npmCli = join(root, "npm-cli.js");
  await writeFile(npxCli, "process.exit(127);\n", { mode: 0o644 });
  await writeFile(npmCli, "process.exit(0);\n", { mode: 0o644 });
  assert.deepEqual(npmCommand(["pack", "--json"], { npm_execpath: npxCli }), {
    command: process.execPath,
    args: [npmCli, "pack", "--json"],
  });
});

test("npmCommand falls back to PATH npm when npx-cli.js has no sibling", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-npm-npx-alone-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const npxCli = join(root, "npx-cli.js");
  await writeFile(npxCli, "process.exit(127);\n", { mode: 0o644 });
  assert.deepEqual(npmCommand(["pack"], { npm_execpath: npxCli }), {
    command: "npm",
    args: ["pack"],
  });
});

test("npmCommand uses npm-cli.js npm_execpath as-is", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-npm-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = join(root, "npm-cli.js");
  await writeFile(npmCli, "process.exit(0);\n", { mode: 0o644 });
  assert.deepEqual(npmCommand(["install", "--ignore-scripts"], { npm_execpath: npmCli }), {
    command: process.execPath,
    args: [npmCli, "install", "--ignore-scripts"],
  });
});

test("npmCommand falls back for yarn, pnpm, or a relative npm_execpath", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-npm-unknown-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const yarn = join(root, "yarn.js");
  const pnpm = join(root, "pnpm.cjs");
  await writeFile(yarn, "process.exit(1);\n", { mode: 0o644 });
  await writeFile(pnpm, "process.exit(1);\n", { mode: 0o644 });
  for (const npmExecPath of [yarn, pnpm, "npm-cli.js", "npx-cli.js"]) {
    assert.deepEqual(npmCommand(["pack"], { npm_execpath: npmExecPath }), {
      command: "npm",
      args: ["pack"],
    });
  }
});

test("npmCommand falls back to PATH npm when npm_execpath is unset", () => {
  assert.deepEqual(npmCommand(["pack", "--dry-run"], {}), {
    command: "npm",
    args: ["pack", "--dry-run"],
  });
});

test("npmLifecycleEnvironment forces ignore-scripts for child npm", () => {
  assert.equal(npmLifecycleEnvironment({ PATH: "/bin" }).npm_config_ignore_scripts, "true");
});

test("candidate pack check invoked through npx-cli sibling is pack", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-npm-npx-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const npxCli = join(root, "npx-cli.js");
  const npmCli = join(root, "npm-cli.js");
  const npxLog = join(root, "npx-argv.json");
  const npmLog = join(root, "npm-argv.json");
  await writeFile(
    npxCli,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(npxLog)}, JSON.stringify(process.argv.slice(2)));
process.exit(127);
`,
    { mode: 0o644 },
  );
  await writeFile(
    npmCli,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(npmLog)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
    { mode: 0o644 },
  );
  const packageRoot = join(root, "package");
  const invoked = npmCommand(
    ["pack", "--json", "--dry-run", "--ignore-scripts", packageRoot],
    { npm_execpath: npxCli },
  );
  assert.equal(invoked.command, process.execPath);
  assert.deepEqual(invoked.args, [
    npmCli,
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
    packageRoot,
  ]);
  const child = spawn(invoked.command, invoked.args, {
    cwd: root,
    env: { PATH: process.env.PATH, TMPDIR: hermetic.base, npm_execpath: npxCli },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await readFile(npmLog, "utf8")), [
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
    packageRoot,
  ]);
  await assert.rejects(lstat(npxLog), { code: "ENOENT" });
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
  assertHermeticManagedChildRoot();
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

test("Linux lifecycle recovers a stale pre-binding process and completes upgrade and removal", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  assertHermeticManagedChildRoot();
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
  gateway.unref();
  context.after(
    () =>
      new Promise((resolve) => {
        gateway.closeAllConnections?.();
        gateway.close(() => resolve());
      }),
  );
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
  context.after(() => {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateRoot;
  });
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
    } else     if (status.state === "stale") {
      await clearStaleCompanionLease(configPath).catch(() => undefined);
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  let result = await lifecycle.run("install");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, "0.2.0-beta.4");

  // Only disposable fixture state is removed to reproduce a pre-binding installation.
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  const stateBefore = await readFile(join(root, "state.json"), "utf8");
  const releaseDirectory = join(
    root,
    "releases",
    current.version,
    Buffer.from(current.integrity.slice("sha512-".length), "base64").toString("base64url"),
  );
  const expected = {
    companionVersion: current.version,
    releaseIntegrity: current.integrity,
    releaseDirectory,
  };
  assert.equal(await managedCompanionMatches(configPath, expected), true);

  // A copied release cannot adopt the process running from the original directory.
  const copiedRoot = join(sandbox, "copied-lifecycle");
  await cp(root, copiedRoot, { recursive: true });
  await assert.rejects(new BridgeLifecycle({ root: copiedRoot, configPath }).run("ensure"), {
    message: "companion_not_managed",
  });
  await assertBindingsAbsent(copiedRoot, configPath);

  const lease = JSON.parse(await readFile(companionLeasePath(configPath), "utf8"));
  assert.equal(await managedCompanionMatches(configPath, expected), true);
  process.kill(lease.pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  let stopped = await inspectCompanionLease(configPath);
  while (stopped.state === "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stopped = await inspectCompanionLease(configPath);
  }
  assert.equal(stopped.state, "stale");
  assert.equal(stopped.managed, true);

  // Exercise the production hooks, including Linux /proc ownership and cwd checks.
  const productionLifecycle = new BridgeLifecycle({ root, configPath });
  result = await productionLifecycle.run("ensure");
  assert.equal(result.state, "running");
  assert.equal(result.changed, true);
  assert.equal(result.active_version, current.version);
  assert.equal(await managedCompanionMatches(configPath, expected), true);
  assert.deepEqual((await loadPairingConfigSnapshot(configPath)).identity, beforePairing.identity);
  assert.equal(await readFile(join(root, "state.json"), "utf8"), stateBefore);
  const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
  const configBinding = JSON.parse(await readFile(`${configPath}.lifecycle.json`, "utf8"));
  assert.equal(rootBinding.binding_id, configBinding.binding_id);
  assert.equal((await productionLifecycle.run("ensure")).changed, false);

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

test("Linux lifecycle update from stale never preflights the retained release", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  assertHermeticManagedChildRoot();
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-lifecycle-linux-update-"));
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
  gateway.unref();
  context.after(
    () =>
      new Promise((resolve) => {
        gateway.closeAllConnections?.();
        gateway.close(() => resolve());
      }),
  );
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
  context.after(() => {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateRoot;
  });
  const retained = await createFixtureRelease(root, "0.2.0-beta.4", 4);
  const target = await createFixtureRelease(root, "0.2.0-beta.5", 5);
  const preflighted = [];
  const hooks = {
    currentRelease: async () => target,
    pairingIdentity: async () => (await loadPairingConfigSnapshot(configPath)).identity,
    preflight: async (candidate) => {
      preflighted.push(candidate.version);
      if (candidate.version === retained.version) {
        throw new BridgeLifecycleError("candidate_invalid");
      }
      await preflightLifecycleRelease(root, configPath, candidate);
    },
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
  context.after(async () => {
    const status = await inspectCompanionLease(configPath).catch(() => ({ state: "stopped" }));
    if (status.state === "active" && status.managed) {
      await stopManagedCompanion(configPath).catch(() => undefined);
      await waitForCompanionStop(configPath, 5_000).catch(() => undefined);
    } else if (status.state === "stale") {
      await clearStaleCompanionLease(configPath).catch(() => undefined);
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  const bootstrap = new BridgeLifecycle({
    root,
    configPath,
    hooks: { ...hooks, currentRelease: async () => retained, preflight: (candidate) => preflightLifecycleRelease(root, configPath, candidate) },
  });
  assert.equal((await bootstrap.run("install")).state, "running");
  await unlink(join(root, "binding.json"));
  await unlink(`${configPath}.lifecycle.json`);
  const lease = JSON.parse(await readFile(companionLeasePath(configPath), "utf8"));
  process.kill(lease.pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  let stopped = await inspectCompanionLease(configPath);
  while (stopped.state === "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stopped = await inspectCompanionLease(configPath);
  }
  assert.equal(stopped.state, "stale");
  assert.equal(stopped.managed, true);

  preflighted.length = 0;
  const lifecycle = new BridgeLifecycle({ root, configPath, hooks });
  const result = await lifecycle.run("update");
  assert.equal(result.state, "running");
  assert.equal(result.active_version, target.version);
  assert.deepEqual(preflighted, [target.version]);
  assert.equal(
    await managedCompanionMatches(configPath, {
      companionVersion: target.version,
      releaseIntegrity: target.integrity,
      releaseDirectory: join(
        root,
        "releases",
        target.version,
        Buffer.from(target.integrity.slice("sha512-".length), "base64").toString("base64url"),
      ),
    }),
    true,
  );
  assert.deepEqual((await loadPairingConfigSnapshot(configPath)).identity, beforePairing.identity);
  const rootBinding = JSON.parse(await readFile(join(root, "binding.json"), "utf8"));
  const configBinding = JSON.parse(await readFile(`${configPath}.lifecycle.json`, "utf8"));
  assert.equal(rootBinding.binding_id, configBinding.binding_id);
});

test("release tree migration: restored box shape (dirs 0755, files 0600) recovers", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "release-tree-migration-"));
  const root = join(sandbox, "lifecycle");
  await mkdir(root, { recursive: true, mode: 0o700 });
  
  const testRelease = release("0.2.0-beta.8", 8);
  await createFixtureRelease(root, testRelease.version, 8);
  
  const releasesRoot = join(root, "releases");
  const versionDir = join(releasesRoot, testRelease.version);
  const releaseDir = join(
    versionDir,
    Buffer.from(testRelease.integrity.slice("sha512-".length), "base64").toString("base64url"),
  );
  
  await chmod(releasesRoot, 0o755);
  await chmod(versionDir, 0o755);
  await chmod(releaseDir, 0o755);
  
  const beforeReleases = await lstat(releasesRoot);
  const beforeVersion = await lstat(versionDir);
  const beforeRelease = await lstat(releaseDir);
  assert.equal(beforeReleases.mode & 0o777, 0o755);
  assert.equal(beforeVersion.mode & 0o777, 0o755);
  assert.equal(beforeRelease.mode & 0o777, 0o755);
  
  await migrateReleaseTreePermissions(root, testRelease);
  
  const afterReleases = await lstat(releasesRoot);
  const afterVersion = await lstat(versionDir);
  const afterRelease = await lstat(releaseDir);
  assert.equal(afterReleases.mode & 0o777, 0o700);
  assert.equal(afterVersion.mode & 0o777, 0o700);
  assert.equal(afterRelease.mode & 0o777, 0o700);
  
  await rm(sandbox, { recursive: true, force: true });
});

async function releaseTreeFixture(prefix) {
  const sandbox = await mkdtemp(join(tmpdir(), prefix));
  const root = join(sandbox, "lifecycle");
  const testRelease = release("0.2.0-beta.8", 8);
  await createFixtureRelease(root, testRelease.version, 8);
  const releasesRoot = join(root, "releases");
  const versionDir = join(releasesRoot, testRelease.version);
  const releaseDir = join(
    versionDir,
    Buffer.from(testRelease.integrity.slice("sha512-".length), "base64").toString("base64url"),
  );
  return { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir };
}

async function assertReleaseTreeRejected(root, testRelease, dirs, reason, inspection) {
  const before = await Promise.all(dirs.map((dir) => lstat(dir)));
  await assert.rejects(
    migrateReleaseTreePermissions(root, testRelease, inspection),
    (caught) => {
      assert(caught instanceof BridgeLifecycleError);
      assert.equal(caught.code, "candidate_invalid");
      assert.equal(caught.reason, reason);
      return true;
    },
  );
  const after = await Promise.all(dirs.map((dir) => lstat(dir)));
  for (const [index, details] of after.entries()) {
    assert.equal(details.mode & 0o7777, before[index].mode & 0o7777);
    assert.equal(details.uid, before[index].uid);
    assert.equal(details.isSymbolicLink(), before[index].isSymbolicLink());
  }
}

test("release tree migration: 0700 is left alone and only 0755 is migrated", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-0700-");
  await chmod(releasesRoot, 0o700);
  await chmod(versionDir, 0o700);
  await chmod(releaseDir, 0o700);
  await migrateReleaseTreePermissions(root, testRelease);
  assert.equal((await lstat(releasesRoot)).mode & 0o7777, 0o700);
  assert.equal((await lstat(versionDir)).mode & 0o7777, 0o700);
  assert.equal((await lstat(releaseDir)).mode & 0o7777, 0o700);
  await rm(sandbox, { recursive: true, force: true });
});

test("release tree migration: unexpected modes 0750, 0711, and 0705 are rejected", async () => {
  for (const mode of [0o750, 0o711, 0o705]) {
    const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
      await releaseTreeFixture(`release-tree-${mode.toString(8)}-`);
    await chmod(releaseDir, mode);
    await assertReleaseTreeRejected(
      root,
      testRelease,
      [releasesRoot, versionDir, releaseDir],
      "RELEASE_TREE_UNEXPECTED_MODE",
    );
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("release tree migration: symlinked release dir fails", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-symlink-");
  const targetDir = join(sandbox, "target");
  await mkdir(targetDir, { mode: 0o700 });
  await cp(releaseDir, join(targetDir, "release"), { recursive: true });
  await rm(releaseDir, { recursive: true });
  await symlink(join(targetDir, "release"), releaseDir);
  await assert.rejects(
    migrateReleaseTreePermissions(root, testRelease),
    (caught) => {
      assert(caught instanceof BridgeLifecycleError);
      assert.equal(caught.reason, "RELEASE_TREE_SYMLINK");
      return true;
    },
  );
  assert.equal((await lstat(releaseDir)).isSymbolicLink(), true);
  assert.equal((await lstat(releasesRoot)).mode & 0o7777, 0o700);
  assert.equal((await lstat(versionDir)).mode & 0o7777, 0o700);
  await rm(sandbox, { recursive: true, force: true });
});

test("release tree migration: special bits fail", async () => {
  for (const mode of [0o4755, 0o2755, 0o1755]) {
    const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
      await releaseTreeFixture(`release-tree-special-${mode.toString(8)}-`);
    await chmod(releaseDir, mode);
    await assertReleaseTreeRejected(
      root,
      testRelease,
      [releasesRoot, versionDir, releaseDir],
      "RELEASE_TREE_SPECIAL_BITS",
    );
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("release tree migration: group-writable fails", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-group-");
  await chmod(releaseDir, 0o775);
  await assertReleaseTreeRejected(
    root,
    testRelease,
    [releasesRoot, versionDir, releaseDir],
    "RELEASE_TREE_GROUP_WRITABLE",
  );
  await rm(sandbox, { recursive: true, force: true });
});

test("release tree migration: mixed 0755/0755/0775 is rejected without chmod", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-mixed-775-");
  await chmod(releasesRoot, 0o755);
  await chmod(versionDir, 0o755);
  await chmod(releaseDir, 0o775);
  await assertReleaseTreeRejected(
    root,
    testRelease,
    [releasesRoot, versionDir, releaseDir],
    "RELEASE_TREE_GROUP_WRITABLE",
  );
  await rm(sandbox, { recursive: true, force: true });
});

test("release tree migration: world-writable fails", async () => {
  for (const mode of [0o757, 0o777]) {
    const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
      await releaseTreeFixture(`release-tree-world-${mode.toString(8)}-`);
    await chmod(releaseDir, mode);
    await assertReleaseTreeRejected(
      root,
      testRelease,
      [releasesRoot, versionDir, releaseDir],
      "RELEASE_TREE_WORLD_WRITABLE",
    );
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("hermetic scrub removes inherited gateway env before SAND_DATA_ROOT is set", (context) => {
  assertHermeticManagedChildRoot();
  context.after(() => applyHermeticEnv());
  process.env.SAND_HOST_PORT = "1340";
  process.env.SAND_GATEWAY_BIND_HOST = "0.0.0.0";
  process.env.GROKBOT_GATEWAY_URL = "http://127.0.0.1:9";
  const env = { ...process.env };
  scrubGatewayEnv(env);
  assert.equal(env.SAND_HOST_PORT, undefined);
  assert.equal(env.SAND_GATEWAY_BIND_HOST, undefined);
  assert.equal(env.GROKBOT_GATEWAY_URL, undefined);
  env.SAND_DATA_ROOT = hermetic.dataRoot;
  process.env.SAND_HOST_PORT = "1340";
  process.env.SAND_GATEWAY_BIND_HOST = "0.0.0.0";
  scrubGatewayEnv();
  process.env.SAND_DATA_ROOT = hermetic.dataRoot;
  const child = managedChildEnvironment({ CODEX_GROK_MANAGED_CONFIG_PATH: "managed" });
  assert.equal(child.SAND_HOST_PORT, undefined);
  assert.equal(child.SAND_GATEWAY_BIND_HOST, undefined);
  assert.equal(child.SAND_DATA_ROOT, hermetic.dataRoot);
});

test("production managed child environment still forwards the gateway allowlist", (context) => {
  context.after(() => applyHermeticEnv());
  process.env.HOME = process.env.HOME ?? "/tmp";
  process.env.TMPDIR = hermetic.base;
  process.env.SAND_DATA_ROOT = hermetic.dataRoot;
  process.env.SAND_USER_DATA_DIR = hermetic.base;
  process.env.GROKBOT_GATEWAY_URL = "http://127.0.0.1:9";
  process.env.SAND_GATEWAY_URL = "http://127.0.0.1:9";
  process.env.SAND_GATEWAY_BIND_HOST = "127.0.0.1";
  process.env.SAND_HOST_PORT = "9";
  process.env.SAND_GATEWAY_TOKEN = "allowlist-token";
  const child = managedChildEnvironment({ CODEX_GROK_MANAGED_CONFIG_PATH: "managed" });
  for (const name of [
    "SAND_DATA_ROOT",
    "SAND_USER_DATA_DIR",
    "GROKBOT_GATEWAY_URL",
    "SAND_GATEWAY_URL",
    "SAND_GATEWAY_BIND_HOST",
    "SAND_HOST_PORT",
    "SAND_GATEWAY_TOKEN",
  ]) {
    assert.equal(Object.hasOwn(child, name), true);
  }
});

test("hermetic guard rejects the real Grok Bot data root", () => {
  assert.throws(
    () => grokBotDataRoot({ SAND_DATA_ROOT: DEFAULT_GROK_BOT_DATA_ROOT }),
    (caught) => caught instanceof TestRealDataRootError,
  );
  assert.throws(
    () => grokBotDataRoot({ SAND_USER_DATA_DIR: "/home/box" }),
    (caught) => caught instanceof TestRealDataRootError,
  );
});

test("install and update preflight propagate GATEWAY_ENV_MISMATCH", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-gateway-mismatch-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "lifecycle");
  const dataRoot = join(sandbox, "sand-data");
  const configPath = join(sandbox, "config", "bridge.json");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataRoot, "gateway.json"),
    `${JSON.stringify({
      port: 1340,
      pid: 2468,
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
  const candidate = await createFixtureRelease(root, "0.2.0-beta.8", 8);
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousPort = process.env.SAND_HOST_PORT;
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.SAND_HOST_PORT = "9999";
  context.after(() => {
    if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousPort === undefined) delete process.env.SAND_HOST_PORT;
    else process.env.SAND_HOST_PORT = previousPort;
    applyHermeticEnv();
  });
  const setup = harness(root, configPath);
  let preflightImpl = (release) => preflightLifecycleRelease(root, configPath, release);
  setup.controls.setCurrent(candidate);
  const lifecycle = new BridgeLifecycle({
    root,
    configPath,
    hooks: {
      ...setup.hooks,
      preflight: (release) => preflightImpl(release),
    },
  });
  await assert.rejects(lifecycle.run("install"), (caught) => {
    assert(caught instanceof BridgeLifecycleError);
    assert.equal(caught.code, "candidate_invalid");
    assert.equal(caught.reason, "GATEWAY_ENV_MISMATCH");
    return true;
  });
  setup.controls.setCurrent(release("0.2.0-beta.5", 1));
  preflightImpl = async () => undefined;
  await lifecycle.run("install");
  setup.controls.setCurrent(candidate);
  preflightImpl = (release) => preflightLifecycleRelease(root, configPath, release);
  await assert.rejects(lifecycle.run("update"), (caught) => {
    assert(caught instanceof BridgeLifecycleError);
    assert.equal(caught.code, "candidate_invalid");
    assert.equal(caught.reason, "GATEWAY_ENV_MISMATCH");
    return true;
  });
});

test("box-like inherited env still uses the fixture data root", (context) => {
  context.after(() => applyHermeticEnv());
  process.env.SAND_HOST_PORT = "1340";
  process.env.SAND_GATEWAY_BIND_HOST = "0.0.0.0";
  assert.equal(grokBotDataRoot(), hermetic.dataRoot);
});

test("TMPDIR 0777 fails fast with insecure_config_directory", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-tmp-insecure-"));
  const unsafe = join(parent, "tmp");
  await mkdir(unsafe, { mode: 0o777 });
  await chmod(unsafe, 0o777);
  context.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    savePairingConfig(
      parsePairCode(generatePairCode("ws://127.0.0.1:9/v1/connect")),
      join(unsafe, "bridge.json"),
    ),
    { message: "insecure_config_directory" },
  );
});

test("release tree migration: foreign-owned dir is rejected via uid seam", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-foreign-");
  await chmod(releasesRoot, 0o755);
  await chmod(versionDir, 0o755);
  await chmod(releaseDir, 0o755);
  await assertReleaseTreeRejected(
    root,
    testRelease,
    [releasesRoot, versionDir, releaseDir],
    "RELEASE_TREE_FOREIGN_OWNED",
    { uid: () => (process.getuid?.() ?? 1000) + 1 },
  );
  await rm(sandbox, { recursive: true, force: true });
});

test("release tree migration: foreign-owned inner under 0755 parents is rejected without chmod", async () => {
  const { sandbox, root, testRelease, releasesRoot, versionDir, releaseDir } =
    await releaseTreeFixture("release-tree-foreign-inner-");
  await chmod(releasesRoot, 0o755);
  await chmod(versionDir, 0o755);
  await chmod(releaseDir, 0o755);
  await assertReleaseTreeRejected(
    root,
    testRelease,
    [releasesRoot, versionDir, releaseDir],
    "RELEASE_TREE_FOREIGN_OWNED",
    {
      lstat: async (path) => {
        const details = await lstat(path);
        if (path === releaseDir) {
          Object.defineProperty(details, "uid", {
            value: (process.getuid?.() ?? 1000) + 1,
          });
        }
        return details;
      },
    },
  );
  await rm(sandbox, { recursive: true, force: true });
});

const PINNED_MANAGED_CHILD_ALLOWLIST = [
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SAND_DATA_ROOT",
  "GROKBOT_GATEWAY_URL",
  "SAND_GATEWAY_URL",
  "SAND_GATEWAY_BIND_HOST",
  "SAND_HOST_PORT",
  "SAND_GATEWAY_TOKEN",
];

function pinnedManagedChildEnvironment(extra) {
  const environment = {};
  for (const name of PINNED_MANAGED_CHILD_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const userRoot = sandUserDataDir(process.env);
  if (userRoot !== undefined) environment.SAND_USER_DATA_DIR = userRoot;
  return { ...environment, ...extra };
}

test("managed child environment without the hermetic flag is byte-identical to the pinned allowlist", (context) => {
  context.after(() => applyHermeticEnv());
  delete process.env.CODEX_GROK_TEST_HERMETIC;
  process.env.HOME = process.env.HOME ?? "/tmp";
  process.env.TMPDIR = hermetic.base;
  process.env.SAND_DATA_ROOT = hermetic.dataRoot;
  process.env.SAND_USER_DATA_DIR = hermetic.base;
  process.env.GROKBOT_GATEWAY_URL = "http://127.0.0.1:9";
  process.env.SAND_GATEWAY_URL = "http://127.0.0.1:9";
  process.env.SAND_GATEWAY_BIND_HOST = "127.0.0.1";
  process.env.SAND_HOST_PORT = "9";
  process.env.SAND_GATEWAY_TOKEN = "allowlist-token";
  const extra = { CODEX_GROK_MANAGED_CONFIG_PATH: "managed" };
  const child = managedChildEnvironment(extra);
  const pinned = pinnedManagedChildEnvironment(extra);
  assert.equal(Buffer.from(JSON.stringify(child)).equals(Buffer.from(JSON.stringify(pinned))), true);
  assert.equal(Object.hasOwn(child, "CODEX_GROK_TEST_HERMETIC"), false);
  assert.deepEqual(Object.keys(child).sort(), Object.keys(pinned).sort());
});

test("managed child environment trims SAND_USER_DATA_DIR the same way as grokBotDataRoot", (context) => {
  context.after(() => applyHermeticEnv());
  process.env.SAND_USER_DATA_DIR = `  ${hermetic.base}  `;
  const child = managedChildEnvironment({ CODEX_GROK_MANAGED_CONFIG_PATH: "managed" });
  assert.equal(child.SAND_USER_DATA_DIR, hermetic.base);
});

test("managed child environment forwards the hermetic flag only when the parent has it", (context) => {
  context.after(() => applyHermeticEnv());
  const extra = { CODEX_GROK_MANAGED_CONFIG_PATH: "managed" };
  process.env.CODEX_GROK_TEST_HERMETIC = "1";
  const withFlag = managedChildEnvironment(extra);
  assert.equal(withFlag.CODEX_GROK_TEST_HERMETIC, "1");
  assert.equal(Object.hasOwn(withFlag, "NODE_OPTIONS"), false);
  delete process.env.CODEX_GROK_TEST_HERMETIC;
  const withoutFlag = managedChildEnvironment(extra);
  assert.equal(Object.hasOwn(withoutFlag, "CODEX_GROK_TEST_HERMETIC"), false);
  assert.equal(Object.hasOwn(withoutFlag, "NODE_OPTIONS"), false);
});

test("managed child with hermetic flag and real root fails before any read or connect", async () => {
  const previous = process.exitCode;
  const extra = { CODEX_GROK_MANAGED_CONFIG_PATH: "/tmp/codex-grok-managed.json" };
  const childEnv = managedChildEnvironment(extra);
  assert.equal(childEnv.CODEX_GROK_TEST_HERMETIC, "1");
  childEnv.SAND_DATA_ROOT = DEFAULT_GROK_BOT_DATA_ROOT;
  const clientUrl = pathToFileURL(join(process.cwd(), "dist", "grok-bot-client.js")).href;
  const source = `
    import { LocalGrokBotClient } from ${JSON.stringify(clientUrl)};
    let readOrConnect = false;
    try {
      new LocalGrokBotClient({
        env: process.env,
        fetch: async () => {
          readOrConnect = true;
          throw new Error("fetch");
        },
        verifyServer: () => {
          readOrConnect = true;
          return false;
        },
      });
      process.stdout.write(JSON.stringify({ ok: true, readOrConnect }) + "\\n");
    } catch (caught) {
      process.stdout.write(
        JSON.stringify({
          name: caught?.name,
          reason: caught?.reason,
          message: caught?.message,
          readOrConnect,
        }) + "\\n",
      );
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: spyChildEnv({ PATH: process.env.PATH, ...childEnv }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "exit");
  process.exitCode = previous;
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  assert.equal(code, 1);
  assert.equal(result.name, "TestRealDataRootError");
  assert.equal(result.reason, "TEST_REAL_DATA_ROOT");
  assert.equal(result.readOrConnect, false);
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("hermetic fixture cleanup never follows a replaced base symlink", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-grok-hermetic-rm-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const decoy = join(parent, "decoy");
  await mkdir(decoy, { mode: 0o700 });
  const keep = join(decoy, "keep");
  await writeFile(keep, "keep\n", { mode: 0o600 });
  const base = join(parent, "codex-grok-hermetic-link");
  await symlink(decoy, base);
  removeHermeticFixtureBase(base);
  await assert.rejects(lstat(base), { code: "ENOENT" });
  assert.equal(await readFile(keep, "utf8"), "keep\n");
});

test("hermetic setup removes its fixture base on process exit", async () => {
  const setupUrl = pathToFileURL(join(process.cwd(), "test", "hermetic-setup.mjs")).href;
  const source = `
    import { hermetic } from ${JSON.stringify(setupUrl)};
    process.stdout.write(hermetic.base + "\\n");
  `;
  const childEnv = { ...process.env };
  delete childEnv.CODEX_GROK_TEST_HERMETIC;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: spyChildEnv(childEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const base = Buffer.concat(stdout).toString("utf8").trim();
  assert.match(base, /codex-grok-hermetic-/);
  await assert.rejects(lstat(base), { code: "ENOENT" });
});
