"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const MARK = Symbol.for("codex-grok-real-root-fs-spy");
const hits = [];

function homeRootsAtLoad() {
  const homes = new Set();
  try {
    const passwd = os.userInfo().homedir;
    if (typeof passwd === "string" && passwd.trim() !== "") homes.add(path.resolve(passwd));
  } catch {
    // No passwd home in this process.
  }
  return [...homes];
}

function credentialTrees(home) {
  return [
    path.join(home, ".grok"),
    path.join(home, ".codex"),
    path.join(home, ".ssh"),
    path.join(home, ".config", "codex-grok-mcp"),
    path.join(home, ".local", "share", "codex-grok-mcp"),
    path.join(home, ".local", "state", "codex-grok-mcp"),
  ];
}

const roots = [
  "/home/box/sand-data",
  "/home/box/agent-data",
  ...homeRootsAtLoad().flatMap(credentialTrees),
].map((root) => path.resolve(root));

function pathFromArg(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString();
  }
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function touchesRealRoot(value) {
  const filePath = pathFromArg(value);
  if (typeof filePath !== "string" || filePath === "") return false;
  const resolved = path.resolve(filePath);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function deny(name, filePath) {
  hits.push(`${name}:${filePath}`);
  const err = new Error(`REAL_ROOT_SYSCALL ${name}:${filePath}`);
  err.code = "EPERM";
  return err;
}

function wrap(target, name) {
  const original = target[name];
  if (typeof original !== "function") return;
  const wrapped = function wrappedFsCall(...args) {
    if (touchesRealRoot(args[0])) {
      const err = deny(name, pathFromArg(args[0]));
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        queueMicrotask(() => cb(err));
        return;
      }
      throw err;
    }
    return original.apply(this, args);
  };
  Object.defineProperty(wrapped, "name", { value: original.name });
  target[name] = wrapped;
}

if (globalThis[MARK] !== true) {
  globalThis[MARK] = true;
  const originalRealpathNative =
    typeof fs.realpathSync === "function" && typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native.bind(fs.realpathSync)
      : undefined;
  for (const name of [
    "lstatSync",
    "statSync",
    "realpathSync",
    "readlinkSync",
    "openSync",
    "existsSync",
    "accessSync",
    "readFileSync",
    "readdirSync",
    "opendirSync",
    "statfsSync",
    "lstat",
    "stat",
    "realpath",
    "readlink",
    "open",
    "exists",
    "access",
    "readFile",
    "readdir",
    "opendir",
    "statfs",
  ]) {
    wrap(fs, name);
    wrap(fs.promises, name);
  }
  if (originalRealpathNative !== undefined) {
    fs.realpathSync.native = function wrappedRealpathNative(filePath, options) {
      if (touchesRealRoot(filePath)) throw deny("realpathSync.native", pathFromArg(filePath));
      return originalRealpathNative(filePath, options);
    };
  }
  process.on("exit", () => {
    if (hits.length === 0) return;
    process.stderr.write(`REAL_ROOT_SYSCALLS ${JSON.stringify(hits)}\n`);
    process.exitCode = 1;
  });
}

const requireFlag = `--require ${__filename}`;
const current = process.env.NODE_OPTIONS ?? "";
if (current.includes("real-root-fs-spy.cjs") === false && current.includes(__filename) === false) {
  process.env.NODE_OPTIONS = current.trim() === "" ? requireFlag : `${current} ${requireFlag}`;
}
