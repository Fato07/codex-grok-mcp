"use strict";

const fs = require("node:fs");
const os = require("node:os");

const pinned = [];
globalThis.CODEX_GROK_FULL_PIN_CALLS = pinned;

const fixtureHome = process.env.HOME;
os.userInfo = () => ({
  username: "fixture",
  uid: 1,
  gid: 1,
  shell: "",
  homedir: fixtureHome,
});

function isDefaultSandPath(value) {
  const text = String(value ?? "");
  return text.startsWith("/home/box/sand-data") || text.startsWith("/home/box/agent-data");
}

function wrap(target, name) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function wrapped(...args) {
    if (typeof args[0] === "string" || Buffer.isBuffer(args[0])) {
      pinned.push(`${name}:${String(args[0])}`);
    }
    if (isDefaultSandPath(args[0])) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return original.apply(this, args);
  };
}

const originalRealpathNative =
  typeof fs.realpathSync === "function" && typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native.bind(fs.realpathSync)
    : undefined;
for (const name of ["lstatSync", "statSync", "realpathSync", "readlinkSync", "openSync"]) {
  wrap(fs, name);
}
if (originalRealpathNative !== undefined) {
  fs.realpathSync.native = function wrappedNative(filePath, options) {
    pinned.push(`realpathSync.native:${String(filePath)}`);
    if (isDefaultSandPath(filePath)) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return originalRealpathNative(filePath, options);
  };
}
