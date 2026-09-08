import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const LEASE_VERSION = 1;
const MANAGED_LEASE_VERSION = 2;
const MAINTENANCE_LEASE_VERSION = 3;
const MAX_LEASE_BYTES = 1_024;

type LegacyLeaseRecord = {
  version: 1;
  pid: number;
  process_start_id: string | null;
  owner_token: string;
};

type ManagedLeaseRecord = {
  version: 2;
  pid: number;
  process_start_id: string;
  owner_token: string;
  launch_token: string;
  mode: "managed";
  companion_version: string;
  protocol_versions: number[];
  release_integrity: string;
};

type MaintenanceLeaseRecord = {
  version: 3;
  pid: number;
  process_start_id: string | null;
  owner_token: string;
  binding_id: string;
  mode: "maintenance";
};

type LeaseRecord = LegacyLeaseRecord | ManagedLeaseRecord | MaintenanceLeaseRecord;

export type ManagedLeaseMetadata = {
  companionVersion: string;
  launchToken: string;
  protocolVersions: readonly number[];
  releaseIntegrity: string;
};

export type MaintenanceLeaseMetadata = {
  maintenanceBindingId: string;
};

export type ExpectedManagedLease = {
  companionVersion: string;
  releaseIntegrity: string;
  launchToken?: string;
  releaseDirectory?: string;
};

export type CompanionLeaseStatus =
  | { state: "stopped" }
  | { state: "active" | "stale" | "unknown"; managed: false }
  | {
      state: "active" | "stale" | "unknown";
      managed: true;
      companionVersion: string;
      protocolVersions: number[];
      releaseIntegrity: string;
    };

type LeaseSnapshot = {
  device: number;
  inode: number;
  record: LeaseRecord;
};

export class BridgeRuntimeError extends Error {
  readonly code:
    | "companion_already_running"
    | "companion_identity_unavailable"
    | "companion_lease_invalid"
    | "companion_lease_recovery_required"
    | "companion_lease_stale"
    | "companion_not_managed"
    | "companion_not_running"
    | "companion_stop_timeout";

  constructor(
    code:
      | "companion_already_running"
      | "companion_identity_unavailable"
      | "companion_lease_invalid"
      | "companion_lease_recovery_required"
      | "companion_lease_stale"
      | "companion_not_managed"
      | "companion_not_running"
      | "companion_stop_timeout",
  ) {
    super(code);
    this.name = "BridgeRuntimeError";
    this.code = code;
  }
}

function fail(
  code:
    | "companion_already_running"
    | "companion_identity_unavailable"
    | "companion_lease_invalid"
    | "companion_lease_recovery_required"
    | "companion_lease_stale"
    | "companion_not_managed"
    | "companion_not_running"
    | "companion_stop_timeout" = "companion_lease_invalid",
): never {
  throw new BridgeRuntimeError(code);
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
      if (!(isNodeError(caught) && caught.code === "ENOENT")) fail();
      const parent = dirname(cursor);
      if (parent === cursor) fail();
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") fail();
  return process.getuid();
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLeaseFile(left: LeaseSnapshot, right: LeaseSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function canonicalToken(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").length === 32 &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function exactVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  );
}

function sha512Integrity(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  try {
    const digest = Buffer.from(value.slice("sha512-".length), "base64");
    return digest.length === 64 && digest.toString("base64") === value.slice("sha512-".length);
  } catch {
    return false;
  }
}

function protocolVersions(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(
      (version, index) =>
        Number.isSafeInteger(version) &&
        version > 0 &&
        (index === 0 || version > (value[index - 1] as number)),
    )
  );
}

function parseLeaseRecord(contents: string): LeaseRecord {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    fail();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const commonInvalid =
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    (record.pid as number) > 2_147_483_647 ||
    (record.process_start_id !== null &&
      (typeof record.process_start_id !== "string" ||
        !/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/.test(
          record.process_start_id,
        ))) ||
    typeof record.owner_token !== "string" ||
    !canonicalToken(record.owner_token);
  if (commonInvalid) fail();

  if (record.version === LEASE_VERSION) {
    if (
      keys.length !== 4 ||
      keys[0] !== "owner_token" ||
      keys[1] !== "pid" ||
      keys[2] !== "process_start_id" ||
      keys[3] !== "version"
    ) {
      fail();
    }
    return record as LegacyLeaseRecord;
  }

  if (record.version === MAINTENANCE_LEASE_VERSION) {
    if (
      keys.length !== 6 ||
      keys[0] !== "binding_id" ||
      keys[1] !== "mode" ||
      keys[2] !== "owner_token" ||
      keys[3] !== "pid" ||
      keys[4] !== "process_start_id" ||
      keys[5] !== "version" ||
      record.mode !== "maintenance" ||
      typeof record.binding_id !== "string" ||
      !canonicalToken(record.binding_id)
    ) {
      fail();
    }
    return record as MaintenanceLeaseRecord;
  }

  if (
    record.version !== MANAGED_LEASE_VERSION ||
    keys.length !== 9 ||
    keys[0] !== "companion_version" ||
    keys[1] !== "launch_token" ||
    keys[2] !== "mode" ||
    keys[3] !== "owner_token" ||
    keys[4] !== "pid" ||
    keys[5] !== "process_start_id" ||
    keys[6] !== "protocol_versions" ||
    keys[7] !== "release_integrity" ||
    keys[8] !== "version" ||
    record.process_start_id === null ||
    record.mode !== "managed" ||
    typeof record.launch_token !== "string" ||
    !canonicalToken(record.launch_token) ||
    !exactVersion(record.companion_version) ||
    !protocolVersions(record.protocol_versions) ||
    !sha512Integrity(record.release_integrity)
  ) {
    fail();
  }
  return record as LeaseRecord;
}

function linuxProcessStartIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim()
      .toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        bootId,
      )
    ) {
      return undefined;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^[0-9]+$/.test(startTicks)) return undefined;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return undefined;
  }
}

function processState(record: LeaseRecord): "active" | "stale" | "unknown" {
  const actualStart = linuxProcessStartIdentity(record.pid);
  if (record.process_start_id !== null && actualStart !== undefined) {
    return record.process_start_id === actualStart ? "active" : "stale";
  }
  try {
    process.kill(record.pid, 0);
    return record.version === MANAGED_LEASE_VERSION ? "unknown" : "active";
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ESRCH") return "stale";
    if (isNodeError(caught) && caught.code === "EPERM") {
      return record.version === MANAGED_LEASE_VERSION ? "unknown" : "active";
    }
    return "unknown";
  }
}

function managedProcessIsExact(record: ManagedLeaseRecord): boolean {
  if (process.platform !== "linux") return false;
  if (linuxProcessStartIdentity(record.pid) !== record.process_start_id) return false;
  try {
    return statSync(`/proc/${record.pid}`).uid === currentUid();
  } catch {
    return false;
  }
}

function managedProcessUsesRelease(
  record: ManagedLeaseRecord,
  releaseDirectory: string,
): boolean {
  if (!managedProcessIsExact(record)) return false;
  try {
    return (
      realpathSync(`/proc/${record.pid}/cwd`) ===
      realpathSync(resolve(releaseDirectory))
    );
  } catch {
    return false;
  }
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await validatePrivateParent(path);
  } catch (caught) {
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
}

async function validatePrivateParent(path: string): Promise<void> {
  try {
    const details = await lstat(dirname(path));
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      (details.mode & 0o7777) !== 0o700 ||
      details.uid !== currentUid()
    ) {
      fail();
    }
    let cursor = realpathSync(dirname(path));
    while (true) {
      const ancestor = statSync(cursor);
      const mode = ancestor.mode & 0o7777;
      const trustedOwner = ancestor.uid === currentUid() || ancestor.uid === 0;
      const writable = (mode & 0o022) !== 0;
      if (
        !ancestor.isDirectory() ||
        !trustedOwner ||
        (writable && ((mode & 0o1000) === 0 || ancestor.uid !== 0))
      ) {
        fail();
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch (caught) {
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
}

async function readLease(
  path: string,
  allowedLinkCounts: readonly number[] = [1],
): Promise<LeaseSnapshot> {
  let handle;
  try {
    const pathDetails = await lstat(path);
    if (
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      (pathDetails.mode & 0o7777) !== 0o600 ||
      pathDetails.uid !== currentUid() ||
      !allowedLinkCounts.includes(pathDetails.nlink) ||
      pathDetails.size <= 0 ||
      pathDetails.size > MAX_LEASE_BYTES
    ) {
      fail();
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const details = await handle.stat();
    if (
      !sameFile(pathDetails, details) ||
      !details.isFile() ||
      (details.mode & 0o7777) !== 0o600 ||
      details.uid !== currentUid() ||
      !allowedLinkCounts.includes(details.nlink) ||
      details.size <= 0 ||
      details.size > MAX_LEASE_BYTES
    ) {
      fail();
    }
    const buffer = Buffer.alloc(MAX_LEASE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > MAX_LEASE_BYTES) fail();
    return {
      device: details.dev,
      inode: details.ino,
      record: parseLeaseRecord(buffer.subarray(0, bytesRead).toString("utf8")),
    };
  } catch (caught) {
    if (caught instanceof BridgeRuntimeError) throw caught;
    throw caught;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function companionLeasePath(configPath: string): string {
  const absolute = resolve(configPath);
  const canonical = join(canonicalPathForUse(dirname(absolute)), basename(absolute));
  return `${canonical}.lock`;
}

function leaseClaimPath(path: string): string {
  return `${path}.claim`;
}

async function assertLeaseClaimAbsent(path: string): Promise<void> {
  try {
    await lstat(leaseClaimPath(path));
    fail("companion_lease_recovery_required");
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return;
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
}

async function claimLeasePath(path: string, snapshot: LeaseSnapshot): Promise<string> {
  const claimPath = leaseClaimPath(path);
  try {
    await link(path, claimPath);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "EEXIST") {
      fail("companion_lease_recovery_required");
    }
    fail("companion_identity_unavailable");
  }
  try {
    const [current, claim] = await Promise.all([
      readLease(path, [2]),
      readLease(claimPath, [2]),
    ]);
    if (
      !sameLeaseFile(current, snapshot) ||
      !sameLeaseFile(claim, snapshot) ||
      current.record.owner_token !== snapshot.record.owner_token ||
      claim.record.owner_token !== snapshot.record.owner_token
    ) {
      fail("companion_identity_unavailable");
    }
    return claimPath;
  } catch (caught) {
    await unlink(claimPath).catch(() => undefined);
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail("companion_identity_unavailable");
  }
}

async function removeClaimedLease(path: string, claimPath: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    await unlink(claimPath).catch(() => undefined);
    fail("companion_identity_unavailable");
  }
  try {
    await unlink(claimPath);
  } catch {
    fail("companion_lease_recovery_required");
  }
}

function publicStatus(record: LeaseRecord): Exclude<CompanionLeaseStatus, { state: "stopped" }> {
  const state = processState(record);
  if (record.version !== MANAGED_LEASE_VERSION) return { state, managed: false };
  return {
    state,
    managed: true,
    companionVersion: record.companion_version,
    protocolVersions: [...record.protocol_versions],
    releaseIntegrity: record.release_integrity,
  };
}

export async function inspectCompanionLease(
  configPath: string,
): Promise<CompanionLeaseStatus> {
  const path = companionLeasePath(configPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertLeaseClaimAbsent(path);
    try {
      return publicStatus((await readLease(path)).record);
    } catch (caught) {
      if (isNodeError(caught) && caught.code === "ENOENT") {
        await assertLeaseClaimAbsent(path);
        return { state: "stopped" };
      }
      if (
        caught instanceof BridgeRuntimeError &&
        caught.code === "companion_lease_invalid" &&
        attempt === 0
      ) {
        await assertLeaseClaimAbsent(path);
        continue;
      }
      if (caught instanceof BridgeRuntimeError) throw caught;
      fail();
    }
  }
  fail();
}

export async function stopManagedCompanion(
  configPath: string,
  expected?: ExpectedManagedLease,
): Promise<void> {
  const path = companionLeasePath(configPath);
  await assertLeaseClaimAbsent(path);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") fail("companion_not_running");
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  if (snapshot.record.version !== MANAGED_LEASE_VERSION) fail("companion_not_managed");
  if (!matchesManagedExpected(snapshot.record, expected)) {
    fail("companion_identity_unavailable");
  }
  if (!managedProcessIsExact(snapshot.record)) {
    const state = processState(snapshot.record);
    fail(state === "stale" ? "companion_lease_stale" : "companion_identity_unavailable");
  }
  const current = await readLease(path).catch(() => fail());
  if (
    current.device !== snapshot.device ||
    current.inode !== snapshot.inode ||
    current.record.version !== MANAGED_LEASE_VERSION ||
    current.record.owner_token !== snapshot.record.owner_token ||
    !matchesManagedExpected(current.record, expected) ||
    !managedProcessIsExact(current.record)
  ) {
    fail("companion_identity_unavailable");
  }
  try {
    process.kill(current.record.pid, "SIGTERM");
  } catch {
    fail("companion_identity_unavailable");
  }
}

export async function managedCompanionMatches(
  configPath: string,
  expected: ExpectedManagedLease,
): Promise<boolean> {
  const path = companionLeasePath(configPath);
  await assertLeaseClaimAbsent(path);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return false;
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  return (
    snapshot.record.version === MANAGED_LEASE_VERSION &&
    processState(snapshot.record) === "active" &&
    matchesManagedExpected(snapshot.record, expected) &&
    managedProcessIsExact(snapshot.record)
  );
}

function matchesManagedExpected(
  record: LeaseRecord,
  expected: ExpectedManagedLease | undefined,
): boolean {
  if (expected === undefined) return true;
  return (
    record.version === MANAGED_LEASE_VERSION &&
    record.companion_version === expected.companionVersion &&
    record.release_integrity === expected.releaseIntegrity &&
    (expected.launchToken === undefined || record.launch_token === expected.launchToken) &&
    (expected.releaseDirectory === undefined ||
      managedProcessUsesRelease(record, expected.releaseDirectory))
  );
}

async function clearStaleLease(
  configPath: string,
  matches: (record: LeaseRecord) => boolean,
): Promise<boolean> {
  const path = companionLeasePath(configPath);
  await assertLeaseClaimAbsent(path);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return false;
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  await validatePrivateParent(path);
  if (processState(snapshot.record) !== "stale" || !matches(snapshot.record)) {
    fail("companion_identity_unavailable");
  }
  const current = await readLease(path).catch(() => fail());
  if (
    current.device !== snapshot.device ||
    current.inode !== snapshot.inode ||
    current.record.owner_token !== snapshot.record.owner_token ||
    processState(current.record) !== "stale" ||
    !matches(current.record)
  ) {
    fail("companion_identity_unavailable");
  }
  await validatePrivateParent(path);
  const claimPath = await claimLeasePath(path, snapshot);
  try {
    const [currentClaimed, claim] = await Promise.all([
      readLease(path, [2]),
      readLease(claimPath, [2]),
    ]);
    if (
      !sameLeaseFile(currentClaimed, snapshot) ||
      !sameLeaseFile(claim, snapshot) ||
      currentClaimed.record.owner_token !== snapshot.record.owner_token ||
      claim.record.owner_token !== snapshot.record.owner_token ||
      processState(currentClaimed.record) !== "stale" ||
      processState(claim.record) !== "stale" ||
      !matches(currentClaimed.record) ||
      !matches(claim.record)
    ) {
      fail("companion_identity_unavailable");
    }
    await removeClaimedLease(path, claimPath);
    return true;
  } catch (caught) {
    await unlink(claimPath).catch(() => undefined);
    if (
      caught instanceof BridgeRuntimeError &&
      caught.code === "companion_lease_recovery_required"
    ) {
      throw caught;
    }
    fail("companion_identity_unavailable");
  }
}

export async function clearStaleCompanionLease(
  configPath: string,
  expected?: ExpectedManagedLease,
): Promise<boolean> {
  return await clearStaleLease(configPath, (record) =>
    expected === undefined
      ? record.version === LEASE_VERSION
      : matchesManagedExpected(record, expected),
  );
}

export async function clearStaleForegroundCompanionLease(
  configPath: string,
): Promise<boolean> {
  return await clearStaleLease(configPath, (record) => record.version === LEASE_VERSION);
}

export async function clearStaleMaintenanceLease(
  configPath: string,
  bindingId: string,
): Promise<boolean> {
  if (!canonicalToken(bindingId)) fail();
  const path = companionLeasePath(configPath);
  await assertLeaseClaimAbsent(path);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return false;
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  if (
    snapshot.record.version !== MAINTENANCE_LEASE_VERSION ||
    snapshot.record.binding_id !== bindingId
  ) {
    return false;
  }
  return await clearStaleLease(
    configPath,
    (record) =>
      record.version === MAINTENANCE_LEASE_VERSION &&
      record.binding_id === bindingId,
  );
}

export async function waitForCompanionStop(
  configPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let recoveryRequired = false;
  while (Date.now() < deadline) {
    let status: CompanionLeaseStatus;
    try {
      status = await inspectCompanionLease(configPath);
    } catch (caught) {
      if (
        caught instanceof BridgeRuntimeError &&
        caught.code === "companion_lease_recovery_required"
      ) {
        recoveryRequired = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw caught;
    }
    if (status.state === "stopped") return;
    if (status.state === "stale") fail("companion_lease_stale");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (recoveryRequired) fail("companion_lease_recovery_required");
  fail("companion_stop_timeout");
}

export class CompanionLease {
  readonly #path: string;
  readonly #ownerToken: string;

  private constructor(path: string, ownerToken: string) {
    this.#path = path;
    this.#ownerToken = ownerToken;
  }

  static async acquire(
    configPath: string,
    metadata?: ManagedLeaseMetadata | MaintenanceLeaseMetadata,
  ): Promise<CompanionLease> {
    const path = companionLeasePath(configPath);
    await ensurePrivateParent(path);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assertLeaseClaimAbsent(path);
      const ownerToken = randomBytes(32).toString("base64url");
      let handle;
      try {
        handle = await open(
          path,
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch (caught) {
        if (!isNodeError(caught) || caught.code !== "EEXIST") fail();
        await assertLeaseClaimAbsent(path);
        let snapshot: LeaseSnapshot;
        try {
          snapshot = await readLease(path);
        } catch (readError) {
          if (isNodeError(readError) && readError.code === "ENOENT") continue;
          fail();
        }
        const state = processState(snapshot.record);
        if (state === "active") fail("companion_already_running");
        if (state === "stale") fail("companion_lease_stale");
        fail();
      }

      const processStartId = linuxProcessStartIdentity(process.pid) ?? null;
      const managed =
        metadata !== undefined && "companionVersion" in metadata
          ? metadata
          : undefined;
      const maintenance =
        metadata !== undefined && "maintenanceBindingId" in metadata
          ? metadata
          : undefined;
      if (managed !== undefined && processStartId === null) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        fail("companion_identity_unavailable");
      }
      if (
        managed !== undefined &&
        (!exactVersion(managed.companionVersion) ||
          !canonicalToken(managed.launchToken) ||
          !protocolVersions([...managed.protocolVersions]) ||
          !sha512Integrity(managed.releaseIntegrity))
      ) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        fail();
      }
      if (
        maintenance !== undefined &&
        !canonicalToken(maintenance.maintenanceBindingId)
      ) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        fail();
      }
      const record: LeaseRecord =
        managed !== undefined
          ? {
              version: MANAGED_LEASE_VERSION,
              pid: process.pid,
              process_start_id: processStartId as string,
              owner_token: ownerToken,
              launch_token: managed.launchToken,
              mode: "managed",
              companion_version: managed.companionVersion,
              protocol_versions: [...managed.protocolVersions],
              release_integrity: managed.releaseIntegrity,
            }
          : maintenance !== undefined
            ? {
                version: MAINTENANCE_LEASE_VERSION,
                pid: process.pid,
                process_start_id: processStartId,
                owner_token: ownerToken,
                binding_id: maintenance.maintenanceBindingId,
                mode: "maintenance",
              }
            : {
                version: LEASE_VERSION,
                pid: process.pid,
                process_start_id: processStartId,
                owner_token: ownerToken,
              };
      try {
        const details = await handle.stat();
        if (
          !details.isFile() ||
          (details.mode & 0o7777) !== 0o600 ||
          details.uid !== currentUid() ||
          details.nlink !== 1
        ) {
          fail();
        }
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        await assertLeaseClaimAbsent(path);
        const written = await readLease(path);
        if (
          written.device !== details.dev ||
          written.inode !== details.ino ||
          written.record.owner_token !== ownerToken
        ) {
          fail();
        }
        return new CompanionLease(path, ownerToken);
      } catch (caught) {
        try {
          const [pathDetails, handleDetails] = await Promise.all([
            lstat(path),
            handle.stat(),
          ]);
          await assertLeaseClaimAbsent(path);
          if (sameFile(pathDetails, handleDetails) && pathDetails.nlink === 1) {
            await unlink(path);
          }
        } catch {
          // Fail closed. A surviving lease or claim requires explicit recovery.
        }
        if (caught instanceof BridgeRuntimeError) throw caught;
        fail();
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    fail();
  }

  async release(): Promise<void> {
    await assertLeaseClaimAbsent(this.#path);
    const snapshot = await readLease(this.#path).catch(() => fail());
    if (snapshot.record.owner_token !== this.#ownerToken) fail();
    let current: LeaseSnapshot;
    try {
      current = await readLease(this.#path);
    } catch {
      fail();
    }
    if (
      current.device !== snapshot.device ||
      current.inode !== snapshot.inode ||
      current.record.owner_token !== this.#ownerToken
    ) {
      fail();
    }
    const claimPath = await claimLeasePath(this.#path, snapshot);
    try {
      const [currentClaimed, claim] = await Promise.all([
        readLease(this.#path, [2]),
        readLease(claimPath, [2]),
      ]);
      if (
        !sameLeaseFile(currentClaimed, snapshot) ||
        !sameLeaseFile(claim, snapshot) ||
        currentClaimed.record.owner_token !== this.#ownerToken ||
        claim.record.owner_token !== this.#ownerToken
      ) {
        fail();
      }
      await removeClaimedLease(this.#path, claimPath);
    } catch (caught) {
      await unlink(claimPath).catch(() => undefined);
      if (
        caught instanceof BridgeRuntimeError &&
        caught.code === "companion_lease_recovery_required"
      ) {
        throw caught;
      }
      fail();
    }
  }
}
