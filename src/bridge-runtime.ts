import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LEASE_VERSION = 1;
const MAX_LEASE_BYTES = 1_024;

type LeaseRecord = {
  version: 1;
  pid: number;
  process_start_id: string | null;
  owner_token: string;
};

type LeaseSnapshot = {
  device: number;
  inode: number;
  record: LeaseRecord;
};

export class BridgeRuntimeError extends Error {
  readonly code:
    | "companion_already_running"
    | "companion_lease_invalid"
    | "companion_lease_stale";

  constructor(
    code:
      | "companion_already_running"
      | "companion_lease_invalid"
      | "companion_lease_stale",
  ) {
    super(code);
    this.name = "BridgeRuntimeError";
    this.code = code;
  }
}

function fail(
  code:
    | "companion_already_running"
    | "companion_lease_invalid"
    | "companion_lease_stale" = "companion_lease_invalid",
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
  if (
    keys.length !== 4 ||
    keys[0] !== "owner_token" ||
    keys[1] !== "pid" ||
    keys[2] !== "process_start_id" ||
    keys[3] !== "version" ||
    record.version !== LEASE_VERSION ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    (record.pid as number) > 2_147_483_647 ||
    (record.process_start_id !== null &&
      (typeof record.process_start_id !== "string" ||
        !/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/.test(
          record.process_start_id,
        ))) ||
    typeof record.owner_token !== "string" ||
    !canonicalToken(record.owner_token)
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
    return "active";
  } catch (caught) {
    if (isNodeError(caught) && caught.code === "ESRCH") return "stale";
    if (isNodeError(caught) && caught.code === "EPERM") return "active";
    return "unknown";
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

export class CompanionLease {
  readonly #path: string;
  readonly #ownerToken: string;

  private constructor(path: string, ownerToken: string) {
    this.#path = path;
    this.#ownerToken = ownerToken;
  }

  static async acquire(configPath: string): Promise<CompanionLease> {
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

      const record: LeaseRecord = {
        version: LEASE_VERSION,
        pid: process.pid,
        process_start_id: linuxProcessStartIdentity(process.pid) ?? null,
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
