"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

const SAND_FILE_IDS = new Map([
  [
    path.resolve("/home/box/sand-data/gateway.json"),
    { dev: 33301, ino: 44401, file: true },
  ],
  [
    path.resolve("/home/box/agent-data/gateway.json"),
    { dev: 33302, ino: 44411, file: true },
  ],
]);
const SAND_DIR_IDS = new Map([
  [path.resolve("/home/box/sand-data/config"), { dev: 33301, ino: 44402, file: false }],
  [path.resolve("/home/box/agent-data/config"), { dev: 33302, ino: 44412, file: false }],
]);
globalThis.CODEX_GROK_FULL_PIN_SAND_IDS = {
  gateway: SAND_FILE_IDS.get(path.resolve("/home/box/sand-data/gateway.json")),
  config: SAND_DIR_IDS.get(path.resolve("/home/box/sand-data/config")),
};

function fakeStats(identity) {
  return {
    dev: identity.dev,
    ino: identity.ino,
    nlink: 1,
    mode: identity.file ? 0o100600 : 0o40700,
    uid: 1,
    gid: 1,
    size: identity.file ? 2 : 0,
    isFile: () => identity.file === true,
    isDirectory: () => identity.file === false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function identityFor(value) {
  const text = typeof value === "string" ? path.resolve(value) : String(value ?? "");
  return SAND_FILE_IDS.get(text) ?? SAND_DIR_IDS.get(text);
}

function isDefaultSandPath(value) {
  const text = String(value ?? "");
  return text.startsWith("/home/box/sand-data") || text.startsWith("/home/box/agent-data");
}

function applyOverlay(st) {
  if (st == null) return st;
  const overlays = globalThis.CODEX_GROK_FULL_PIN_OVERLAYS ?? [];
  const hit = overlays.find((entry) => entry.from.dev === st.dev && entry.from.ino === st.ino);
  if (hit === undefined) return st;
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
    dev: hit.to.dev,
    ino: hit.to.ino,
    nlink: 1,
    isFile: () => hit.to.file === true,
    isDirectory: () => hit.to.file === false,
    isSymbolicLink: () => false,
  });
}

function wrap(target, name) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function wrapped(...args) {
    if (typeof args[0] === "string" || Buffer.isBuffer(args[0])) {
      pinned.push(`${name}:${String(args[0])}`);
    }
    const identity = identityFor(args[0]);
    if (identity !== undefined && (name === "lstatSync" || name === "statSync")) {
      return fakeStats(identity);
    }
    if (identity !== undefined && (name === "realpathSync" || name === "readlinkSync")) {
      return path.resolve(String(args[0]));
    }
    if (isDefaultSandPath(args[0])) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    const result = original.apply(this, args);
    if (name === "lstatSync" || name === "statSync") return applyOverlay(result);
    return result;
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
    const identity = identityFor(filePath);
    if (identity !== undefined) return path.resolve(String(filePath));
    if (isDefaultSandPath(filePath)) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return originalRealpathNative(filePath, options);
  };
}

const originalFstat = fs.fstatSync.bind(fs);
fs.fstatSync = function wrappedFstat(fd, options) {
  return applyOverlay(originalFstat(fd, options));
};
