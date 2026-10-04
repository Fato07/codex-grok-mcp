"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARK = Symbol.for("codex-grok-real-root-fs-spy");
const roots = ["/home/box/sand-data", "/home/box/agent-data"].map((root) => path.resolve(root));
const hits = [];

function touchesRealRoot(value) {
  if (typeof value !== "string" || value === "") return false;
  const resolved = path.resolve(value);
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
      const err = deny(name, args[0]);
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
    "lstat",
    "stat",
    "realpath",
    "readlink",
    "open",
  ]) {
    wrap(fs, name);
    wrap(fs.promises, name);
  }
  if (originalRealpathNative !== undefined) {
    fs.realpathSync.native = function wrappedRealpathNative(filePath, options) {
      if (touchesRealRoot(filePath)) throw deny("realpathSync.native", filePath);
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
