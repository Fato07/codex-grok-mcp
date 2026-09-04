import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LEASE_VERSION = 1;
const MANAGED_LEASE_VERSION = 2;
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

type LeaseRecord = LegacyLeaseRecord | ManagedLeaseRecord;

export type ManagedLeaseMetadata = {
  companionVersion: string;
  launchToken: string;
  protocolVersions: readonly number[];
  releaseIntegrity: string;
};

export type ExpectedManagedLease = {
  companionVersion: string;
  releaseIntegrity: string;
  launchToken?: string;
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
    | "companion_lease_stale"
    | "companion_not_managed"
    | "companion_not_running"
    | "companion_stop_timeout";

  constructor(
    code:
      | "companion_already_running"
      | "companion_identity_unavailable"
      | "companion_lease_invalid"
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

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const details = await lstat(parent);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      (details.mode & 0o7777) !== 0o700 ||
      details.uid !== currentUid()
    ) {
      fail();
    }
  } catch (caught) {
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
}

async function readLease(path: string): Promise<LeaseSnapshot> {
  let handle;
  try {
    const pathDetails = await lstat(path);
    if (
      pathDetails.isSymbolicLink() ||
      !pathDetails.isFile() ||
      (pathDetails.mode & 0o7777) !== 0o600 ||
      pathDetails.uid !== currentUid() ||
      pathDetails.nlink !== 1 ||
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
      details.nlink !== 1 ||
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
  return `${resolve(configPath)}.lock`;
}

function publicStatus(record: LeaseRecord): Exclude<CompanionLeaseStatus, { state: "stopped" }> {
  const state = processState(record);
  if (record.version === LEASE_VERSION) return { state, managed: false };
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
  try {
    return publicStatus((await readLease(companionLeasePath(configPath))).record);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return { state: "stopped" };
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
}

export async function stopManagedCompanion(configPath: string): Promise<void> {
  const path = companionLeasePath(configPath);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") fail("companion_not_running");
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  if (snapshot.record.version !== MANAGED_LEASE_VERSION) fail("companion_not_managed");
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

function matchesExpected(
  record: LeaseRecord,
  expected: ExpectedManagedLease | undefined,
): boolean {
  if (expected === undefined) return true;
  return (
    record.version === MANAGED_LEASE_VERSION &&
    record.companion_version === expected.companionVersion &&
    record.release_integrity === expected.releaseIntegrity &&
    (expected.launchToken === undefined || record.launch_token === expected.launchToken)
  );
}

export async function clearStaleCompanionLease(
  configPath: string,
  expected?: ExpectedManagedLease,
): Promise<boolean> {
  const path = companionLeasePath(configPath);
  let snapshot: LeaseSnapshot;
  try {
    snapshot = await readLease(path);
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ENOENT") return false;
    if (caught instanceof BridgeRuntimeError) throw caught;
    fail();
  }
  if (processState(snapshot.record) !== "stale" || !matchesExpected(snapshot.record, expected)) {
    fail("companion_identity_unavailable");
  }
  const current = await readLease(path).catch(() => fail());
  if (
    current.device !== snapshot.device ||
    current.inode !== snapshot.inode ||
    current.record.owner_token !== snapshot.record.owner_token ||
    processState(current.record) !== "stale" ||
    !matchesExpected(current.record, expected)
  ) {
    fail("companion_identity_unavailable");
  }
  try {
    await unlink(path);
    return true;
  } catch {
    fail("companion_identity_unavailable");
  }
}

export async function waitForCompanionStop(
  configPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspectCompanionLease(configPath);
    if (status.state === "stopped") return;
    if (status.state === "stale") fail("companion_lease_stale");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
    managed?: ManagedLeaseMetadata,
  ): Promise<CompanionLease> {
    const path = companionLeasePath(configPath);
    await ensurePrivateParent(path);

    for (let attempt = 0; attempt < 4; attempt += 1) {
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
      const record: LeaseRecord =
        managed === undefined
          ? {
              version: LEASE_VERSION,
              pid: process.pid,
              process_start_id: processStartId,
              owner_token: ownerToken,
            }
          : {
              version: MANAGED_LEASE_VERSION,
              pid: process.pid,
              process_start_id: processStartId as string,
              owner_token: ownerToken,
              launch_token: managed.launchToken,
              mode: "managed",
              companion_version: managed.companionVersion,
              protocol_versions: [...managed.protocolVersions],
              release_integrity: managed.releaseIntegrity,
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
        return new CompanionLease(path, ownerToken);
      } catch (caught) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        if (caught instanceof BridgeRuntimeError) throw caught;
        fail();
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    fail();
  }

  async release(): Promise<void> {
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
    try {
      await unlink(this.#path);
    } catch {
      fail();
    }
  }
}
