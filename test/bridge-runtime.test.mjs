import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CompanionLease,
  companionLeasePath,
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
