"use strict";

const fs = require("node:fs");
const path = require("node:path");

const roots = ["/home/box/sand-data", "/home/box/agent-data"].map((root) => path.resolve(root));
const hits = [];

function touchesRealRoot(value) {
  if (typeof value !== "string" || value === "") return false;
  const resolved = path.resolve(value);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function wrap(target, name) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function wrappedFsCall(...args) {
    if (touchesRealRoot(args[0])) hits.push(`${name}:${args[0]}`);
    return original.apply(this, args);
  };
  Object.defineProperty(target[name], "name", { value: original.name });
}

const originalRealpathNative =
  typeof fs.realpathSync === "function" && typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native
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
  fs.realpathSync.native = function wrappedRealpathNative(...args) {
    if (touchesRealRoot(args[0])) hits.push(`realpathSync.native:${args[0]}`);
    return originalRealpathNative.apply(this, args);
  };
}

process.on("exit", () => {
  if (hits.length === 0) return;
  process.stderr.write(`REAL_ROOT_SYSCALLS ${JSON.stringify(hits)}\n`);
  process.exitCode = 1;
});
