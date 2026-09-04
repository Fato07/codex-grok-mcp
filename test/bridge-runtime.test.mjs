import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CompanionLease,
  clearStaleCompanionLease,
  companionLeasePath,
  inspectCompanionLease,
  stopManagedCompanion,
  waitForCompanionStop,
} from "../dist/bridge-runtime.js";

const token = (byte) => Buffer.alloc(32, byte).toString("base64url");

function record(overrides = {}) {
  return {
    version: 1,
    pid: 999_999,
    process_start_id: null,
    owner_token: token(1),
    ...overrides,
  };
}

test("companion lease is private, exclusive, and owner-released", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "private", "bridge.json");
  const lockPath = companionLeasePath(configPath);

  const lease = await CompanionLease.acquire(configPath);
  const [parent, lock] = await Promise.all([lstat(join(root, "private")), lstat(lockPath)]);
  const contents = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(parent.mode & 0o7777, 0o700);
  assert.equal(lock.mode & 0o7777, 0o600);
  assert.equal(lock.isFile(), true);
  assert.equal(contents.pid, process.pid);
  assert.match(contents.owner_token, /^[A-Za-z0-9_-]{43}$/);
  assert(
    contents.process_start_id === null ||
      /^linux:[0-9a-f-]{36}:[0-9]+$/.test(contents.process_start_id),
  );
  await assert.rejects(CompanionLease.acquire(configPath), {
    message: "companion_already_running",
  });

  await lease.release();
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("companion lease fails closed instead of racing to reclaim a stale lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "private", "bridge.json");
  const lockPath = companionLeasePath(configPath);
  await mkdir(join(root, "private"), { mode: 0o700 });
  await writeFile(lockPath, `${JSON.stringify(record())}\n`, { flag: "wx", mode: 0o600 });

  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, () => CompanionLease.acquire(configPath)),
  );
  assert(
    attempts.every(
      (attempt) =>
        attempt.status === "rejected" &&
        attempt.reason?.message === "companion_lease_stale",
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), record());
});

test("stale lease recovery unlinks only the revalidated exact owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "private", "bridge.json");
  const lockPath = companionLeasePath(configPath);
  await mkdir(join(root, "private"), { mode: 0o700 });
  await writeFile(lockPath, `${JSON.stringify(record())}\n`, { flag: "wx", mode: 0o600 });

  assert.equal(await clearStaleCompanionLease(configPath), true);
  assert.deepEqual(await inspectCompanionLease(configPath), { state: "stopped" });
  assert.equal(await clearStaleCompanionLease(configPath), false);
});

test("failed-candidate recovery requires the exact managed launch token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "private", "bridge.json");
  const lockPath = companionLeasePath(configPath);
  const integrity = `sha512-${Buffer.alloc(64, 4).toString("base64")}`;
  const launchToken = token(5);
  await mkdir(join(root, "private"), { mode: 0o700 });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      version: 2,
      pid: 999_999,
      process_start_id: "linux:00000000-0000-0000-0000-000000000000:1",
      owner_token: token(6),
      launch_token: launchToken,
      mode: "managed",
      companion_version: "0.2.0-beta.5",
      protocol_versions: [1, 2, 3],
      release_integrity: integrity,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );

  await assert.rejects(
    clearStaleCompanionLease(configPath, {
      companionVersion: "0.2.0-beta.5",
      releaseIntegrity: integrity,
      launchToken: token(7),
    }),
    { message: "companion_identity_unavailable" },
  );
  assert.equal((await lstat(lockPath)).isFile(), true);
  assert.equal(
    await clearStaleCompanionLease(configPath, {
      companionVersion: "0.2.0-beta.5",
      releaseIntegrity: integrity,
      launchToken,
    }),
    true,
  );
});

test("companion lease fails closed for malformed, symlinked, and wrong-mode locks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const kind of ["malformed", "symlink", "wrong-mode"]) {
    const parent = join(root, kind);
    const configPath = join(parent, "bridge.json");
    const lockPath = companionLeasePath(configPath);
    await mkdir(parent, { mode: 0o700 });
    if (kind === "symlink") {
      const target = join(parent, "target");
      await writeFile(target, `${JSON.stringify(record())}\n`, { mode: 0o600 });
      await symlink(target, lockPath);
    } else {
      await writeFile(
        lockPath,
        kind === "malformed" ? "{}\n" : `${JSON.stringify(record())}\n`,
        { mode: kind === "wrong-mode" ? 0o644 : 0o600 },
      );
      if (kind === "wrong-mode") await chmod(lockPath, 0o644);
    }

    await assert.rejects(CompanionLease.acquire(configPath), {
      message: "companion_lease_invalid",
    });
    assert.equal((await lstat(lockPath)).isSymbolicLink(), kind === "symlink");
  }
});

test("companion lease release refuses a replaced owner token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "private", "bridge.json");
  const lockPath = companionLeasePath(configPath);
  const lease = await CompanionLease.acquire(configPath);
  const contents = JSON.parse(await readFile(lockPath, "utf8"));
  contents.owner_token = token(2);
  await writeFile(lockPath, `${JSON.stringify(contents)}\n`);

  await assert.rejects(lease.release(), { message: "companion_lease_invalid" });
  assert.equal((await lstat(lockPath)).isFile(), true);
});

test("companion lease rejects a directory owned by another uid", async (context) => {
  if (typeof process.getuid !== "function") return;
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "private");
  await mkdir(parent, { mode: 0o700 });
  const uid = process.getuid();
  context.mock.method(process, "getuid", () => uid + 1);

  await assert.rejects(CompanionLease.acquire(join(parent, "bridge.json")), {
    message: "companion_lease_invalid",
  });
});

test("lifecycle control never signals an unmanaged companion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  const configPath = join(root, "private", "bridge.json");
  const lease = await CompanionLease.acquire(configPath);
  context.after(async () => {
    await lease.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(await inspectCompanionLease(configPath), {
    state: "active",
    managed: false,
  });
  await assert.rejects(stopManagedCompanion(configPath), {
    message: "companion_not_managed",
  });
});

test("managed stop verifies Linux process identity and waits for owner release", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const root = await mkdtemp(join(tmpdir(), "codex-grok-runtime-"));
  const configPath = join(root, "private", "bridge.json");
  const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const moduleUrl = new URL("../dist/bridge-runtime.js", import.meta.url).href;
  const source = `
    import { CompanionLease } from ${JSON.stringify(moduleUrl)};
    const lease = await CompanionLease.acquire(process.argv[1], {
      companionVersion: "0.2.0-beta.5",
      launchToken: ${JSON.stringify(token(8))},
      protocolVersions: [1, 2, 3],
      releaseIntegrity: process.argv[2],
    });
    process.once("SIGTERM", async () => {
      await lease.release();
      process.exit(0);
    });
    process.stdout.write("ready\\n");
    setInterval(() => undefined, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, configPath, integrity], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, "data");

  assert.deepEqual(await inspectCompanionLease(configPath), {
    state: "active",
    managed: true,
    companionVersion: "0.2.0-beta.5",
    protocolVersions: [1, 2, 3],
    releaseIntegrity: integrity,
  });
  await stopManagedCompanion(configPath);
  await waitForCompanionStop(configPath, 5_000);
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.deepEqual(await inspectCompanionLease(configPath), { state: "stopped" });
});
