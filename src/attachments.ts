import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TestRealDataRootError,
  candidateGrokBotDataRoots,
  grokBotDataRoot,
  isLexicalGrokBotDataRootPath,
} from "./grok-bot-client.js";

export type AttachmentPathGuard = {
  homes?: readonly string[];
  sandRoots?: readonly string[];
  resolveOpenedFd?: (fd: number) => string;
};

function foldPath(path: string): string {
  const folded =
    process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
  return process.platform === "darwin" ? folded.normalize("NFC") : folded;
}

function pathsEqual(left: string, right: string): boolean {
  return foldPath(left) === foldPath(right);
}

function pathIsUnder(path: string, root: string): boolean {
  const left = foldPath(path);
  const right = foldPath(root);
  return left === right || left.startsWith(`${right}${sep}`);
}

function nativeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    return realpathSync(path);
  }
}

function resolveOpenedFdPath(fd: number, resolveOpenedFd?: (fd: number) => string): string | undefined {
  if (resolveOpenedFd !== undefined) {
    try {
      return resolveOpenedFd(fd);
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
      return undefined;
    }
  }
  try {
    return realpathSync(`/proc/self/fd/${String(fd)}`);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    return undefined;
  }
}

export const ATTACHMENT_PROTOCOL_VERSION = 4 as const;
export const ATTACHMENT_SEND_CAPABILITY = "attachment_send_v1" as const;
export const ATTACHMENT_READ_CAPABILITY = "attachment_read_v1" as const;
export const ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV = "CODEX_GROK_ATTACHMENT_HOST_ALLOWLIST_EXTRA";
export const PINNED_ATTACHMENT_HOST_VERSIONS = Object.freeze(["f5c783a"]);
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
export const ATTACHMENT_TTL_MS = 15 * 60 * 1000;
export const ATTACHMENT_NAME_MAX_BYTES = 255;
export const ATTACHMENT_CHUNK_B64_MAX = 87_384;
export const ATTACHMENT_MAX_STAGED_UPLOADS = 8;
export const ATTACHMENT_MAX_STAGED_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_MAX_FETCH_CACHED = 8;
export const ATTACHMENT_MAX_FETCH_CACHE_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_TOKEN_KEY = randomBytes(32);

export const ATTACHMENT_ERROR_CODES = [
  "ATTACHMENT_REJECTED",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_STALE",
  "ATTACHMENT_INTEGRITY",
] as const;

export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[number];

export type AttachmentKind = "text" | "image" | "pdf" | "binary" | "external";

export type AttachmentMeta = {
  entry_id: string;
  seq: number | null;
  speaker: "user" | "bot" | "peer";
  name: string;
  kind: AttachmentKind;
  size?: number;
  timestamp_ms: number | null;
};

export type LocalAttachmentDecision = {
  bytes: Buffer;
  mime: string;
  extension: string;
  sha256: string;
  size: number;
  name: string;
  path_identity: string;
  resolved_path: string;
};

export type ConfinedAttachmentBytes = {
  bytes: Buffer;
  sha256: string;
  resolved_path: string;
  mime: string;
};

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message = "Attachment request failed.") {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

type UploadRecord = {
  uploadId: string;
  botId: string;
  name: string;
  mime: string;
  totalSize: number;
  sha256: string;
  received: number;
  nextSeq: number;
  seqHashes: Map<number, string>;
  createdAt: number;
  complete: boolean;
};

type FetchCacheRecord = {
  botId: string;
  entryId: string;
  sha256: string;
  mime: string;
  name: string;
  bytes: Buffer;
  createdAt: number;
};

export type CommittedAttachment = {
  ref: string;
  botId: string;
  path: string;
  name: string;
  sha256: string;
  createdAt: number;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from("%PDF");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MZ_MAGIC = Buffer.from([0x4d, 0x5a]);

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".diff", ".patch"]);
const JSON_EXTENSIONS = new Set([".json"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const PNG_EXTENSIONS = new Set([".png"]);
const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);
const ALLOWED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...PNG_EXTENSIONS,
  ...JPEG_EXTENSIONS,
]);

function fail(code: AttachmentErrorCode, message?: string): never {
  throw new AttachmentError(code, message);
}

function isNodeError(caught: unknown): caught is NodeJS.ErrnoException {
  return caught instanceof Error && "code" in caught;
}

function hasDotDotSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => segment === "..");
}

export function assertAttachmentBotId(botId: string): void {
  if (ATTACHMENT_BOT_ID_PATTERN.test(botId) === false) fail("ATTACHMENT_REJECTED");
}

function pinResolvedFdPath(resolved: string, expected: Stats): string {
  let pathStats: Stats;
  try {
    pathStats = lstatSync(resolved);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    fail("ATTACHMENT_REJECTED");
  }
  if (
    pathStats.dev !== expected.dev ||
    pathStats.ino !== expected.ino ||
    pathStats.isFile() === false ||
    pathStats.nlink !== 1
  ) {
    fail("ATTACHMENT_REJECTED");
  }
  return resolved;
}

function inboundResolvedFdPath(
  fd: number,
  expected: Stats,
  resolveOpenedFd?: (fd: number) => string,
): string {
  const resolved = resolveOpenedFdPath(fd, resolveOpenedFd);
  if (resolved === undefined) fail("ATTACHMENT_REJECTED");
  return pinResolvedFdPath(canonicalizeOpenedPath(resolved, expected), expected);
}

function outboundResolvedFdPath(
  fd: number,
  fallback: string,
  expected: Stats,
  resolveOpenedFd?: (fd: number) => string,
): string {
  const opened = resolveOpenedFdPath(fd, resolveOpenedFd);
  if (opened !== undefined) return pinResolvedFdPath(canonicalizeOpenedPath(opened, expected), expected);
  let resolved: string;
  try {
    resolved = nativeRealpath(fallback);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    fail("ATTACHMENT_REJECTED");
  }
  return pinResolvedFdPath(canonicalizeOpenedPath(resolved, expected), expected);
}

function canonicalizeOpenedPath(path: string, expected: Stats): string {
  try {
    const native = nativeRealpath(path);
    return pinResolvedFdPath(native, expected);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    if (caught instanceof AttachmentError) throw caught;
    return path;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function startsWith(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function textPrefix(bytes: Buffer): string {
  return bytes.subarray(0, Math.min(bytes.length, 256)).toString("utf8").trimStart().toLowerCase();
}

function isPlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const limit = Math.min(bytes.length, 8_192);
  for (let index = 0; index < limit; index += 1) {
    const code = bytes[index];
    if (code === undefined) break;
    if (code < 9 || (code > 13 && code < 32)) return false;
  }
  const prefix = textPrefix(bytes);
  return (
    prefix.startsWith("<!doctype html") === false &&
    prefix.startsWith("<html") === false &&
    prefix.startsWith("<svg") === false
  );
}

export function attachmentExtension(name: string): string {
  const ext = basename(name).includes(".")
    ? `.${basename(name).split(".").pop()?.toLowerCase() ?? ""}`
    : "";
  return ext;
}

export function mimeForExtension(extension: string): string | undefined {
  if (TEXT_EXTENSIONS.has(extension)) {
    if (extension === ".md") return "text/markdown";
    if (extension === ".csv") return "text/csv";
    if (extension === ".diff" || extension === ".patch") return "text/x-diff";
    return "text/plain";
  }
  if (JSON_EXTENSIONS.has(extension)) return "application/json";
  if (PDF_EXTENSIONS.has(extension)) return "application/pdf";
  if (PNG_EXTENSIONS.has(extension)) return "image/png";
  if (JPEG_EXTENSIONS.has(extension)) return "image/jpeg";
  return undefined;
}

export function kindForExtension(extension: string): AttachmentKind {
  if (PNG_EXTENSIONS.has(extension) || JPEG_EXTENSIONS.has(extension)) return "image";
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (TEXT_EXTENSIONS.has(extension) || JSON_EXTENSIONS.has(extension)) return "text";
  return "binary";
}

export function sniffMime(bytes: Buffer, extension: string): string {
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, ELF_MAGIC) || startsWith(bytes, MZ_MAGIC)) {
    fail("ATTACHMENT_REJECTED");
  }
  const expected = mimeForExtension(extension);
  if (expected === undefined || ALLOWED_EXTENSIONS.has(extension) === false) {
    fail("ATTACHMENT_REJECTED");
  }
  if (PNG_EXTENSIONS.has(extension)) {
    if (startsWith(bytes, PNG_MAGIC) === false) fail("ATTACHMENT_REJECTED");
    return "image/png";
  }
  if (JPEG_EXTENSIONS.has(extension)) {
    if (startsWith(bytes, JPEG_MAGIC) === false) fail("ATTACHMENT_REJECTED");
    return "image/jpeg";
  }
  if (PDF_EXTENSIONS.has(extension)) {
    if (startsWith(bytes, PDF_MAGIC) === false) fail("ATTACHMENT_REJECTED");
    return "application/pdf";
  }
  if (JSON_EXTENSIONS.has(extension)) {
    const prefix = textPrefix(bytes);
    if ((prefix.startsWith("{") || prefix.startsWith("[")) === false || isPlainText(bytes) === false) {
      fail("ATTACHMENT_REJECTED");
    }
    return "application/json";
  }
  if (isPlainText(bytes) === false) fail("ATTACHMENT_REJECTED");
  return expected;
}

export function sanitizeAttachmentName(name: string): string {
  const cleaned = basename(name);
  if (
    cleaned.length === 0 ||
    cleaned === "." ||
    cleaned === ".." ||
    Buffer.byteLength(cleaned, "utf8") > ATTACHMENT_NAME_MAX_BYTES ||
    /[/\\]/.test(cleaned) ||
    /[\u0000-\u001f\u007f]/.test(cleaned)
  ) {
    fail("ATTACHMENT_REJECTED");
  }
  return cleaned;
}

export function attachmentHostAllowlist(env: NodeJS.ProcessEnv = process.env): {
  versions: Set<string>;
  unverifiedExtra: string[];
} {
  const versions = new Set<string>(PINNED_ATTACHMENT_HOST_VERSIONS);
  const unverifiedExtra: string[] = [];
  const extra = env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
  if (extra === undefined || extra.trim() === "") return { versions, unverifiedExtra };
  for (const part of extra.split(/[,\s]+/)) {
    const value = part.trim();
    if (value === "" || versions.has(value)) continue;
    unverifiedExtra.push(value);
    versions.add(value);
  }
  return { versions, unverifiedExtra };
}

export function logUnverifiedHostOverride(
  unverifiedExtra: string[],
  write: (chunk: string) => unknown = (chunk) => process.stderr.write(chunk),
): void {
  if (unverifiedExtra.length === 0) return;
  write("unverified host: CODEX_GROK_ATTACHMENT_HOST_ALLOWLIST_EXTRA is enabled\n");
}

export function isAttachmentHostAllowed(
  hostVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  write?: (chunk: string) => unknown,
): boolean {
  const { versions, unverifiedExtra } = attachmentHostAllowlist(env);
  const allowed = versions.has(hostVersion);
  if (allowed && unverifiedExtra.includes(hostVersion)) {
    logUnverifiedHostOverride(unverifiedExtra, write);
  }
  return allowed;
}

export function defaultAttachmentStagingRoot(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const configured = environment.CODEX_GROK_ATTACHMENT_STAGING_ROOT;
  if (configured !== undefined && configured !== "" && isAbsolute(configured)) return configured;
  const xdgStateHome = environment.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, ".local", "state");
  return join(stateHome, "codex-grok-mcp", "attachments");
}

function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function attachmentPreviewToken(input: {
  bot_id: string;
  path_identity: string;
  sha256: string;
  size: number;
  mime: string;
  name: string;
  roster_fingerprint: string;
}): string {
  return createHmac("sha256", PREVIEW_TOKEN_KEY)
    .update(
      [
        input.bot_id,
        input.path_identity,
        input.sha256,
        String(input.size),
        input.mime,
        input.name,
        input.roster_fingerprint,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const nonblock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  return openSync(path, flags | noFollow | nonblock, mode);
}

function assertRegularFile(path: string): Stats {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink() || details.isFile() === false) fail("ATTACHMENT_REJECTED");
    return details;
  } catch (caught) {
    if (caught instanceof TestRealDataRootError || caught instanceof AttachmentError) throw caught;
    fail("ATTACHMENT_REJECTED");
  }
}

function requireAddedGuardList(
  value: readonly string[] | undefined,
  label: "homes" | "sandRoots",
): readonly string[] {
  if (value === undefined) return [];
  if (value.length === 0) {
    throw new TypeError(`AttachmentPathGuard.${label} must not be empty`);
  }
  return value;
}

function accountHomes(
  environment: NodeJS.ProcessEnv,
  home: string,
  extraHomes?: readonly string[],
): string[] {
  const homes = new Set<string>();
  const add = (value: string | undefined): void => {
    if (typeof value !== "string" || value.trim() === "") return;
    const resolved = resolve(value);
    homes.add(resolved);
    try {
      homes.add(nativeRealpath(resolved));
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
    }
  };
  add(home);
  add(environment.HOME);
  add(homedir());
  try {
    add(userInfo().homedir);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
  }
  if (extraHomes !== undefined) {
    for (const extra of extraHomes) add(extra);
  }
  return [...homes];
}

function absoluteEnvPath(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value !== undefined && value !== "" && isAbsolute(value) ? value : undefined;
}

function connectorTree(root: string): string {
  return join(root, "codex-grok-mcp");
}

function deniedAttachmentLocations(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  guard?: AttachmentPathGuard,
): { prefixes: string[]; files: string[]; lexicalOnly: Set<string> } {
  const prefixes: string[] = [];
  const files: string[] = [];
  const lexicalOnly = new Set<string>();
  const extraHomes = requireAddedGuardList(guard?.homes, "homes");
  const extraSandRoots = requireAddedGuardList(guard?.sandRoots, "sandRoots");
  const remember = (target: string[], value: string, lexical = false): void => {
    const resolved = resolve(value);
    target.push(resolved);
    if (lexical) {
      lexicalOnly.add(resolved);
      return;
    }
    try {
      const real = nativeRealpath(resolved);
      if (real !== resolved) target.push(real);
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
    }
  };
  const addPrefix = (value: string, lexical = false): void => {
    remember(prefixes, value, lexical);
  };
  const addFile = (value: string, lexical = false): void => {
    remember(files, value, lexical);
  };
  const addSandRootSecrets = (root: string, lexical = false): void => {
    addFile(join(root, "gateway.json"), lexical);
    addPrefix(join(root, "config"), lexical);
  };
  for (const candidate of accountHomes(environment, home, extraHomes)) {
    addPrefix(join(candidate, ".grok"));
    addPrefix(join(candidate, ".codex"));
    addPrefix(join(candidate, ".ssh"));
    addFile(join(candidate, ".grok", "auth.json"));
    addFile(join(candidate, ".codex", "auth.json"));
    addPrefix(connectorTree(join(candidate, ".config")));
    addPrefix(connectorTree(join(candidate, ".local", "share")));
    addPrefix(connectorTree(join(candidate, ".local", "state")));
    addFile(join(candidate, ".config", "codex-grok-mcp", "bridge.json"));
    addFile(join(candidate, ".config", "codex-grok-mcp", "bridge.json.lifecycle.json"));
  }
  const xdgConfig = absoluteEnvPath(environment, "XDG_CONFIG_HOME");
  if (xdgConfig !== undefined) {
    addPrefix(connectorTree(xdgConfig));
    addFile(join(xdgConfig, "codex-grok-mcp", "bridge.json"));
    addFile(join(xdgConfig, "codex-grok-mcp", "bridge.json.lifecycle.json"));
  }
  const xdgData = absoluteEnvPath(environment, "XDG_DATA_HOME");
  if (xdgData !== undefined) addPrefix(connectorTree(xdgData));
  const xdgState = absoluteEnvPath(environment, "XDG_STATE_HOME");
  if (xdgState !== undefined) addPrefix(connectorTree(xdgState));
  const stagingRoot = absoluteEnvPath(environment, "CODEX_GROK_ATTACHMENT_STAGING_ROOT");
  if (stagingRoot !== undefined) addPrefix(stagingRoot);
  const grokHome = absoluteEnvPath(environment, "GROK_HOME");
  if (grokHome !== undefined) addPrefix(grokHome);
  const codexHome = absoluteEnvPath(environment, "CODEX_HOME");
  if (codexHome !== undefined) addPrefix(codexHome);
  const configuredAuth = environment.GROK_MCP_AUTH_PATH?.trim();
  if (configuredAuth !== undefined && configuredAuth !== "") {
    addFile(isAbsolute(configuredAuth) ? configuredAuth : resolve(configuredAuth));
  }
  try {
    grokBotDataRoot(environment);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
  }
  for (const root of extraSandRoots) addSandRootSecrets(root);
  for (const root of candidateGrokBotDataRoots(environment)) {
    addSandRootSecrets(root, guard !== undefined && isLexicalGrokBotDataRootPath(root));
  }
  return { prefixes, files, lexicalOnly };
}

function pinPathIdentity(path: string, identities: Set<string>, directoriesOnly = false): void {
  try {
    const details = lstatSync(path);
    if (directoriesOnly && details.isDirectory() === false && details.isSymbolicLink() === false) {
      return;
    }
    if (directoriesOnly === false || details.isDirectory()) {
      identities.add(`${details.dev}:${details.ino}`);
    }
    if (details.isSymbolicLink() === false) return;
    const real = nativeRealpath(path);
    const realDetails = lstatSync(real);
    if (directoriesOnly && realDetails.isDirectory() === false) return;
    identities.add(`${realDetails.dev}:${realDetails.ino}`);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
  }
}

function deniedDirectoryIdentities(prefixes: readonly string[]): Set<string> {
  const identities = new Set<string>();
  for (const prefix of prefixes) pinPathIdentity(prefix, identities, true);
  return identities;
}

function ancestorDirectoryIdentities(
  resolvedPath: string,
  fd?: number,
  resolveOpenedFd?: (fd: number) => string,
): Set<string> {
  const identities = new Set<string>();
  const start =
    fd === undefined ? resolvedPath : (resolveOpenedFdPath(fd, resolveOpenedFd) ?? resolvedPath);
  let cursor = dirname(resolve(start));
  const seen = new Set<string>();
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  while (seen.has(cursor) === false) {
    seen.add(cursor);
    try {
      const dirFd = openNoFollow(cursor, fsConstants.O_RDONLY | directoryFlag);
      try {
        const details = fstatSync(dirFd);
        identities.add(`${details.dev}:${details.ino}`);
      } finally {
        closeSync(dirFd);
      }
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
      pinPathIdentity(cursor, identities, true);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return identities;
}

export function assertNotSensitiveAttachmentSource(
  resolvedPath: string,
  stats: Stats,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  guard?: AttachmentPathGuard,
  opened?: { fd: number; resolveOpenedFd?: (fd: number) => string },
): void {
  const { prefixes, files, lexicalOnly } = deniedAttachmentLocations(environment, home, guard);
  const resolved = resolve(resolvedPath);
  for (const prefix of prefixes) {
    if (pathIsUnder(resolved, prefix)) fail("ATTACHMENT_REJECTED");
  }
  const identities = new Set<string>();
  for (const file of files) {
    if (pathsEqual(resolved, file)) fail("ATTACHMENT_REJECTED");
    if (lexicalOnly.has(file) === false) pinPathIdentity(file, identities);
  }
  if (identities.has(`${stats.dev}:${stats.ino}`)) fail("ATTACHMENT_REJECTED");
  const deniedDirs = deniedDirectoryIdentities(prefixes.filter((prefix) => lexicalOnly.has(prefix) === false));
  if (deniedDirs.size === 0) return;
  const ancestors = ancestorDirectoryIdentities(resolved, opened?.fd, opened?.resolveOpenedFd);
  for (const identity of ancestors) {
    if (deniedDirs.has(identity)) fail("ATTACHMENT_REJECTED");
  }
}

export function validateLocalAttachmentFile(
  path: string,
  displayName?: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  guard?: AttachmentPathGuard,
): LocalAttachmentDecision {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path) === false) {
    fail("ATTACHMENT_REJECTED");
  }
  const name = sanitizeAttachmentName(displayName ?? path);
  const extension = attachmentExtension(name);
  const initial = assertRegularFile(path);
  if (initial.nlink !== 1) fail("ATTACHMENT_REJECTED");
  if (initial.size === 0) fail("ATTACHMENT_REJECTED");
  if (initial.size > ATTACHMENT_MAX_BYTES) fail("ATTACHMENT_TOO_LARGE");
  const fd = openNoFollow(path, fsConstants.O_RDONLY);
  try {
    const next = fstatSync(fd);
    if (
      next.dev !== initial.dev ||
      next.ino !== initial.ino ||
      next.isFile() === false ||
      next.nlink !== 1
    ) {
      fail("ATTACHMENT_REJECTED");
    }
    if (next.size !== initial.size) fail("ATTACHMENT_REJECTED");
    const resolvedPath = outboundResolvedFdPath(fd, path, next, guard?.resolveOpenedFd);
    const opened =
      guard?.resolveOpenedFd === undefined ? { fd } : { fd, resolveOpenedFd: guard.resolveOpenedFd };
    assertNotSensitiveAttachmentSource(resolvedPath, next, environment, home, guard, opened);
    const bytes = Buffer.alloc(next.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail("ATTACHMENT_REJECTED");
      offset += read;
    }
    const mime = sniffMime(bytes, extension);
    return {
      bytes,
      mime,
      extension,
      sha256: sha256Buffer(bytes),
      size: bytes.length,
      name,
      path_identity: sha256Buffer(Buffer.from(`${next.dev}:${next.ino}:${resolvedPath}`, "utf8")),
      resolved_path: resolvedPath,
    };
  } catch (caught) {
    if (
      caught instanceof TestRealDataRootError ||
      caught instanceof AttachmentError ||
      caught instanceof TypeError
    ) {
      throw caught;
    }
    throw new AttachmentError("ATTACHMENT_REJECTED");
  } finally {
    closeSync(fd);
  }
}

export function expectedCommittedPath(
  sandRoot: string,
  botId: string,
  sha256: string,
  extension: string,
): string {
  return join(sandRoot, "agents", botId, "attachments", `${sha256}${extension}`);
}

function botAttachmentRoots(botId: string, sandRoot: string): string[] {
  const lexical = [
    resolve(sandRoot, "agents", botId, "attachments"),
    resolve(sandRoot, "agents", botId, "assets"),
  ];
  let canonicalRoot: string | undefined;
  try {
    canonicalRoot = realpathSync(sandRoot);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    canonicalRoot = undefined;
  }
  if (canonicalRoot === undefined || canonicalRoot === resolve(sandRoot)) return lexical;
  return [
    ...lexical,
    join(canonicalRoot, "agents", botId, "attachments"),
    join(canonicalRoot, "agents", botId, "assets"),
  ];
}

export function isUnderBotAttachmentRoots(
  path: string,
  botId: string,
  sandRoot: string,
): boolean {
  if (ATTACHMENT_BOT_ID_PATTERN.test(botId) === false) return false;
  if (isAbsolute(path) === false || path.includes("\0") || hasDotDotSegment(path) || looksLikeUrl(path)) {
    return false;
  }
  const lexical = resolve(path);
  return botAttachmentRoots(botId, sandRoot).some((root) => pathIsUnder(lexical, root));
}

export function assertSafeBotAttachmentPath(path: string, botId: string, sandRoot: string): string {
  assertAttachmentBotId(botId);
  if (isUnderBotAttachmentRoots(path, botId, sandRoot) === false) fail("ATTACHMENT_REJECTED");
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    if (isNodeError(caught) && caught.code === "ENOENT") fail("ATTACHMENT_STALE");
    fail("ATTACHMENT_REJECTED");
  }
  if (isUnderBotAttachmentRoots(resolved, botId, sandRoot) === false) fail("ATTACHMENT_REJECTED");
  return resolved;
}

export function openConfinedBotAttachment(
  path: string,
  botId: string,
  sandRoot: string,
  cap: number,
  displayName?: string,
  resolveOpenedFd?: (fd: number) => string,
): ConfinedAttachmentBytes {
  assertAttachmentBotId(botId);
  if (isUnderBotAttachmentRoots(path, botId, sandRoot) === false) fail("ATTACHMENT_REJECTED");
  let initial: Stats;
  try {
    initial = lstatSync(path);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    if (isNodeError(caught) && caught.code === "ENOENT") fail("ATTACHMENT_STALE");
    fail("ATTACHMENT_REJECTED");
  }
  if (initial.isSymbolicLink() || initial.isFile() === false || initial.nlink !== 1) {
    fail("ATTACHMENT_REJECTED");
  }
  if (initial.size > cap) fail("ATTACHMENT_TOO_LARGE");
  let fd: number;
  try {
    fd = openNoFollow(path, fsConstants.O_RDONLY);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    if (isNodeError(caught) && caught.code === "ENOENT") fail("ATTACHMENT_STALE");
    fail("ATTACHMENT_REJECTED");
  }
  try {
    const next = fstatSync(fd);
    if (
      next.dev !== initial.dev ||
      next.ino !== initial.ino ||
      next.isFile() === false ||
      next.nlink !== 1
    ) {
      fail("ATTACHMENT_REJECTED");
    }
    if (next.size > cap) fail("ATTACHMENT_TOO_LARGE");
    const resolved = inboundResolvedFdPath(fd, next, resolveOpenedFd);
    if (isUnderBotAttachmentRoots(resolved, botId, sandRoot) === false) fail("ATTACHMENT_REJECTED");
    const bytes = Buffer.alloc(next.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail("ATTACHMENT_STALE");
      offset += read;
    }
    const mime = sniffMime(bytes, attachmentExtension(displayName ?? basename(resolved)));
    return { bytes, sha256: sha256Buffer(bytes), resolved_path: resolved, mime };
  } catch (caught) {
    if (caught instanceof TestRealDataRootError || caught instanceof AttachmentError) throw caught;
    throw new AttachmentError("ATTACHMENT_REJECTED");
  } finally {
    closeSync(fd);
  }
}

export function committedHostPathIsValid(
  returnedPath: string,
  botId: string,
  sha256: string,
  extension: string,
  sandRoot: string,
): boolean {
  if (typeof returnedPath !== "string" || returnedPath.includes("\0") || hasDotDotSegment(returnedPath)) {
    return false;
  }
  if (basename(returnedPath) !== `${sha256}${extension}`) return false;
  const expected = expectedCommittedPath(sandRoot, botId, sha256, extension);
  return resolve(returnedPath) === resolve(expected);
}

function pathFromTranscriptValue(value: unknown): { path?: string; external: boolean } {
  if (typeof value !== "string" || value.trim() === "") return { external: false };
  if (/^https?:\/\//i.test(value)) return { external: true };
  if (value.startsWith("file://")) {
    try {
      return { path: fileURLToPath(value), external: false };
    } catch {
      return { external: false };
    }
  }
  return { path: value, external: false };
}

export type LocatedAttachment = AttachmentMeta & {
  path?: string;
  fetchable: boolean;
};

export function extractTranscriptAttachments(entries: unknown[], botId: string): LocatedAttachment[] {
  const found: LocatedAttachment[] = [];
  for (const value of entries) {
    const outer = record(value);
    if (outer === undefined) continue;
    const nested = record(outer.entry);
    const entry = nested ?? outer;
    const id =
      (typeof entry.id === "string" && entry.id.length > 0 && entry.id) ||
      (typeof outer.id === "string" && outer.id.length > 0 && outer.id) ||
      undefined;
    if (id === undefined) continue;
    const seq = nonnegativeInteger(outer.seq) ?? nonnegativeInteger(entry.seq);
    const timestamp_ms =
      nonnegativeInteger(entry.timestampMs) ?? nonnegativeInteger(outer.timestampMs);
    const kind = typeof entry.kind === "string" ? entry.kind : undefined;
    if (kind === "user-attachment") {
      const filePath = typeof entry.file_path === "string" ? entry.file_path : undefined;
      const nameSource = typeof entry.file_name === "string" ? entry.file_name : filePath;
      let name = "attachment";
      try {
        if (nameSource !== undefined) name = sanitizeAttachmentName(nameSource);
      } catch (caught) {
        if (caught instanceof TestRealDataRootError) throw caught;
      }
      const extension = attachmentExtension(name);
      found.push({
        entry_id: id,
        seq,
        speaker: "user",
        name,
        kind: kindForExtension(extension),
        timestamp_ms,
        ...(filePath === undefined ? {} : { path: filePath }),
        fetchable: filePath !== undefined,
      });
      continue;
    }
    if (kind === "send-message") {
      const message = record(entry.message);
      if (message?.type !== "attachment") continue;
      const located = pathFromTranscriptValue(message.url);
      const nameSource = typeof message.file_name === "string" ? message.file_name : located.path;
      let name = "attachment";
      try {
        if (nameSource !== undefined) name = sanitizeAttachmentName(nameSource);
      } catch (caught) {
        if (caught instanceof TestRealDataRootError) throw caught;
      }
      found.push({
        entry_id: id,
        seq,
        speaker: "bot",
        name,
        kind: located.external ? "external" : kindForExtension(attachmentExtension(name)),
        timestamp_ms,
        ...(located.path === undefined ? {} : { path: located.path }),
        fetchable: located.external === false && located.path !== undefined,
      });
    }
  }
  void botId;
  return found;
}

export function toPublicAttachmentMeta(entry: LocatedAttachment): AttachmentMeta {
  return {
    entry_id: entry.entry_id,
    seq: entry.seq,
    speaker: entry.speaker,
    name: entry.name,
    kind: entry.kind,
    timestamp_ms: entry.timestamp_ms,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const details = lstatSync(path);
  if (details.isSymbolicLink() || details.isDirectory() === false || (details.mode & 0o777) !== 0o700) {
    fail("ATTACHMENT_REJECTED");
  }
}

export class AttachmentSessionStore {
  readonly #root: string;
  readonly #uploads = new Map<string, UploadRecord>();
  readonly #committed = new Map<string, CommittedAttachment>();
  readonly #fetches = new Map<string, FetchCacheRecord>();
  now: () => number;

  constructor(root: string, now: () => number = Date.now) {
    if (isAbsolute(root) === false) fail("ATTACHMENT_REJECTED");
    this.#root = root;
    this.now = now;
    this.sweep();
  }

  get root(): string {
    return this.#root;
  }

  sweep(now = this.now()): void {
    for (const [uploadId, record] of this.#uploads) {
      if (now - record.createdAt > ATTACHMENT_TTL_MS) this.#forgetUpload(uploadId);
    }
    for (const [ref, record] of this.#committed) {
      if (now - record.createdAt > ATTACHMENT_TTL_MS) this.#committed.delete(ref);
    }
    for (const [key, record] of this.#fetches) {
      if (now - record.createdAt > ATTACHMENT_TTL_MS) this.#fetches.delete(key);
    }
    this.#sweepDisk(now);
  }

  rememberFetch(record: FetchCacheRecord): void {
    this.sweep();
    const key = `${record.botId}:${record.entryId}`;
    this.#fetches.delete(key);
    this.#fetches.set(key, record);
    this.#evictFetches();
  }

  lookupFetch(botId: string, entryId: string): FetchCacheRecord | undefined {
    this.sweep();
    const key = `${botId}:${entryId}`;
    const record = this.#fetches.get(key);
    if (record === undefined) return undefined;
    this.#fetches.delete(key);
    this.#fetches.set(key, record);
    return record;
  }

  #fetchCacheBytes(): number {
    let total = 0;
    for (const record of this.#fetches.values()) total += record.bytes.length;
    return total;
  }

  #evictFetches(): void {
    while (
      this.#fetches.size > ATTACHMENT_MAX_FETCH_CACHED ||
      this.#fetchCacheBytes() > ATTACHMENT_MAX_FETCH_CACHE_BYTES
    ) {
      const oldest = this.#fetches.keys().next().value;
      if (oldest === undefined) break;
      this.#fetches.delete(oldest);
    }
  }

  stage(input: {
    uploadId: string;
    botId: string;
    name: string;
    mime: string;
    totalSize: number;
    sha256: string;
    seq: number;
    offset: number;
    bytes: Buffer;
  }): { received: number; totalSize: number; complete: boolean } {
    this.sweep();
    const name = sanitizeAttachmentName(input.name);
    const extension = attachmentExtension(name);
    if (input.totalSize <= 0) fail("ATTACHMENT_REJECTED");
    if (input.totalSize > ATTACHMENT_MAX_BYTES) fail("ATTACHMENT_TOO_LARGE");
    if (input.bytes.length === 0 || input.bytes.length > ATTACHMENT_CHUNK_BYTES) {
      fail("ATTACHMENT_REJECTED");
    }
    if (input.offset < 0 || input.seq < 0) fail("ATTACHMENT_REJECTED");
    if (input.offset + input.bytes.length > input.totalSize) fail("ATTACHMENT_TOO_LARGE");
    if (mimeForExtension(extension) !== input.mime) fail("ATTACHMENT_REJECTED");
    if (input.seq === 0) sniffMime(input.bytes, extension);

    ensurePrivateDirectory(this.#root);
    const directory = this.#uploadDir(input.uploadId);
    let record = this.#uploads.get(input.uploadId);
    if (record !== undefined && this.now() - record.createdAt > ATTACHMENT_TTL_MS) {
      this.#forgetUpload(input.uploadId);
      record = undefined;
    }
    if (record === undefined) {
      if (input.seq !== 0 || input.offset !== 0) fail("ATTACHMENT_STALE");
      if (this.#uploads.size >= ATTACHMENT_MAX_STAGED_UPLOADS) fail("ATTACHMENT_REJECTED");
      let stagedBytes = 0;
      for (const existing of this.#uploads.values()) stagedBytes += existing.totalSize;
      if (stagedBytes + input.totalSize > ATTACHMENT_MAX_STAGED_BYTES) fail("ATTACHMENT_TOO_LARGE");
      ensurePrivateDirectory(directory);
      let handle: number;
      try {
        handle = openNoFollow(
          this.#dataPath(input.uploadId),
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
      } catch (caught) {
        if (caught instanceof TestRealDataRootError || caught instanceof AttachmentError) throw caught;
        if (isNodeError(caught) && caught.code === "EEXIST") {
          fail("ATTACHMENT_STALE", "upload_id already exists on disk");
        }
        fail("ATTACHMENT_REJECTED");
      }
      try {
        writeSync(handle, input.bytes, 0, input.bytes.length, 0);
      } finally {
        closeSync(handle);
      }
      record = {
        uploadId: input.uploadId,
        botId: input.botId,
        name,
        mime: input.mime,
        totalSize: input.totalSize,
        sha256: input.sha256.toLowerCase(),
        received: input.bytes.length,
        nextSeq: 1,
        seqHashes: new Map([[0, sha256Buffer(input.bytes)]]),
        createdAt: this.now(),
        complete: input.bytes.length === input.totalSize,
      };
      this.#uploads.set(input.uploadId, record);
      if (record.complete) this.#verifyComplete(record);
      return { received: record.received, totalSize: record.totalSize, complete: record.complete };
    }

    if (
      record.botId !== input.botId ||
      record.name !== name ||
      record.mime !== input.mime ||
      record.totalSize !== input.totalSize ||
      record.sha256 !== input.sha256.toLowerCase()
    ) {
      fail("ATTACHMENT_REJECTED");
    }
    const replayHash = record.seqHashes.get(input.seq);
    if (replayHash !== undefined) {
      if (replayHash !== sha256Buffer(input.bytes)) fail("ATTACHMENT_INTEGRITY");
      return { received: record.received, totalSize: record.totalSize, complete: record.complete };
    }
    if (input.seq !== record.nextSeq) fail("ATTACHMENT_REJECTED");
    if (input.offset !== record.received) fail("ATTACHMENT_REJECTED");
    this.#assertStagingFile(input.uploadId);
    const handle = openNoFollow(this.#dataPath(input.uploadId), fsConstants.O_RDWR);
    try {
      writeSync(handle, input.bytes, 0, input.bytes.length, input.offset);
    } finally {
      closeSync(handle);
    }
    record.received += input.bytes.length;
    record.nextSeq += 1;
    record.seqHashes.set(input.seq, sha256Buffer(input.bytes));
    record.complete = record.received === record.totalSize;
    if (record.complete) this.#verifyComplete(record);
    return { received: record.received, totalSize: record.totalSize, complete: record.complete };
  }

  takeComplete(uploadId: string, botId: string): { bytes: Buffer; record: UploadRecord } {
    this.sweep();
    const record = this.#uploads.get(uploadId);
    if (record === undefined) fail("ATTACHMENT_STALE");
    if (record.botId !== botId) fail("ATTACHMENT_REJECTED");
    if (record.complete === false) fail("ATTACHMENT_REJECTED");
    this.#assertStagingFile(uploadId);
    const bytes = this.#readData(uploadId, record.totalSize);
    if (sha256Buffer(bytes) !== record.sha256) fail("ATTACHMENT_INTEGRITY");
    return { bytes, record };
  }

  rememberCommit(record: UploadRecord, path: string): string {
    const ref = randomUUID();
    this.#committed.set(ref, {
      ref,
      botId: record.botId,
      path,
      name: record.name,
      sha256: record.sha256,
      createdAt: this.now(),
    });
    this.#forgetUpload(record.uploadId);
    return ref;
  }

  lookup(ref: string, botId: string): CommittedAttachment {
    this.sweep();
    const record = this.#committed.get(ref);
    if (record === undefined) fail("ATTACHMENT_STALE");
    if (record.botId !== botId) fail("ATTACHMENT_REJECTED");
    return record;
  }

  #verifyComplete(record: UploadRecord): void {
    const bytes = this.#readData(record.uploadId, record.totalSize);
    if (bytes.length !== record.totalSize || sha256Buffer(bytes) !== record.sha256) {
      fail("ATTACHMENT_INTEGRITY");
    }
    sniffMime(bytes, attachmentExtension(record.name));
  }

  #readData(uploadId: string, size: number): Buffer {
    this.#assertStagingFile(uploadId);
    const handle = openNoFollow(this.#dataPath(uploadId), fsConstants.O_RDONLY);
    try {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = readSync(handle, bytes, offset, size - offset, offset);
        if (read === 0) fail("ATTACHMENT_INTEGRITY");
        offset += read;
      }
      return bytes;
    } finally {
      closeSync(handle);
    }
  }

  #assertStagingFile(uploadId: string): void {
    const directory = this.#uploadDir(uploadId);
    const file = this.#dataPath(uploadId);
    const dirDetails = lstatSync(directory);
    if (dirDetails.isSymbolicLink() || dirDetails.isDirectory() === false) fail("ATTACHMENT_REJECTED");
    assertRegularFile(file);
  }

  #uploadDir(uploadId: string): string {
    return join(this.#root, uploadId);
  }

  #dataPath(uploadId: string): string {
    return join(this.#uploadDir(uploadId), "data");
  }

  #forgetUpload(uploadId: string): void {
    this.#uploads.delete(uploadId);
    try {
      rmSync(this.#uploadDir(uploadId), { recursive: true, force: true });
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
    }
  }

  #sweepDisk(now: number): void {
    let names: string[];
    try {
      names = readdirSync(this.#root);
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
      if (isNodeError(caught) && caught.code === "ENOENT") return;
      return;
    }
    for (const name of names) {
      if (this.#uploads.has(name)) continue;
      const directory = join(this.#root, name);
      try {
        const details = lstatSync(directory);
        if (details.isSymbolicLink()) {
          rmSync(directory, { force: true });
          continue;
        }
        if (details.isDirectory() === false) {
          rmSync(directory, { force: true });
          continue;
        }
        if (now - details.mtimeMs > ATTACHMENT_TTL_MS) {
          rmSync(directory, { recursive: true, force: true });
        }
      } catch (caught) {
        if (caught instanceof TestRealDataRootError) throw caught;
      }
    }
  }
}

const stores = new Map<string, AttachmentSessionStore>();

export function attachmentSessionStore(
  root: string,
  now?: () => number,
  options?: { reset?: boolean },
): AttachmentSessionStore {
  if (options?.reset === true) stores.delete(root);
  const existing = stores.get(root);
  if (existing !== undefined) {
    if (now !== undefined) existing.now = now;
    return existing;
  }
  const created = new AttachmentSessionStore(root, now ?? Date.now);
  stores.set(root, created);
  return created;
}

export function sandRootForAttachments(env: NodeJS.ProcessEnv = process.env): string {
  return grokBotDataRoot(env);
}

export function decodeChunkBytes(bytesB64: string): Buffer {
  if (typeof bytesB64 !== "string" || bytesB64.length === 0 || bytesB64.length > ATTACHMENT_CHUNK_B64_MAX) {
    fail("ATTACHMENT_REJECTED");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(bytesB64, "base64");
  } catch {
    fail("ATTACHMENT_REJECTED");
  }
  if (bytes.length === 0 || bytes.toString("base64") !== bytesB64) fail("ATTACHMENT_REJECTED");
  return bytes;
}

export function fetchSizeCap(kind: AttachmentKind): number {
  return kind === "image" ? ATTACHMENT_IMAGE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
}
