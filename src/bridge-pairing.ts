import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const PAIR_CODE_PREFIX = "CGM2_";
const PAIR_CODE_VERSION = 2;
const FRAME_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_CONFIG_BYTES = 8 * 1024;

export const MAX_PLAINTEXT_BYTES = 96 * 1024;
export const MAX_FRAME_BYTES = 128 * 1024;

export type BridgeRole = "codex" | "bridge";

export type PairingConfig = {
  version: 2;
  relayUrl: string;
  relayToken: string;
  channel: string;
  key: string;
};

type PairCodePayload = {
  v: 2;
  relay: string;
  token: string;
  channel: string;
  key: string;
};

type SaveOptions = {
  overwrite?: boolean;
};

export class BridgePairingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BridgePairingError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new BridgePairingError(code);
}

function hasUnsafeControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

export function validateRelayUrl(value: string): string {
  if (value.length === 0 || hasUnsafeControlCharacters(value)) fail("invalid_relay_url");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_relay_url");
  }

  if (
    (url.protocol !== "wss:" && url.protocol !== "ws:") ||
    (url.protocol === "ws:" && !isLoopback(url.hostname)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    fail("invalid_relay_url");
  }

  return url.toString();
}

function decodeBase64UrlExact(value: string, bytes: number, errorCode: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(errorCode);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(errorCode);
  }
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) fail(errorCode);
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeConfig(value: unknown, errorCode = "invalid_pairing_config"): PairingConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "relayUrl", "relayToken", "channel", "key"])
  ) {
    fail(errorCode);
  }
  if (
    value.version !== PAIR_CODE_VERSION ||
    typeof value.relayUrl !== "string" ||
    typeof value.relayToken !== "string" ||
    typeof value.channel !== "string" ||
    typeof value.key !== "string"
  ) {
    fail(errorCode);
  }

  let relayUrl: string;
  try {
    relayUrl = validateRelayUrl(value.relayUrl);
    decodeBase64UrlExact(value.relayToken, 32, errorCode);
    decodeBase64UrlExact(value.channel, 16, errorCode);
    decodeBase64UrlExact(value.key, 32, errorCode);
  } catch {
    fail(errorCode);
  }

  return {
    version: PAIR_CODE_VERSION,
    relayUrl,
    relayToken: value.relayToken,
    channel: value.channel,
    key: value.key,
  };
}

export function generateRelayAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveRelayChannelToken(masterToken: string, channel: string): string {
  const master = decodeBase64UrlExact(masterToken, 32, "invalid_relay_token");
  decodeBase64UrlExact(channel, 16, "invalid_pairing_config");
  return createHmac("sha256", master)
    .update(`codex-grok-mcp-relay:v1\0${channel}`, "utf8")
    .digest("base64url");
}

export function generatePairCode(
  relayUrl: string,
  relayMasterToken = generateRelayAccessToken(),
): string {
  const channel = randomBytes(16).toString("base64url");
  const payload: PairCodePayload = {
    v: PAIR_CODE_VERSION,
    relay: validateRelayUrl(relayUrl),
    token: deriveRelayChannelToken(relayMasterToken, channel),
    channel,
    key: randomBytes(32).toString("base64url"),
  };
  return `${PAIR_CODE_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function parsePairCode(pairCode: string): PairingConfig {
  try {
    if (
      pairCode.length <= PAIR_CODE_PREFIX.length ||
      pairCode.length > 4_096 ||
      hasUnsafeControlCharacters(pairCode) ||
      !pairCode.startsWith(PAIR_CODE_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(pairCode)
    ) {
      fail("invalid_pair_code");
    }

    const encoded = pairCode.slice(PAIR_CODE_PREFIX.length);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) fail("invalid_pair_code");
    const payload: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      !isRecord(payload) ||
      !hasExactKeys(payload, ["v", "relay", "token", "channel", "key"])
    ) {
      fail("invalid_pair_code");
    }
    if (
      payload.v !== PAIR_CODE_VERSION ||
      typeof payload.relay !== "string" ||
      typeof payload.token !== "string" ||
      typeof payload.channel !== "string" ||
      typeof payload.key !== "string"
    ) {
      fail("invalid_pair_code");
    }

    return normalizeConfig(
      {
        version: payload.v,
        relayUrl: payload.relay,
        relayToken: payload.token,
        channel: payload.channel,
        key: payload.key,
      },
      "invalid_pair_code",
    );
  } catch {
    fail("invalid_pair_code");
  }
}

function validateRole(role: string): asserts role is BridgeRole {
  if (role !== "codex" && role !== "bridge") fail("invalid_bridge_role");
}

function aad(channel: string, role: BridgeRole): Buffer {
  return Buffer.from(`codex-grok-mcp:v2\0${channel}\0${role}`, "utf8");
}

export function encryptFrame(
  configValue: PairingConfig,
  senderRole: BridgeRole,
  plaintextValue: string | Uint8Array,
): string {
  const config = normalizeConfig(configValue);
  validateRole(senderRole);
  const plaintext =
    typeof plaintextValue === "string"
      ? Buffer.from(plaintextValue, "utf8")
      : Buffer.from(plaintextValue);
  if (plaintext.length > MAX_PLAINTEXT_BYTES) fail("plaintext_too_large");

  const nonce = randomBytes(NONCE_BYTES);
  const key = decodeBase64UrlExact(config.key, 32, "invalid_pairing_config");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(config.channel, senderRole));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const frame = Buffer.concat([
    Buffer.from([FRAME_VERSION]),
    nonce,
    encrypted,
    cipher.getAuthTag(),
  ]).toString("base64url");
  if (frame.length > MAX_FRAME_BYTES) fail("frame_too_large");
  return frame;
}

export function decryptFrame(
  configValue: PairingConfig,
  senderRole: BridgeRole,
  frameValue: string,
): Buffer {
  const config = normalizeConfig(configValue);
  validateRole(senderRole);
  if (
    frameValue.length === 0 ||
    frameValue.length > MAX_FRAME_BYTES ||
    hasUnsafeControlCharacters(frameValue) ||
    !/^[A-Za-z0-9_-]+$/.test(frameValue)
  ) {
    fail("invalid_frame");
  }

  let frame: Buffer;
  try {
    frame = Buffer.from(frameValue, "base64url");
  } catch {
    fail("invalid_frame");
  }
  if (
    frame.toString("base64url") !== frameValue ||
    frame.length < 1 + NONCE_BYTES + AUTH_TAG_BYTES ||
    frame[0] !== FRAME_VERSION
  ) {
    fail("invalid_frame");
  }

  const nonceStart = 1;
  const ciphertextStart = nonceStart + NONCE_BYTES;
  const tagStart = frame.length - AUTH_TAG_BYTES;
  const nonce = frame.subarray(nonceStart, ciphertextStart);
  const ciphertext = frame.subarray(ciphertextStart, tagStart);
  if (ciphertext.length > MAX_PLAINTEXT_BYTES) fail("invalid_frame");

  try {
    const key = decodeBase64UrlExact(config.key, 32, "invalid_pairing_config");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(config.channel, senderRole));
    decipher.setAuthTag(frame.subarray(tagStart));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof BridgePairingError) throw error;
    fail("frame_auth_failed");
  }
}

export function defaultBridgeConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configuredRoot = environment.XDG_CONFIG_HOME;
  const root =
    configuredRoot !== undefined && configuredRoot !== "" && isAbsolute(configuredRoot)
      ? configuredRoot
      : join(homeDirectory, ".config");
  return join(root, "codex-grok-mcp", "bridge.json");
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const details = await lstat(parent);
    if (details.isSymbolicLink() || !details.isDirectory() || (details.mode & 0o777) !== 0o700) {
      fail("insecure_config_directory");
    }
  } catch (error) {
    if (error instanceof BridgePairingError) throw error;
    fail("config_save_failed");
  }
}

function encodeConfig(config: PairingConfig): string {
  return `${JSON.stringify(config)}\n`;
}

export async function savePairingConfig(
  configValue: PairingConfig,
  path = defaultBridgeConfigPath(),
  options: SaveOptions = {},
): Promise<void> {
  const config = normalizeConfig(configValue);
  await ensurePrivateParent(path);
  const temporaryPath = join(
    dirname(path),
    `.bridge-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(encodeConfig(config), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);

    if (options.overwrite === true) {
      await rename(temporaryPath, path);
    } else {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") fail("config_exists");
        throw error;
      }
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof BridgePairingError) throw error;
    fail("config_save_failed");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadPairingConfig(path = defaultBridgeConfigPath()): Promise<PairingConfig> {
  try {
    const pathDetails = await lstat(path);
    if (pathDetails.isSymbolicLink()) fail("invalid_config_file");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    let contents: string;
    try {
      const details = await handle.stat();
      if (!details.isFile() || (details.mode & 0o777) !== 0o600 || details.size > MAX_CONFIG_BYTES) {
        fail("invalid_config_file");
      }
      contents = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    if (Buffer.byteLength(contents, "utf8") > MAX_CONFIG_BYTES || hasUnsafeControlCharacters(contents.trimEnd())) {
      fail("invalid_config_file");
    }
    return normalizeConfig(JSON.parse(contents), "invalid_config_file");
  } catch (error) {
    if (error instanceof BridgePairingError) throw error;
    fail("config_load_failed");
  }
}

export async function loadOptionalPairingConfig(
  path = defaultBridgeConfigPath(),
): Promise<PairingConfig | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    fail("config_load_failed");
  }
  return loadPairingConfig(path);
}

export async function removePairingConfig(path = defaultBridgeConfigPath()): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (!details.isFile() && !details.isSymbolicLink()) fail("invalid_config_file");
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    if (error instanceof BridgePairingError) throw error;
    fail("config_remove_failed");
  }
}
