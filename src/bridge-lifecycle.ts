import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { grokBotDataRoot } from "./grok-bot-client.js";
import {
  defaultBridgeConfigPath,
  loadPairingConfigSnapshot,
} from "./bridge-pairing.js";
import { defaultReplayRoot } from "./bridge-replay.js";
import {
  BridgeRuntimeError,
  CompanionLease,
  clearStaleCompanionLease,
  clearStaleForegroundCompanionLease,
  clearStaleMaintenanceLease,
  companionLeasePath,
  inspectCompanionLease,
  managedCompanionMatches,
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
const CURRENT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type LifecycleCommand =
  | "install"
  | "start"
  | "status"
  | "stop"
  | "restart"
  | "update"
  | "rollback"
  | "ensure"
  | "uninstall";

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

type ConfigLifecycleBinding = {
  schema_version: 1;
  binding_id: string;
  lifecycle_root: string;
};

type RootLifecycleBinding = {
  schema_version: 1;
  binding_id: string;
  config_path: string;
  lifecycle_root: string;
  replay_roots: string[];
  grok_data_roots: string[];
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

type RemovalSnapshot = {
  path: string;
  device: number;
  inode: number;
  kind: "directory" | "file";
};

type LifecycleRemovalPlan = {
  configBinding: RemovalSnapshot;
  rootBinding: RemovalSnapshot;
  state: RemovalSnapshot | undefined;
  releases: RemovalSnapshot | undefined;
};

type LifecycleHooks = {
  currentRelease(): Promise<LifecycleRelease>;
  pairingIdentity(): Promise<Buffer>;
  preflight(release: LifecycleRelease): Promise<void>;
  start(release: LifecycleRelease): Promise<void>;
  inspect(): Promise<CompanionLeaseStatus>;
  owns(release: LifecycleRelease): Promise<boolean>;
  recoverStale(release: LifecycleRelease): Promise<void>;
  recoverForegroundStale(): Promise<void>;
  stop(release: LifecycleRelease): Promise<void>;
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
    | "lifecycle_root_conflict"
    | "lifecycle_state_invalid"
    | "not_installed"
    | "pairing_changed"
    | "restore_failed"
    | "uninstall_incomplete"
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

function canonicalPathForUse(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missing);
    } catch (caught) {
      if (!(isNodeError(caught) && caught.code === "ENOENT")) {
        fail("lifecycle_state_invalid");
      }
      const parent = dirname(cursor);
      if (parent === cursor) fail("lifecycle_state_invalid");
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function canonicalChildPath(path: string): string {
  const absolute = resolve(path);
  return join(canonicalPathForUse(dirname(absolute)), basename(absolute));
}

function containsPath(parent: string, candidate: string): boolean {
  const outside = relative(parent, candidate);
  return (
    outside === "" ||
    (outside !== ".." && !outside.startsWith(`..${sep}`) && !isAbsolute(outside))
  );
}

async function canonicalPathForComparison(
  path: string,
  code: BridgeLifecycleError["code"],
): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (caught) {
      if (!(isNodeError(caught) && caught.code === "ENOENT")) fail(code);
      const parent = dirname(cursor);
      if (parent === cursor) fail(code);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertDisjointPaths(
  left: string,
  right: string,
  code: BridgeLifecycleError["code"],
): Promise<void> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalPathForComparison(left, code),
    canonicalPathForComparison(right, code),
  ]);
  if (
    containsPath(canonicalLeft, canonicalRight) ||
    containsPath(canonicalRight, canonicalLeft)
  ) {
    fail(code);
  }
}

async function assertTrustedDirectoryChain(
  path: string,
  code: BridgeLifecycleError["code"],
): Promise<void> {
  try {
    let cursor = await realpath(path);
    while (true) {
      const details = await lstat(cursor);
      const mode = details.mode & 0o7777;
      const trustedOwner = details.uid === currentUid() || details.uid === 0;
      const writable = (mode & 0o022) !== 0;
      if (
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        !trustedOwner ||
        (writable && ((mode & 0o1000) === 0 || details.uid !== 0))
      ) {
        fail(code);
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail(code);
  }
}

async function assertRemovalPreserves(
  removalRoot: string,
  protectedPaths: readonly string[],
): Promise<void> {
  const canonicalRemoval = await canonicalPathForComparison(
    removalRoot,
    "lifecycle_state_invalid",
  );
  for (const protectedPath of protectedPaths) {
    const canonicalProtected = await canonicalPathForComparison(
      protectedPath,
      "lifecycle_state_invalid",
    );
    if (
      containsPath(canonicalRemoval, canonicalProtected) ||
      containsPath(canonicalProtected, canonicalRemoval)
    ) {
      fail("lifecycle_state_invalid");
    }
  }
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

async function ensurePrivateDirectory(path: string, tightenOwnedMode = false): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    let details = await lstat(path);
    if (
      tightenOwnedMode &&
      !details.isSymbolicLink() &&
      details.isDirectory() &&
      details.uid === currentUid() &&
      (details.mode & 0o700) === 0o700 &&
      (details.mode & 0o7000) === 0 &&
      (details.mode & 0o7777) !== 0o700
    ) {
      await assertTrustedDirectoryChain(path, "lifecycle_state_invalid");
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      const directoryOnly =
        typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
      const handle = await open(path, fsConstants.O_RDONLY | noFollow | directoryOnly);
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== details.dev ||
          opened.ino !== details.ino ||
          !opened.isDirectory() ||
          opened.uid !== currentUid()
        ) {
          fail("lifecycle_state_invalid");
        }
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
      details = await lstat(path);
    }
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
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) {
    fail("lifecycle_state_invalid");
  }
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
    await handle.writeFile(contents, "utf8");
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

async function createPrivateJson(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) {
    fail("lifecycle_state_invalid");
  }
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = join(
    dirname(path),
    `.binding-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.uid !== currentUid() ||
      details.nlink !== 1 ||
      (details.mode & 0o7777) !== 0o600
    ) {
      fail("lifecycle_state_invalid");
    }
    const parent = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (caught) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (caught instanceof BridgeLifecycleError) throw caught;
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

function bindingPath(configPath: string): string {
  return `${resolve(configPath)}.lifecycle.json`;
}

function rootBindingPath(root: string): string {
  return join(resolve(root), "binding.json");
}

function configControlPath(configPath: string): string {
  return `${resolve(configPath)}.lifecycle-control`;
}

function validBindingId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").length === 32 &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function validBindingPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && value.length <= 4_096;
}

function validBindingPaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(validBindingPath) &&
    new Set(value).size === value.length
  );
}

async function recoverBindingPublication(path: string): Promise<void> {
  let target;
  try {
    target = await lstat(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return;
    fail("lifecycle_state_invalid");
  }
  if (target.nlink === 1) return;
  if (
    target.nlink !== 2 ||
    target.isSymbolicLink() ||
    !target.isFile() ||
    target.uid !== currentUid() ||
    (target.mode & 0o7777) !== 0o600 ||
    target.size <= 0 ||
    target.size > MAX_STATE_BYTES
  ) {
    fail("lifecycle_state_invalid");
  }
  let matches: string[];
  try {
    const names = await readdir(dirname(path));
    matches = [];
    for (const name of names) {
      if (!/^\.binding-[0-9]+-[0-9a-f]{16}\.tmp$/.test(name)) continue;
      const candidate = join(dirname(path), name);
      const details = await lstat(candidate);
      if (
        details.dev === target.dev &&
        details.ino === target.ino &&
        details.nlink === 2 &&
        details.isFile() &&
        !details.isSymbolicLink() &&
        details.uid === currentUid() &&
        (details.mode & 0o7777) === 0o600
      ) {
        matches.push(candidate);
      }
    }
  } catch {
    fail("lifecycle_state_invalid");
  }
  if (matches.length !== 1) fail("lifecycle_state_invalid");
  try {
    await unlink(matches[0]!);
    const parent = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const recovered = await lstat(path);
    if (
      recovered.dev !== target.dev ||
      recovered.ino !== target.ino ||
      recovered.nlink !== 1
    ) {
      fail("lifecycle_state_invalid");
    }
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
}

async function loadConfigBinding(
  configPath: string,
  recoverPublication = false,
): Promise<ConfigLifecycleBinding | undefined> {
  if (recoverPublication) await recoverBindingPublication(bindingPath(configPath));
  let value: unknown;
  try {
    value = JSON.parse(
      (await readPrivateFile(bindingPath(configPath), MAX_STATE_BYTES)).toString("utf8"),
    );
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return undefined;
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("lifecycle_state_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "binding_id" ||
    keys[1] !== "lifecycle_root" ||
    keys[2] !== "schema_version" ||
    record.schema_version !== 1 ||
    !validBindingId(record.binding_id) ||
    !validBindingPath(record.lifecycle_root)
  ) {
    fail("lifecycle_state_invalid");
  }
  return record as ConfigLifecycleBinding;
}

async function loadRootBinding(
  root: string,
  recoverPublication = false,
): Promise<RootLifecycleBinding | undefined> {
  if (recoverPublication) await recoverBindingPublication(rootBindingPath(root));
  let value: unknown;
  try {
    value = JSON.parse(
      (await readPrivateFile(rootBindingPath(root), MAX_STATE_BYTES)).toString("utf8"),
    );
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return undefined;
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("lifecycle_state_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 6 ||
    keys[0] !== "binding_id" ||
    keys[1] !== "config_path" ||
    keys[2] !== "grok_data_roots" ||
    keys[3] !== "lifecycle_root" ||
    keys[4] !== "replay_roots" ||
    keys[5] !== "schema_version" ||
    record.schema_version !== 1 ||
    !validBindingId(record.binding_id) ||
    !validBindingPath(record.config_path) ||
    !validBindingPath(record.lifecycle_root) ||
    !validBindingPaths(record.replay_roots) ||
    !validBindingPaths(record.grok_data_roots)
  ) {
    fail("lifecycle_state_invalid");
  }
  return record as RootLifecycleBinding;
}

async function validateBindingPair(
  configBinding: ConfigLifecycleBinding,
  rootBinding: RootLifecycleBinding,
  root: string,
  configPath: string,
): Promise<void> {
  const [configBoundRoot, rootBoundRoot, requestedRoot, rootBoundConfig, requestedConfig] =
    await Promise.all([
      canonicalPathForComparison(configBinding.lifecycle_root, "lifecycle_state_invalid"),
      canonicalPathForComparison(rootBinding.lifecycle_root, "lifecycle_state_invalid"),
      canonicalPathForComparison(root, "lifecycle_state_invalid"),
      canonicalPathForComparison(rootBinding.config_path, "lifecycle_state_invalid"),
      canonicalPathForComparison(configPath, "lifecycle_state_invalid"),
    ]);
  if (
    configBinding.binding_id !== rootBinding.binding_id ||
    configBoundRoot !== requestedRoot ||
    rootBoundRoot !== requestedRoot ||
    rootBoundConfig !== requestedConfig
  ) {
    fail("lifecycle_root_conflict");
  }
}

function addBindingPath(paths: readonly string[], path: string): string[] {
  if (paths.includes(path)) return [...paths];
  if (paths.length >= 16) fail("lifecycle_state_invalid");
  return [...paths, path];
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

async function removalSnapshot(
  path: string,
  kind: RemovalSnapshot["kind"],
  required: boolean,
): Promise<RemovalSnapshot | undefined> {
  try {
    const details = await lstat(path);
    const validKind = kind === "file" ? details.isFile() : details.isDirectory();
    const validMode =
      kind === "file"
        ? details.nlink === 1 && (details.mode & 0o7777) === 0o600
        : (details.mode & 0o7777) === 0o700;
    if (details.isSymbolicLink() || !validKind || details.uid !== currentUid() || !validMode) {
      fail("lifecycle_state_invalid");
    }
    return {
      path,
      device: details.dev,
      inode: details.ino,
      kind,
    };
  } catch (caught) {
    if (!required && isNodeError(caught) && caught.code === "ENOENT") return undefined;
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("lifecycle_state_invalid");
  }
}

async function prepareLifecycleRemoval(
  root: string,
  configPath: string,
): Promise<LifecycleRemovalPlan> {
  return {
    configBinding: (await removalSnapshot(bindingPath(configPath), "file", true))!,
    rootBinding: (await removalSnapshot(rootBindingPath(root), "file", true))!,
    state: await removalSnapshot(statePath(root), "file", false),
    releases: await removalSnapshot(join(root, "releases"), "directory", false),
  };
}

async function validateRemovalPlan(plan: LifecycleRemovalPlan): Promise<void> {
  for (const snapshot of [
    plan.configBinding,
    plan.rootBinding,
    plan.state,
    plan.releases,
  ]) {
    if (snapshot === undefined) continue;
    const current = await removalSnapshot(snapshot.path, snapshot.kind, true);
    if (
      current === undefined ||
      current.device !== snapshot.device ||
      current.inode !== snapshot.inode
    ) {
      fail("lifecycle_state_invalid");
    }
  }
}

async function removeLifecyclePayload(plan: LifecycleRemovalPlan): Promise<boolean> {
  await validateRemovalPlan(plan);
  if (plan.state !== undefined) {
    try {
      await unlink(plan.state.path);
    } catch {
      fail("lifecycle_state_invalid");
    }
  }
  if (plan.releases !== undefined) {
    try {
      await rm(plan.releases.path, { recursive: true, force: false });
    } catch {
      fail("uninstall_incomplete");
    }
  }
  return plan.state !== undefined || plan.releases !== undefined;
}

async function removeLifecycleBindings(plan: LifecycleRemovalPlan): Promise<void> {
  for (const snapshot of [plan.configBinding, plan.rootBinding]) {
    const current = await removalSnapshot(snapshot.path, snapshot.kind, true);
    if (
      current === undefined ||
      current.device !== snapshot.device ||
      current.inode !== snapshot.inode
    ) {
      fail("lifecycle_state_invalid");
    }
    try {
      await unlink(snapshot.path);
    } catch {
      fail("uninstall_incomplete");
    }
  }
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
  let handle;
  try {
    const pathDetails = await lstat(path);
    if (
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      pathDetails.uid !== currentUid() ||
      pathDetails.nlink !== 1 ||
      (pathDetails.mode & 0o022) !== 0 ||
      pathDetails.size <= 0 ||
      pathDetails.size > maxBytes
    ) {
      fail("candidate_invalid");
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
      (details.mode & 0o022) !== 0 ||
      details.size <= 0 ||
      details.size > maxBytes
    ) {
      fail("candidate_invalid");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
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

type PackedLifecyclePackage = {
  filename: string;
  integrity: string;
  size: number;
  files: PackedLifecycleFile[];
};

type PackedLifecycleFile = {
  path: string;
  size: number;
  mode: number;
};

type PackageRootSnapshot = {
  path: string;
  device: number;
  inode: number;
};

type PackageSourceSnapshot = {
  path: string;
  device: number;
  inode: number;
  size: number;
  mode: number;
};

async function snapshotPackageRoot(packageRoot: string): Promise<PackageRootSnapshot> {
  try {
    const details = await lstat(packageRoot);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      details.uid !== currentUid() ||
      (details.mode & 0o022) !== 0
    ) {
      fail("candidate_invalid");
    }
    const canonical = await realpath(packageRoot);
    await assertTrustedDirectoryChain(canonical, "candidate_invalid");
    const canonicalDetails = await lstat(canonical);
    if (
      canonicalDetails.isSymbolicLink() ||
      !canonicalDetails.isDirectory() ||
      canonicalDetails.uid !== currentUid() ||
      (canonicalDetails.mode & 0o022) !== 0
    ) {
      fail("candidate_invalid");
    }
    return {
      path: canonical,
      device: canonicalDetails.dev,
      inode: canonicalDetails.ino,
    };
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  }
}

async function assertPackageRootUnchanged(snapshot: PackageRootSnapshot): Promise<void> {
  const current = await snapshotPackageRoot(snapshot.path);
  if (current.device !== snapshot.device || current.inode !== snapshot.inode) {
    fail("candidate_invalid");
  }
}

async function validateSourceDirectory(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      details.uid !== currentUid() ||
      (details.mode & 0o022) !== 0
    ) {
      fail("candidate_invalid");
    }
  } catch (caught) {
    if (caught instanceof BridgeLifecycleError) throw caught;
    fail("candidate_invalid");
  }
}

async function snapshotPackageSources(
  packageRoot: string,
  files: readonly PackedLifecycleFile[],
): Promise<PackageSourceSnapshot[]> {
  const checkedDirectories = new Set<string>([packageRoot]);
  const snapshots: PackageSourceSnapshot[] = [];
  for (const file of files) {
    const source = resolve(packageRoot, file.path);
    if (!containsPath(packageRoot, source) || source === packageRoot) {
      fail("candidate_invalid");
    }
    let parent = dirname(source);
    const parents: string[] = [];
    while (parent !== packageRoot) {
      if (!containsPath(packageRoot, parent)) fail("candidate_invalid");
      parents.push(parent);
      parent = dirname(parent);
    }
    for (const directory of parents.reverse()) {
      if (checkedDirectories.has(directory)) continue;
      await validateSourceDirectory(directory);
      checkedDirectories.add(directory);
    }
    try {
      const details = await lstat(source);
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        details.uid !== currentUid() ||
        details.nlink !== 1 ||
        (details.mode & 0o022) !== 0 ||
        details.size !== file.size ||
        (details.mode & 0o777) !== file.mode ||
        !containsPath(packageRoot, await realpath(source))
      ) {
        fail("candidate_invalid");
      }
      snapshots.push({
        path: source,
        device: details.dev,
        inode: details.ino,
        size: details.size,
        mode: details.mode & 0o777,
      });
    } catch (caught) {
      if (caught instanceof BridgeLifecycleError) throw caught;
      fail("candidate_invalid");
    }
  }
  return snapshots;
}

async function assertPackageSourcesUnchanged(
  snapshots: readonly PackageSourceSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    try {
      const details = await lstat(snapshot.path);
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        details.uid !== currentUid() ||
        details.nlink !== 1 ||
        (details.mode & 0o022) !== 0 ||
        details.dev !== snapshot.device ||
        details.ino !== snapshot.inode ||
        details.size !== snapshot.size ||
        (details.mode & 0o777) !== snapshot.mode
      ) {
        fail("candidate_invalid");
      }
    } catch (caught) {
      if (caught instanceof BridgeLifecycleError) throw caught;
      fail("candidate_invalid");
    }
  }
}

function parsePackedLifecyclePackage(value: string): PackedLifecyclePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("install_failed");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("install_failed");
  const record = parsed[0];
  const files =
    typeof record === "object" && record !== null && !Array.isArray(record)
      ? (record as Record<string, unknown>).files
      : undefined;
  if (
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record) ||
    (record as Record<string, unknown>).name !== PACKAGE_NAME ||
    (record as Record<string, unknown>).version !== CODEX_GROK_VERSION ||
    typeof (record as Record<string, unknown>).filename !== "string" ||
    basename((record as Record<string, unknown>).filename as string) !==
      (record as Record<string, unknown>).filename ||
    integrityDigest((record as Record<string, unknown>).integrity) === undefined ||
    !Number.isSafeInteger((record as Record<string, unknown>).size) ||
    ((record as Record<string, unknown>).size as number) <= 0 ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > 4_096
  ) {
    fail("install_failed");
  }
  const normalizedFiles: PackedLifecycleFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      fail("install_failed");
    }
    const entry = file as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 4_096 ||
      entry.path.includes("\\") ||
      isAbsolute(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      !Number.isSafeInteger(entry.mode) ||
      (entry.mode as number) < 0 ||
      (entry.mode as number) > 0o777 ||
      seen.has(entry.path)
    ) {
      fail("install_failed");
    }
    seen.add(entry.path);
    normalizedFiles.push({
      path: entry.path,
      size: entry.size as number,
      mode: entry.mode as number,
    });
  }
  return {
    filename: (record as Record<string, unknown>).filename as string,
    integrity: (record as Record<string, unknown>).integrity as string,
    size: (record as Record<string, unknown>).size as number,
    files: normalizedFiles,
  };
}

function samePackedPackage(
  left: PackedLifecyclePackage,
  right: PackedLifecyclePackage,
): boolean {
  return (
    left.filename === right.filename &&
    left.integrity === right.integrity &&
    left.size === right.size &&
    JSON.stringify(left.files) === JSON.stringify(right.files)
  );
}

type LockedProductionPackage = {
  path: string;
  version: string;
  integrity: string;
};

function lockedProductionPackages(
  value: unknown,
  omittedPath?: string,
): LockedProductionPackage[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("candidate_invalid");
  }
  const lock = value as Record<string, unknown>;
  if (lock.lockfileVersion !== 3) fail("candidate_invalid");
  const packages = lock.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    fail("candidate_invalid");
  }
  const result: LockedProductionPackage[] = [];
  for (const [path, packageValue] of Object.entries(packages)) {
    if (path === "" || path === omittedPath) continue;
    if (
      typeof packageValue !== "object" ||
      packageValue === null ||
      Array.isArray(packageValue)
    ) {
      fail("candidate_invalid");
    }
    const record = packageValue as Record<string, unknown>;
    if (record.dev === true) continue;
    if (
      !path.startsWith("node_modules/") ||
      path.length > 4_096 ||
      typeof record.version !== "string" ||
      record.version.length === 0 ||
      record.version.length > 256 ||
      integrityDigest(record.integrity) === undefined
    ) {
      fail("candidate_invalid");
    }
    result.push({
      path,
      version: record.version,
      integrity: record.integrity as string,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function stageLifecycleRelease(
  root: string,
  packageRoot = CURRENT_PACKAGE_ROOT,
): Promise<LifecycleRelease> {
  const packageSnapshot = await snapshotPackageRoot(packageRoot);
  await assertDisjointPaths(root, packageSnapshot.path, "candidate_invalid");
  const packageMetadata = await readRegularJson(
    join(packageSnapshot.path, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  if (
    typeof packageMetadata !== "object" ||
    packageMetadata === null ||
    Array.isArray(packageMetadata) ||
    (packageMetadata as Record<string, unknown>).name !== PACKAGE_NAME ||
    (packageMetadata as Record<string, unknown>).version !== CODEX_GROK_VERSION
  ) {
    fail("install_failed");
  }
  const shrinkwrap = await readRegularJson(
    join(packageSnapshot.path, "npm-shrinkwrap.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  const shrinkwrapRoot =
    typeof shrinkwrap === "object" && shrinkwrap !== null && !Array.isArray(shrinkwrap)
      ? (shrinkwrap as Record<string, unknown>).packages
      : undefined;
  const shrinkwrapPackage =
    typeof shrinkwrapRoot === "object" && shrinkwrapRoot !== null && !Array.isArray(shrinkwrapRoot)
      ? (shrinkwrapRoot as Record<string, unknown>)[""]
      : undefined;
  if (
    typeof shrinkwrapPackage !== "object" ||
    shrinkwrapPackage === null ||
    Array.isArray(shrinkwrapPackage) ||
    (shrinkwrapPackage as Record<string, unknown>).name !== PACKAGE_NAME ||
    (shrinkwrapPackage as Record<string, unknown>).version !== CODEX_GROK_VERSION ||
    JSON.stringify((shrinkwrapPackage as Record<string, unknown>).dependencies) !==
      JSON.stringify((packageMetadata as Record<string, unknown>).dependencies)
  ) {
    fail("candidate_invalid");
  }
  const expectedProductionPackages = lockedProductionPackages(shrinkwrap);
  const previewCommand = npmCommand([
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
    packageSnapshot.path,
  ]);
  const preview = parsePackedLifecyclePackage(
    (
      await runProcess(previewCommand.command, previewCommand.args, {
        cwd: packageSnapshot.path,
      }).catch(() => fail("install_failed"))
    ).stdout,
  );
  if (!preview.files.some((file) => file.path === "npm-shrinkwrap.json")) {
    fail("candidate_invalid");
  }
  const sourceSnapshots = await snapshotPackageSources(
    packageSnapshot.path,
    preview.files,
  );
  await ensurePrivateDirectory(root);
  root = await realpath(root);
  await assertTrustedDirectoryChain(root, "candidate_invalid");
  await assertDisjointPaths(root, packageSnapshot.path, "candidate_invalid");
  const releasesRoot = join(root, "releases");
  await ensurePrivateDirectory(releasesRoot);
  const staging = await mkdtemp(join(root, ".stage-"));
  await chmod(staging, 0o700);
  try {
    const packedRoot = join(staging, ".candidate");
    await ensurePrivateDirectory(packedRoot);
    const pack = npmCommand([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packedRoot,
      packageSnapshot.path,
    ]);
    const packed = parsePackedLifecyclePackage(
      (await runProcess(pack.command, pack.args, { cwd: staging })).stdout,
    );
    if (!samePackedPackage(preview, packed)) fail("candidate_invalid");
    await assertPackageRootUnchanged(packageSnapshot);
    await assertPackageSourcesUnchanged(sourceSnapshots);
    const packedPath = join(packedRoot, packed.filename);
    try {
      const packedDetails = await lstat(packedPath);
      if (
        packedDetails.isSymbolicLink() ||
        !packedDetails.isFile() ||
        packedDetails.uid !== currentUid() ||
        packedDetails.nlink !== 1 ||
        (packedDetails.mode & 0o022) !== 0 ||
        packedDetails.size !== packed.size
      ) {
        fail("candidate_invalid");
      }
    } catch (caught) {
      if (caught instanceof BridgeLifecycleError) throw caught;
      fail("candidate_invalid");
    }
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
      packedPath,
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
      (installedLock as Record<string, unknown>).integrity !== packed.integrity
    ) {
      fail("install_failed");
    }
    const installedProductionPackages = lockedProductionPackages(
      lock,
      `node_modules/${PACKAGE_NAME}`,
    );
    if (
      JSON.stringify(installedProductionPackages) !==
      JSON.stringify(expectedProductionPackages)
    ) {
      fail("candidate_invalid");
    }
    const release: LifecycleRelease = {
      version: CODEX_GROK_VERSION,
      integrity: packed.integrity,
      protocol_versions: [...BRIDGE_PROTOCOL_VERSIONS],
    };
    await writePrivateJson(join(staging, "release.json"), release);
    await rm(packedRoot, { recursive: true, force: true });
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
    await assertDisjointPaths(root, packageSnapshot.path, "candidate_invalid");
    await assertPackageRootUnchanged(packageSnapshot);
    await assertPackageSourcesUnchanged(sourceSnapshots);
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
    "GROKBOT_GATEWAY_URL",
    "SAND_GATEWAY_URL",
    "SAND_GATEWAY_BIND_HOST",
    "SAND_HOST_PORT",
    "SAND_GATEWAY_TOKEN",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const sandUserDataDirectory = process.env.SAND_USER_DATA_DIR;
  if (sandUserDataDirectory !== undefined && sandUserDataDirectory.trim() !== "") {
    environment.SAND_USER_DATA_DIR = resolve(sandUserDataDirectory);
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
    owns: (release) =>
      managedCompanionMatches(configPath, {
        companionVersion: release.version,
        releaseIntegrity: release.integrity,
        releaseDirectory: releaseDirectory(root, release),
      }),
    recoverStale: async (release) => {
      await clearStaleCompanionLease(configPath, {
        companionVersion: release.version,
        releaseIntegrity: release.integrity,
      });
    },
    recoverForegroundStale: async () => {
      await clearStaleForegroundCompanionLease(configPath);
    },
    stop: async (release) => {
      await stopManagedCompanion(configPath, {
        companionVersion: release.version,
        releaseIntegrity: release.integrity,
        releaseDirectory: releaseDirectory(root, release),
      });
      await waitForCompanionStop(configPath, STOP_TIMEOUT_MS);
    },
  };
}

function pairingMatches(before: Buffer, after: Buffer): boolean {
  return before.length === after.length && timingSafeEqual(before, after);
}

async function acquireLifecycleControl(controlPath: string): Promise<CompanionLease> {
  try {
    return await CompanionLease.acquire(controlPath);
  } catch (caught) {
    if (caught instanceof BridgeRuntimeError && caught.code === "companion_lease_stale") {
      try {
        await clearStaleCompanionLease(controlPath);
        return await CompanionLease.acquire(controlPath);
      } catch {
        fail("lifecycle_busy");
      }
    }
    if (
      caught instanceof BridgeRuntimeError &&
      caught.code === "companion_already_running"
    ) {
      fail("lifecycle_busy");
    }
    throw caught;
  }
}

export class BridgeLifecycle {
  readonly #root: string;
  readonly #configPath: string;
  readonly #repairDefaultConfigParent: boolean;
  readonly #currentReplayRoot: string;
  readonly #currentGrokDataRoot: string;
  readonly #baseProtectedPaths: string[];
  readonly #hooks: LifecycleHooks;

  constructor(options: LifecycleOptions = {}) {
    if (options.hooks !== undefined && options.configPath === undefined) {
      fail("lifecycle_state_invalid");
    }
    this.#root = canonicalChildPath(options.root ?? defaultLifecycleRoot());
    this.#configPath = canonicalChildPath(options.configPath ?? defaultBridgeConfigPath());
    this.#repairDefaultConfigParent =
      this.#configPath === canonicalChildPath(defaultBridgeConfigPath());
    this.#currentReplayRoot = resolve(defaultReplayRoot());
    this.#currentGrokDataRoot = resolve(grokBotDataRoot());
    this.#baseProtectedPaths = [
      this.#configPath,
      companionLeasePath(this.#configPath),
      bindingPath(this.#configPath),
      rootBindingPath(this.#root),
      companionLeasePath(configControlPath(this.#configPath)),
      this.#currentReplayRoot,
      this.#currentGrokDataRoot,
      CURRENT_PACKAGE_ROOT,
    ];
    this.#hooks =
      options.hooks ??
      defaultHooks(this.#root, this.#configPath);
  }

  async run(command: LifecycleCommand): Promise<LifecycleResult> {
    if (command !== "status") {
      await assertRemovalPreserves(join(this.#root, "releases"), this.#baseProtectedPaths);
    }
    await ensurePrivateDirectory(this.#root, true);
    if (this.#repairDefaultConfigParent) {
      await ensurePrivateDirectory(dirname(this.#configPath), true);
    }
    await assertTrustedDirectoryChain(this.#root, "lifecycle_state_invalid");
    if (command === "status") {
      await this.#validatedBindingForStatus();
      return await this.#result(command, false);
    }
    const locks: CompanionLease[] = [];
    try {
      locks.push(await acquireLifecycleControl(configControlPath(this.#configPath)));
      locks.push(await acquireLifecycleControl(join(this.#root, "lifecycle-control")));
      const binding = await this.#ensureBinding(command);
      if (binding !== undefined) {
        await assertRemovalPreserves(
          join(this.#root, "releases"),
          this.#protectedPaths(binding),
        );
      }
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
                  : command === "rollback"
                    ? await this.#rollback()
                    : await this.#uninstall(binding);
      return await this.#result(command, changed);
    } finally {
      for (const lock of locks.reverse()) {
        await lock.release().catch(() => undefined);
      }
    }
  }

  #protectedPaths(binding: RootLifecycleBinding): string[] {
    return [
      ...this.#baseProtectedPaths,
      ...binding.replay_roots,
      ...binding.grok_data_roots,
    ];
  }

  async #validatedBindingForStatus(): Promise<RootLifecycleBinding | undefined> {
    const [configBinding, rootBinding] = await Promise.all([
      loadConfigBinding(this.#configPath),
      loadRootBinding(this.#root),
    ]);
    if (configBinding === undefined && rootBinding === undefined) return undefined;
    if (configBinding !== undefined && rootBinding !== undefined) {
      await validateBindingPair(configBinding, rootBinding, this.#root, this.#configPath);
      return rootBinding;
    }
    if (configBinding !== undefined) {
      const boundRoot = await canonicalPathForComparison(
        configBinding.lifecycle_root,
        "lifecycle_state_invalid",
      );
      const requestedRoot = await canonicalPathForComparison(
        this.#root,
        "lifecycle_state_invalid",
      );
      if (boundRoot !== requestedRoot) fail("lifecycle_root_conflict");
    }
    if (rootBinding !== undefined) {
      const [boundRoot, requestedRoot, boundConfig, requestedConfig] = await Promise.all([
        canonicalPathForComparison(rootBinding.lifecycle_root, "lifecycle_state_invalid"),
        canonicalPathForComparison(this.#root, "lifecycle_state_invalid"),
        canonicalPathForComparison(rootBinding.config_path, "lifecycle_state_invalid"),
        canonicalPathForComparison(this.#configPath, "lifecycle_state_invalid"),
      ]);
      if (boundRoot !== requestedRoot || boundConfig !== requestedConfig) {
        fail("lifecycle_root_conflict");
      }
    }
    fail("lifecycle_state_invalid");
  }

  async #extendBindingProtection(
    binding: RootLifecycleBinding,
  ): Promise<RootLifecycleBinding> {
    const [replayRoot, grokDataRoot] = await Promise.all([
      canonicalPathForComparison(this.#currentReplayRoot, "lifecycle_state_invalid"),
      canonicalPathForComparison(this.#currentGrokDataRoot, "lifecycle_state_invalid"),
    ]);
    const next: RootLifecycleBinding = {
      ...binding,
      replay_roots: addBindingPath(binding.replay_roots, replayRoot),
      grok_data_roots: addBindingPath(binding.grok_data_roots, grokDataRoot),
    };
    await assertRemovalPreserves(join(this.#root, "releases"), this.#protectedPaths(next));
    if (
      JSON.stringify(next.replay_roots) !== JSON.stringify(binding.replay_roots) ||
      JSON.stringify(next.grok_data_roots) !== JSON.stringify(binding.grok_data_roots)
    ) {
      await writePrivateJson(rootBindingPath(this.#root), next);
    }
    return next;
  }

  async #ensureBinding(
    command: LifecycleCommand,
  ): Promise<RootLifecycleBinding | undefined> {
    let [configBinding, rootBinding] = await Promise.all([
      loadConfigBinding(this.#configPath, true),
      loadRootBinding(this.#root, true),
    ]);
    if (configBinding !== undefined && rootBinding !== undefined) {
      await validateBindingPair(configBinding, rootBinding, this.#root, this.#configPath);
      await assertRemovalPreserves(
        join(this.#root, "releases"),
        this.#protectedPaths(rootBinding),
      );
      return await this.#extendBindingProtection(rootBinding);
    }

    if (configBinding !== undefined) {
      const [boundRoot, requestedRoot] = await Promise.all([
        canonicalPathForComparison(configBinding.lifecycle_root, "lifecycle_state_invalid"),
        canonicalPathForComparison(this.#root, "lifecycle_state_invalid"),
      ]);
      if (boundRoot !== requestedRoot) fail("lifecycle_root_conflict");
      fail("lifecycle_state_invalid");
    }

    if (rootBinding !== undefined) {
      const requestedConfig: ConfigLifecycleBinding = {
        schema_version: 1,
        binding_id: rootBinding.binding_id,
        lifecycle_root: rootBinding.lifecycle_root,
      };
      await validateBindingPair(
        requestedConfig,
        rootBinding,
        this.#root,
        this.#configPath,
      );
      await assertRemovalPreserves(
        join(this.#root, "releases"),
        this.#protectedPaths(rootBinding),
      );
      await createPrivateJson(bindingPath(this.#configPath), requestedConfig);
      return await this.#extendBindingProtection(rootBinding);
    }

    const state = await loadState(this.#root);
    const status = await this.#hooks.inspect();
    if (state === undefined) {
      if (command !== "install") return undefined;
      if (status.state === "unknown") fail("candidate_start_failed");
      if (status.state === "active" || (status.state === "stale" && status.managed)) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
    } else if (status.state === "active") {
      if (
        !status.managed ||
        status.companionVersion !== state.active.version ||
        status.releaseIntegrity !== state.active.integrity ||
        !(await this.#hooks.owns(state.active))
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
    } else if (status.state === "stale") {
      // A dead pre-binding process no longer has a verifiable working directory.
      // Restart the prior exact release so active ownership can be proven first.
      throw new BridgeRuntimeError("companion_not_managed");
    } else if (status.state === "unknown") {
      fail("cutover_unknown");
    }

    const [lifecycleRoot, configPath, replayRoot, grokDataRoot] = await Promise.all([
      realpath(this.#root),
      canonicalPathForComparison(this.#configPath, "lifecycle_state_invalid"),
      canonicalPathForComparison(this.#currentReplayRoot, "lifecycle_state_invalid"),
      canonicalPathForComparison(this.#currentGrokDataRoot, "lifecycle_state_invalid"),
    ]);
    const bindingId = randomBytes(32).toString("base64url");
    rootBinding = {
      schema_version: 1,
      binding_id: bindingId,
      config_path: configPath,
      lifecycle_root: lifecycleRoot,
      replay_roots: [replayRoot],
      grok_data_roots: [grokDataRoot],
    };
    await assertRemovalPreserves(
      join(this.#root, "releases"),
      this.#protectedPaths(rootBinding),
    );
    await createPrivateJson(rootBindingPath(this.#root), rootBinding);
    await createPrivateJson(bindingPath(this.#configPath), {
      schema_version: 1,
      binding_id: bindingId,
      lifecycle_root: lifecycleRoot,
    } satisfies ConfigLifecycleBinding);
    return rootBinding;
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
      status.releaseIntegrity !== release.integrity ||
      !(await this.#hooks.owns(release))
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
    const inspected = await this.#hooks.inspect();
    let pairing: Buffer | undefined;
    let processStatus: CompanionLeaseStatus;
    if (inspected.state === "stale" && !inspected.managed) {
      pairing = await this.#validatedCandidate(release);
      await this.#hooks.recoverForegroundStale();
      processStatus = await this.#hooks.inspect();
    } else {
      processStatus = await this.#recoverStale(inspected, release);
    }
    if (processStatus.state !== "stopped") {
      if (processStatus.state === "active" && !processStatus.managed) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      fail("candidate_start_failed");
    }
    pairing ??= await this.#validatedCandidate(release);
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
        status.releaseIntegrity === state.active.integrity &&
        (await this.#hooks.owns(state.active))
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
    const state = await loadState(this.#root);
    let status = await this.#hooks.inspect();
    if (state === undefined) {
      if (status.state === "stopped") return false;
      throw new BridgeRuntimeError("companion_not_managed");
    }
    if (status.state === "stopped") return false;
    if (
      status.state === "stale" &&
      status.managed &&
      status.companionVersion === state.active.version &&
      status.releaseIntegrity === state.active.integrity
    ) {
      await this.#hooks.recoverStale(state.active);
      return true;
    }
    if (
      status.state !== "active" ||
      !status.managed ||
      status.companionVersion !== state.active.version ||
      status.releaseIntegrity !== state.active.integrity ||
      !(await this.#hooks.owns(state.active))
    ) {
      throw new BridgeRuntimeError("companion_not_managed");
    }
    await this.#hooks.stop(state.active);
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
        status.releaseIntegrity !== state.active.integrity ||
        !(await this.#hooks.owns(state.active))
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      await this.#hooks.stop(state.active);
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
        status.releaseIntegrity !== state.active.integrity ||
        !(await this.#hooks.owns(state.active))
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      await this.#hooks.stop(state.active);
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

  async #uninstall(binding: RootLifecycleBinding | undefined): Promise<boolean> {
    const state = await loadState(this.#root);
    if (binding === undefined) {
      if (state === undefined) {
        const unownedStatus = await this.#hooks.inspect();
        if (unownedStatus.state === "stopped") return false;
        if (unownedStatus.state === "unknown") fail("cutover_unknown");
        throw new BridgeRuntimeError("companion_not_managed");
      }
      fail("lifecycle_state_invalid");
    }
    const [configBinding, rootBinding] = await Promise.all([
      loadConfigBinding(this.#configPath, true),
      loadRootBinding(this.#root, true),
    ]);
    if (configBinding === undefined || rootBinding === undefined) {
      fail("lifecycle_state_invalid");
    }
    await validateBindingPair(configBinding, rootBinding, this.#root, this.#configPath);
    if (binding.binding_id !== rootBinding.binding_id) {
      fail("lifecycle_root_conflict");
    }
    await clearStaleMaintenanceLease(this.#configPath, binding.binding_id);
    const removal = await prepareLifecycleRemoval(this.#root, this.#configPath);
    const pairing = await this.#hooks.pairingIdentity().catch(() => undefined);
    let status = await this.#hooks.inspect();

    if (status.state === "active") {
      if (
        !status.managed ||
        state === undefined ||
        status.companionVersion !== state.active.version ||
        status.releaseIntegrity !== state.active.integrity ||
        !(await this.#hooks.owns(state.active))
      ) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      await this.#hooks.stop(state.active);
      status = { state: "stopped" };
    } else if (status.state === "stale") {
      if (!status.managed || state === undefined) {
        throw new BridgeRuntimeError("companion_not_managed");
      }
      const staleRelease: LifecycleRelease = {
        version: status.companionVersion,
        integrity: status.releaseIntegrity,
        protocol_versions: [...status.protocolVersions],
      };
      if (!sameRelease(staleRelease, state.active)) {
        fail("cutover_unknown");
      }
      await this.#hooks.recoverStale(staleRelease);
      status = { state: "stopped" };
    }

    if (status.state !== "stopped") fail("cutover_unknown");
    let maintenance: CompanionLease;
    try {
      maintenance = await CompanionLease.acquire(this.#configPath, {
        maintenanceBindingId: binding.binding_id,
      });
    } catch {
      fail("cutover_unknown");
    }
    let cleanupError: unknown;
    try {
      if (pairing !== undefined) await this.#assertPairingUnchanged(pairing);
      await assertRemovalPreserves(
        join(this.#root, "releases"),
        this.#protectedPaths(binding),
      );
      await removeLifecyclePayload(removal);
      if (pairing !== undefined) await this.#assertPairingUnchanged(pairing);
    } catch (caught) {
      cleanupError = caught;
    }
    try {
      await maintenance.release();
    } catch {
      fail("uninstall_incomplete");
    }
    if (cleanupError !== undefined) throw cleanupError;
    await removeLifecycleBindings(removal);
    return true;
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
        processStatus.releaseIntegrity === state.active.integrity &&
        (await this.#hooks.owns(state.active))
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
