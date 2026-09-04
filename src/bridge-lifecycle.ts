import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  defaultBridgeConfigPath,
  loadPairingConfigSnapshot,
} from "./bridge-pairing.js";
import {
  BridgeRuntimeError,
  CompanionLease,
  clearStaleCompanionLease,
  inspectCompanionLease,
  stopManagedCompanion,
  waitForCompanionStop,
  type CompanionLeaseStatus,
} from "./bridge-runtime.js";
import {
  BRIDGE_PROTOCOL_VERSIONS,
  CODEX_GROK_VERSION,
} from "./version.js";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 4 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const PACKAGE_NAME = "codex-grok-mcp";

export type LifecycleCommand =
  | "install"
  | "start"
  | "status"
  | "stop"
  | "restart"
  | "update"
  | "rollback"
  | "ensure";

export type LifecycleRelease = {
  version: string;
  integrity: string;
  protocol_versions: number[];
};

type LifecycleState = {
  schema_version: 1;
  active: LifecycleRelease;
  previous: LifecycleRelease | null;
};

export type LifecycleResult = {
  command: LifecycleCommand;
  state:
    | "not_installed"
    | "running"
    | "stopped"
    | "stale"
    | "unmanaged"
    | "unknown"
    | "cutover_unknown";
  changed: boolean;
  active_version: string | null;
  previous_version: string | null;
  protocol_versions: number[];
  pairing_valid: boolean;
};

type ProcessResult = { stdout: string };

type LifecycleHooks = {
  currentRelease(): Promise<LifecycleRelease>;
  pairingIdentity(): Promise<Buffer>;
  preflight(release: LifecycleRelease): Promise<void>;
  start(release: LifecycleRelease): Promise<void>;
  inspect(): Promise<CompanionLeaseStatus>;
  recoverStale(release: LifecycleRelease): Promise<void>;
  stop(): Promise<void>;
};

export type LifecycleOptions = {
  configPath?: string;
  root?: string;
  hooks?: LifecycleHooks;
};

export class BridgeLifecycleError extends Error {
  readonly code:
    | "already_installed"
    | "candidate_invalid"
    | "candidate_start_failed"
    | "cutover_unknown"
    | "install_failed"
    | "lifecycle_busy"
    | "lifecycle_state_invalid"
    | "not_installed"
    | "pairing_changed"
    | "restore_failed"
    | "update_failed_restored"
    | "version_conflict";

  constructor(code: BridgeLifecycleError["code"]) {
    super(code);
    this.name = "BridgeLifecycleError";
    this.code = code;
  }
}

function fail(code: BridgeLifecycleError["code"]): never {
  throw new BridgeLifecycleError(code);
}

function isNodeError(caught: unknown): caught is NodeJS.ErrnoException {
  return caught instanceof Error && "code" in caught;
}

function exactVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  );
}

function integrityDigest(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return undefined;
  try {
    const encoded = value.slice("sha512-".length);
    const digest = Buffer.from(encoded, "base64");
    if (digest.length !== 64 || digest.toString("base64") !== encoded) return undefined;
    return digest;
  } catch {
    return undefined;
  }
}

function validRelease(value: unknown): value is LifecycleRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3 &&
    keys[0] === "integrity" &&
    keys[1] === "protocol_versions" &&
    keys[2] === "version" &&
    exactVersion(record.version) &&
    integrityDigest(record.integrity) !== undefined &&
    Array.isArray(record.protocol_versions) &&
    record.protocol_versions.length > 0 &&
    record.protocol_versions.length <= 16 &&
    record.protocol_versions.every(
      (version, index) =>
        Number.isSafeInteger(version) &&
        version > 0 &&
        (index === 0 || version > (record.protocol_versions as number[])[index - 1]!),
    )
  );
}

function sameRelease(left: LifecycleRelease, right: LifecycleRelease): boolean {
  return (
    left.version === right.version &&
    left.integrity === right.integrity &&
    JSON.stringify(left.protocol_versions) === JSON.stringify(right.protocol_versions)
  );
}

function parseState(value: unknown): LifecycleState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("lifecycle_state_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "active" ||
    keys[1] !== "previous" ||
    keys[2] !== "schema_version" ||
    record.schema_version !== STATE_VERSION ||
    !validRelease(record.active) ||
    (record.previous !== null && !validRelease(record.previous))
  ) {
    fail("lifecycle_state_invalid");
  }
  return record as LifecycleState;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") fail("lifecycle_state_invalid");
  return process.getuid();
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      details.uid !== currentUid() ||
      (details.mode & 0o7777) !== 0o700
    ) {
      fail("lifecycle_state_invalid");
    }
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    const pathDetails = await lstat(path);
    if (
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      pathDetails.uid !== currentUid() ||
      pathDetails.nlink !== 1 ||
      (pathDetails.mode & 0o7777) !== 0o600 ||
      pathDetails.size <= 0 ||
      pathDetails.size > maxBytes
    ) {
      fail("lifecycle_state_invalid");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const details = await handle.stat();
    if (
      details.dev !== pathDetails.dev ||
      details.ino !== pathDetails.ino ||
      !details.isFile() ||
      details.uid !== currentUid() ||
      details.nlink !== 1 ||
      (details.mode & 0o7777) !== 0o600 ||
      details.size <= 0 ||
      details.size > maxBytes
    ) {
      fail("lifecycle_state_invalid");
    }
    const value = await handle.readFile();
    if (value.length === 0 || value.length > maxBytes) fail("lifecycle_state_invalid");
    return value;
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    throw caught;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = join(
    dirname(path),
    `.state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    const parent = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    fail("lifecycle_state_invalid");
  }
}

export function defaultLifecycleRoot(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configuredRoot = environment.XDG_DATA_HOME;
  const root =
    configuredRoot !== undefined && configuredRoot !== "" && isAbsolute(configuredRoot)
      ? configuredRoot
      : join(homeDirectory, ".local", "share");
  return join(root, PACKAGE_NAME, "companion");
}

function statePath(root: string): string {
  return join(root, "state.json");
}

async function loadState(root: string): Promise<LifecycleState | undefined> {
  try {
    return parseState(JSON.parse((await readPrivateFile(statePath(root), MAX_STATE_BYTES)).toString("utf8")));
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return undefined;
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
}

async function saveState(root: string, state: LifecycleState): Promise<void> {
  await writePrivateJson(statePath(root), state);
}

function releaseDirectory(root: string, release: LifecycleRelease): string {
  const digest = integrityDigest(release.integrity);
  if (digest === undefined || !exactVersion(release.version)) fail("lifecycle_state_invalid");
  return join(root, "releases", release.version, digest.toString("base64url"));
}

function releaseEntry(root: string, release: LifecycleRelease): string {
  return join(
    releaseDirectory(root, release),
    "node_modules",
    PACKAGE_NAME,
    "dist",
    "bridge-companion.js",
  );
}

async function readRegularJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.uid !== currentUid() ||
      details.nlink !== 1 ||
      (details.mode & 0o022) !== 0 ||
      details.size <= 0 ||
      details.size > maxBytes
    ) {
      fail("candidate_invalid");
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  }
}

async function verifyRelease(root: string, expected: LifecycleRelease): Promise<void> {
  const directory = releaseDirectory(root, expected);
  let canonicalDirectory: string;
  try {
    const directoryDetails = await lstat(directory);
    if (
      directoryDetails.isSymbolicLink() ||
      !directoryDetails.isDirectory() ||
      directoryDetails.uid !== currentUid() ||
      (directoryDetails.mode & 0o077) !== 0
    ) {
      fail("candidate_invalid");
    }
    canonicalDirectory = await realpath(directory);
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  }
  const metadata = await readRegularJson(join(directory, "release.json"), MAX_STATE_BYTES);
  if (!validRelease(metadata) || !sameRelease(metadata, expected)) fail("candidate_invalid");
  const packageJson = await readRegularJson(
    join(directory, "node_modules", PACKAGE_NAME, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson) ||
    (packageJson as Record<string, unknown>).name !== PACKAGE_NAME ||
    (packageJson as Record<string, unknown>).version !== expected.version
  ) {
    fail("candidate_invalid");
  }
  const entry = releaseEntry(root, expected);
  try {
    const entryDetails = await lstat(entry);
    const canonicalEntry = await realpath(entry);
    const outside = relative(canonicalDirectory, canonicalEntry);
    if (
      entryDetails.isSymbolicLink() ||
      !entryDetails.isFile() ||
      entryDetails.uid !== currentUid() ||
      entryDetails.nlink !== 1 ||
      (entryDetails.mode & 0o022) !== 0 ||
      outside.startsWith("..") ||
      isAbsolute(outside)
    ) {
      fail("candidate_invalid");
    }
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcessResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (caught?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (caught === undefined) {
        resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8") });
      } else {
        rejectPromise(caught);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("child_output_limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("child_output_limit"));
      }
    });
    child.once("error", (caught) => finish(caught));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error("child_failed"));
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("child_timeout"));
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
  });
}

function npmCommand(args: string[]): { command: string; args: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && isAbsolute(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: "npm", args };
}

export async function stageLifecycleRelease(
  root: string,
): Promise<LifecycleRelease> {
  await ensurePrivateDirectory(root);
  const releasesRoot = join(root, "releases");
  await ensurePrivateDirectory(releasesRoot);
  const staging = await mkdtemp(join(root, ".stage-"));
  await chmod(staging, 0o700);
  try {
    const packageJsonPath = join(staging, "package.json");
    await writePrivateJson(packageJsonPath, {
      name: "codex-grok-mcp-managed-companion",
      private: true,
      version: "0.0.0",
    });
    const install = npmCommand([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `${PACKAGE_NAME}@${CODEX_GROK_VERSION}`,
    ]);
    await runProcess(install.command, install.args, { cwd: staging });
    const installedPackage = await readRegularJson(
      join(staging, "node_modules", PACKAGE_NAME, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
    );
    if (
      typeof installedPackage !== "object" ||
      installedPackage === null ||
      Array.isArray(installedPackage) ||
      (installedPackage as Record<string, unknown>).name !== PACKAGE_NAME ||
      (installedPackage as Record<string, unknown>).version !== CODEX_GROK_VERSION
    ) {
      fail("install_failed");
    }
    const lock = await readRegularJson(join(staging, "package-lock.json"), MAX_PACKAGE_JSON_BYTES);
    const lockPackages =
      typeof lock === "object" && lock !== null && !Array.isArray(lock)
        ? (lock as Record<string, unknown>).packages
        : undefined;
    const installedLock =
      typeof lockPackages === "object" && lockPackages !== null && !Array.isArray(lockPackages)
        ? (lockPackages as Record<string, unknown>)[`node_modules/${PACKAGE_NAME}`]
        : undefined;
    if (
      typeof installedLock !== "object" ||
      installedLock === null ||
      Array.isArray(installedLock) ||
      (installedLock as Record<string, unknown>).version !== CODEX_GROK_VERSION ||
      integrityDigest((installedLock as Record<string, unknown>).integrity) === undefined
    ) {
      fail("install_failed");
    }
    const release: LifecycleRelease = {
      version: CODEX_GROK_VERSION,
      integrity: (installedLock as Record<string, unknown>).integrity as string,
      protocol_versions: [...BRIDGE_PROTOCOL_VERSIONS],
    };
    await writePrivateJson(join(staging, "release.json"), release);
    const versionRoot = join(releasesRoot, release.version);
    await ensurePrivateDirectory(versionRoot);
    const destination = releaseDirectory(root, release);
    try {
      await lstat(destination);
      await verifyRelease(root, release);
      return release;
    } catch (caught) {
      if (!(isNodeError(caught) && caught.code === "ENOENT")) {
        if (caught instanceof BridgeLifecycleError) throw caught;
        fail("install_failed");
      }
    }
    await rename(staging, destination);
    await verifyRelease(root, release);
    return release;
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("install_failed");
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function safeChildResult(value: unknown): { version: string; protocol_versions: number[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("candidate_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "ok" ||
    keys[1] !== "protocol_versions" ||
    keys[2] !== "version" ||
    record.ok !== true ||
    !exactVersion(record.version) ||
    !Array.isArray(record.protocol_versions) ||
    record.protocol_versions.length === 0 ||
    !record.protocol_versions.every(
      (version, index) =>
        Number.isSafeInteger(version) &&
        version > 0 &&
        (index === 0 || version > (record.protocol_versions as number[])[index - 1]!),
    )
  ) {
    fail("candidate_invalid");
  }
  return {
    version: record.version,
    protocol_versions: [...record.protocol_versions] as number[],
  };
}

export async function preflightLifecycleRelease(
  root: string,
  configPath: string,
  release: LifecycleRelease,
): Promise<void> {
  await verifyRelease(root, release);
  const result = await runProcess(
    process.execPath,
    [releaseEntry(root, release), "_managed-preflight"],
    {
      cwd: releaseDirectory(root, release),
      env: managedChildEnvironment({
        CODEX_GROK_MANAGED_CONFIG_PATH: resolve(configPath),
      }),
      timeoutMs: START_TIMEOUT_MS,
    },
  ).catch(() => fail("candidate_invalid"));
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail("candidate_invalid");
  }
  const parsed = safeChildResult(value);
  if (
    parsed.version !== release.version ||
    JSON.stringify(parsed.protocol_versions) !== JSON.stringify(release.protocol_versions)
  ) {
    fail("candidate_invalid");
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function managedChildEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "SAND_DATA_ROOT",
    "SAND_USER_DATA_DIR",
    "GROKBOT_GATEWAY_URL",
    "SAND_GATEWAY_URL",
    "SAND_GATEWAY_BIND_HOST",
    "SAND_HOST_PORT",
    "SAND_GATEWAY_TOKEN",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}

async function terminateCandidate(
  child: ChildProcess,
  configPath: string,
  release: LifecycleRelease,
  launchToken: string,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    await wait(50);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.unref();
    fail("cutover_unknown");
  }
  const status = await inspectCompanionLease(configPath);
  if (status.state === "stale") {
    await clearStaleCompanionLease(configPath, {
      companionVersion: release.version,
      releaseIntegrity: release.integrity,
      launchToken,
    });
  } else if (status.state !== "stopped") {
    fail("cutover_unknown");
  }
}

export async function startLifecycleRelease(
  root: string,
  configPath: string,
  release: LifecycleRelease,
): Promise<void> {
  await verifyRelease(root, release);
  const readyRoot = await mkdtemp(join(root, ".ready-"));
  await chmod(readyRoot, 0o700);
  const readyPath = join(readyRoot, "ready.json");
  const nonce = randomBytes(32).toString("base64url");
  let child: ChildProcess;
  let spawnFailed = false;
  try {
    child = spawn(process.execPath, [releaseEntry(root, release), "_managed-run"], {
      cwd: releaseDirectory(root, release),
      detached: true,
      env: managedChildEnvironment({
        CODEX_GROK_MANAGED_CONFIG_PATH: resolve(configPath),
        CODEX_GROK_MANAGED_INTEGRITY: release.integrity,
        CODEX_GROK_MANAGED_READY_NONCE: nonce,
        CODEX_GROK_MANAGED_READY_PATH: readyPath,
      }),
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () => {
      spawnFailed = true;
    });
  } catch {
    await rm(readyRoot, { recursive: true, force: true }).catch(() => undefined);
    fail("candidate_start_failed");
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        const contents = JSON.parse(
          (await readPrivateFile(readyPath, MAX_STATE_BYTES)).toString("utf8"),
        ) as Record<string, unknown>;
        if (contents.nonce !== nonce) fail("candidate_invalid");
        const parsed = safeChildResult({
          ok: contents.ok,
          version: contents.version,
          protocol_versions: contents.protocol_versions,
        });
        const status = await inspectCompanionLease(configPath);
        if (
          parsed.version !== release.version ||
          JSON.stringify(parsed.protocol_versions) !== JSON.stringify(release.protocol_versions) ||
          status.state !== "active" ||
          !status.managed ||
          status.companionVersion !== release.version ||
          status.releaseIntegrity !== release.integrity
        ) {
          fail("candidate_invalid");
        }
        child.unref();
        return;
      } catch (caught) {
        if (!(isNodeError(caught) && caught.code === "ENOENT")) throw caught;
      }
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) {
        fail("candidate_start_failed");
      }
      await wait(100);
    }
    fail("candidate_start_failed");
  } catch (caught) {
    await terminateCandidate(child, configPath, release, nonce);
    if (caught instanceof BridgeLifecycleError && caught.code === "cutover_unknown") {
      throw caught;
    }
    fail("candidate_start_failed");
  } finally {
    await rm(readyRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pairingIdentity(configPath: string): Promise<Buffer> {
  return (await loadPairingConfigSnapshot(configPath)).identity;
}

function defaultHooks(root: string, configPath: string): LifecycleHooks {
  return {
    currentRelease: () => stageLifecycleRelease(root),
    pairingIdentity: () => pairingIdentity(configPath),
    preflight: (release) => preflightLifecycleRelease(root, configPath, release),
    start: (release) => startLifecycleRelease(root, configPath, release),
    inspect: () => inspectCompanionLease(configPath),
    recoverStale: async (release) => {
      await clearStaleCompanionLease(configPath, {
        companionVersion: release.version,
        releaseIntegrity: release.integrity,
      });
    },
    stop: async () => {
      await stopManagedCompanion(configPath);
      await waitForCompanionStop(configPath, STOP_TIMEOUT_MS);
    },
  };
}

function pairingMatches(before: Buffer, after: Buffer): boolean {
  return before.length === after.length && timingSafeEqual(before, after);
}

export class BridgeLifecycle {
  readonly #root: string;
  readonly #hooks: LifecycleHooks;

  constructor(options: LifecycleOptions = {}) {
    this.#root = resolve(options.root ?? defaultLifecycleRoot());
    const configPath = options.configPath ?? defaultBridgeConfigPath();
    this.#hooks =
      options.hooks ??
      defaultHooks(this.#root, configPath);
  }

  async run(command: LifecycleCommand): Promise<LifecycleResult> {
    await ensurePrivateDirectory(this.#root);
    if (command === "status") return await this.#result(command, false);
    let lock: CompanionLease;
    const controlPath = join(this.#root, "lifecycle-control");
    try {
      lock = await CompanionLease.acquire(controlPath);
    } catch (caught) {
      if (caught instanceof BridgeRuntimeError && caught.code === "companion_lease_stale") {
        try {
          await clearStaleCompanionLease(controlPath);
          lock = await CompanionLease.acquire(controlPath);
        } catch {
          fail("lifecycle_busy");
        }
      } else if (
        caught instanceof BridgeRuntimeError &&
        caught.code === "companion_already_running"
      ) {
        fail("lifecycle_busy");
      } else {
        throw caught;
      }
    }
    try {
      const changed =
        command === "install"
          ? await this.#install()
          : command === "start" || command === "ensure"
            ? await this.#start()
            : command === "stop"
              ? await this.#stop()
              : command === "restart"
                ? await this.#restart()
                : command === "update"
                  ? await this.#update()
                  : await this.#rollback();
      return await this.#result(command, changed);
    } finally {
      await lock.release();
    }
  }

  async #validatedCandidate(release: LifecycleRelease): Promise<Buffer> {
    const before = await this.#hooks.pairingIdentity();
    await this.#hooks.preflight(release);
    const after = await this.#hooks.pairingIdentity();
    if (!pairingMatches(before, after)) fail("pairing_changed");
    return before;
  }

  async #assertPairingUnchanged(identity: Buffer): Promise<void> {
    if (!pairingMatches(identity, await this.#hooks.pairingIdentity())) {
      fail("cutover_unknown");
    }
  }

  async #recoverStale(
    status: CompanionLeaseStatus,
    release: LifecycleRelease,
  ): Promise<CompanionLeaseStatus> {
    if (
      status.state === "stale" &&
      status.managed &&
      status.companionVersion === release.version &&
      status.releaseIntegrity === release.integrity
    ) {
      await this.#hooks.recoverStale(release);
      return { state: "stopped" };
    }
    return status;
  }

  async #adoptRunning(
    release: LifecycleRelease,
    state: LifecycleState,
  ): Promise<boolean> {
    const status = await this.#hooks.inspect();
    if (
      status.state !== "active" ||
      !status.managed ||
      status.companionVersion !== release.version ||
      status.releaseIntegrity !== release.integrity
    ) {
      return false;
    }
    const pairing = await this.#validatedCandidate(release);
    await this.#assertPairingUnchanged(pairing);
    try {
      await saveState(this.#root, state);
    } catch {
      fail("cutover_unknown");
    }
    return true;
  }

  async #install(): Promise<boolean> {
    const release = await this.#hooks.currentRelease();
    const state = await loadState(this.#root);
    if (state !== undefined) {
      if (state.active.version === release.version && !sameRelease(state.active, release)) {
        fail("version_conflict");
      }
      if (!sameRelease(state.active, release)) fail("already_installed");
      return await this.#start();
    }
    if (
      await this.#adoptRunning(release, {
        schema_version: STATE_VERSION,
        active: release,
        previous: null,
      })
    ) {
      return true;
    }
    const processStatus = await this.#recoverStale(await this.#hooks.inspect(), release);
    if (processStatus.state !== "stopped") {
      if (processStatus.state === "active" && !processStatus.managed) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      fail("candidate_start_failed");
    }
    const pairing = await this.#validatedCandidate(release);
    await this.#hooks.start(release);
    await this.#assertPairingUnchanged(pairing);
    try {
      await saveState(this.#root, {
        schema_version: STATE_VERSION,
        active: release,
        previous: null,
      });
    } catch {
      fail("cutover_unknown");
    }
    return true;
  }

  async #start(): Promise<boolean> {
    const state = await loadState(this.#root);
    if (state === undefined) fail("not_installed");
    const status = await this.#recoverStale(await this.#hooks.inspect(), state.active);
    if (status.state === "active") {
      if (
        status.managed &&
        status.companionVersion === state.active.version &&
        status.releaseIntegrity === state.active.integrity
      ) {
        return false;
      }
      throw new BridgeRuntimeError("companion_not_managed");
    }
    if (status.state !== "stopped") fail("candidate_start_failed");
    const pairing = await this.#validatedCandidate(state.active);
    await this.#hooks.start(state.active);
    await this.#assertPairingUnchanged(pairing);
    return true;
  }

  async #stop(): Promise<boolean> {
    let status = await this.#hooks.inspect();
    if (status.state === "stopped") return false;
    if (status.state === "stale" && status.managed) {
      await this.#hooks.recoverStale({
        version: status.companionVersion,
        integrity: status.releaseIntegrity,
        protocol_versions: status.protocolVersions,
      });
      return true;
    }
    if (status.state !== "active" || !status.managed) {
      throw new BridgeRuntimeError("companion_not_managed");
    }
    await this.#hooks.stop();
    return true;
  }

  async #restart(): Promise<boolean> {
    const state = await loadState(this.#root);
    if (state === undefined) fail("not_installed");
    const pairing = await this.#validatedCandidate(state.active);
    const status = await this.#recoverStale(await this.#hooks.inspect(), state.active);
    if (status.state === "active") {
      if (
        !status.managed ||
        status.companionVersion !== state.active.version ||
        status.releaseIntegrity !== state.active.integrity
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      await this.#hooks.stop();
    } else if (status.state !== "stopped") {
      fail("candidate_start_failed");
    }
    await this.#hooks.start(state.active);
    await this.#assertPairingUnchanged(pairing);
    return true;
  }

  async #switch(
    state: LifecycleState,
    candidate: LifecycleRelease,
    next: LifecycleState,
  ): Promise<boolean> {
    const pairing = await this.#validatedCandidate(candidate);
    const status = await this.#recoverStale(await this.#hooks.inspect(), state.active);
    if (status.state === "active") {
      if (
        !status.managed ||
        status.companionVersion !== state.active.version ||
        status.releaseIntegrity !== state.active.integrity
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      await this.#hooks.stop();
    } else if (status.state !== "stopped") {
      fail("candidate_start_failed");
    }
    try {
      await this.#hooks.start(candidate);
    } catch (caught) {
      if (caught instanceof BridgeLifecycleError && caught.code === "cutover_unknown") throw caught;
      try {
        await this.#hooks.start(state.active);
      } catch {
        fail("restore_failed");
      }
      fail("update_failed_restored");
    }
    await this.#assertPairingUnchanged(pairing);
    try {
      await saveState(this.#root, next);
    } catch {
      fail("cutover_unknown");
    }
    return true;
  }

  async #update(): Promise<boolean> {
    const state = await loadState(this.#root);
    if (state === undefined) fail("not_installed");
    const candidate = await this.#hooks.currentRelease();
    if (candidate.version === state.active.version && !sameRelease(candidate, state.active)) {
      fail("version_conflict");
    }
    if (sameRelease(candidate, state.active)) {
      return await this.#start();
    }
    const next: LifecycleState = {
      schema_version: STATE_VERSION,
      active: candidate,
      previous: state.active,
    };
    if (await this.#adoptRunning(candidate, next)) return true;
    return await this.#switch(state, candidate, next);
  }

  async #rollback(): Promise<boolean> {
    const state = await loadState(this.#root);
    if (state === undefined) fail("not_installed");
    if (state.previous === null) {
      const status = await this.#hooks.inspect();
      if (status.state === "stopped") return false;
      if (!status.managed) {
        if (status.state === "active") throw new BridgeRuntimeError("companion_not_managed");
        return false;
      }
      const running: LifecycleRelease = {
        version: status.companionVersion,
        integrity: status.releaseIntegrity,
        protocol_versions: [...status.protocolVersions],
      };
      if (sameRelease(running, state.active)) return false;
      if (status.state === "unknown") fail("cutover_unknown");
      return await this.#switch(
        {
          schema_version: STATE_VERSION,
          active: running,
          previous: null,
        },
        state.active,
        state,
      );
    }
    const next: LifecycleState = {
      schema_version: STATE_VERSION,
      active: state.previous,
      previous: null,
    };
    if (await this.#adoptRunning(state.previous, next)) return true;
    return await this.#switch(state, state.previous, next);
  }

  async #result(command: LifecycleCommand, changed: boolean): Promise<LifecycleResult> {
    const state = await loadState(this.#root);
    const processStatus = await this.#hooks.inspect();
    let lifecycleState: LifecycleResult["state"];
    if (state === undefined) {
      lifecycleState =
        processStatus.state === "stopped"
          ? "not_installed"
          : processStatus.state === "active"
            ? processStatus.managed
              ? "cutover_unknown"
              : "unmanaged"
            : processStatus.state;
    } else if (processStatus.state === "active") {
      lifecycleState =
        processStatus.managed &&
        processStatus.companionVersion === state.active.version &&
        processStatus.releaseIntegrity === state.active.integrity
          ? "running"
          : "cutover_unknown";
    } else {
      lifecycleState = processStatus.state;
    }
    let pairingValid = true;
    try {
      await this.#hooks.pairingIdentity();
    } catch {
      pairingValid = false;
    }
    const activeProcess = processStatus.state === "active" && processStatus.managed
      ? processStatus
      : undefined;
    return {
      command,
      state: lifecycleState,
      changed,
      active_version: activeProcess?.companionVersion ?? state?.active.version ?? null,
      previous_version:
        lifecycleState === "cutover_unknown" && state !== undefined
          ? state.active.version
          : state?.previous?.version ?? null,
      protocol_versions:
        activeProcess?.protocolVersions ?? state?.active.protocol_versions ?? [],
      pairing_valid: pairingValid,
    };
  }
}
