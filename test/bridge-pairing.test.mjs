import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decryptFrame,
  deriveRelayChannelToken,
  encryptFrame,
  generatePairCode,
  generateRelayAccessToken,
  loadPairingConfig,
  loadPairingConfigSnapshot,
  parsePairCode,
  removePairingConfig,
  savePairingConfig,
  validateRelayUrl,
} from "../dist/bridge-pairing.js";

test("pair code and authenticated frames round-trip without shell-sensitive characters", () => {
  const masterToken = generateRelayAccessToken();
  const pairCode = generatePairCode("wss://relay.example.test/socket", masterToken);
  assert.match(pairCode, /^[A-Za-z0-9_-]+$/);

  const config = parsePairCode(pairCode);
  assert.notEqual(config.relayToken, masterToken);
  assert.equal(config.relayToken, deriveRelayChannelToken(masterToken, config.channel));
  assert.equal(Buffer.from(config.relayToken, "base64url").length, 32);
  assert.equal(Buffer.from(config.channel, "base64url").length, 16);
  assert.equal(Buffer.from(config.key, "base64url").length, 32);

  const plaintext = Buffer.from('{"type":"ping"}', "utf8");
  const frame = encryptFrame(config, "codex", plaintext);
  assert.match(frame, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decryptFrame(config, "codex", frame), plaintext);
});

test("pair codes reject malformed secret lengths and control characters", () => {
  const valid = parsePairCode(generatePairCode("wss://relay.example.test/socket"));
  const encode = (payload) =>
    `CGM2_${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;

  for (const pairCode of [
    encode({ v: 2, relay: valid.relayUrl, token: "AA", channel: valid.channel, key: valid.key }),
    encode({ v: 2, relay: valid.relayUrl, token: valid.relayToken, channel: "AA", key: valid.key }),
    encode({ v: 2, relay: valid.relayUrl, token: valid.relayToken, channel: valid.channel, key: "AA" }),
    `${generatePairCode("wss://relay.example.test/socket")}\n`,
    `CGM2_${"A".repeat(4_097)}`,
  ]) {
    assert.throws(() => parsePairCode(pairCode), { message: "invalid_pair_code" });
  }
});

test("frames reject tampering, the wrong sender role, and the wrong key without leaking details", () => {
  const config = parsePairCode(generatePairCode("wss://relay.example.test/socket"));
  const frame = encryptFrame(config, "bridge", "private message");
  const tamperIndex = Math.floor(frame.length / 2);
  const replacement = frame[tamperIndex] === "A" ? "B" : "A";
  const tampered = `${frame.slice(0, tamperIndex)}${replacement}${frame.slice(tamperIndex + 1)}`;
  const wrongKey = parsePairCode(generatePairCode("wss://relay.example.test/socket"));

  for (const operation of [
    () => decryptFrame(config, "bridge", tampered),
    () => decryptFrame(config, "codex", frame),
    () => decryptFrame({ ...config, key: wrongKey.key }, "bridge", frame),
  ]) {
    assert.throws(operation, (error) => {
      assert.equal(error.message, "frame_auth_failed");
      assert(!error.message.includes(config.key));
      assert(!error.message.includes("private message"));
      return true;
    });
  }

  assert.throws(() => encryptFrame(config, "codex", Buffer.alloc(96 * 1024 + 1)), {
    message: "plaintext_too_large",
  });
  assert.throws(() => decryptFrame(config, "codex", "A".repeat(128 * 1024 + 1)), {
    message: "invalid_frame",
  });
});

test("relay URLs require secure remote WebSockets and contain no ambient data", () => {
  assert.equal(validateRelayUrl("wss://relay.example.test/socket"), "wss://relay.example.test/socket");
  assert.equal(validateRelayUrl("ws://127.0.0.1:8787/socket"), "ws://127.0.0.1:8787/socket");
  assert.equal(validateRelayUrl("ws://[::1]:8787/socket"), "ws://[::1]:8787/socket");

  for (const url of [
    "ws://relay.example.test/socket",
    "wss://user:password@relay.example.test/socket",
    "wss://relay.example.test/socket?token=secret",
    "wss://relay.example.test/socket#fragment",
    "https://relay.example.test/socket",
    "wss://relay.example.test/socket\n",
    "wss://relay.example.test/\0socket",
  ]) {
    assert.throws(() => validateRelayUrl(url), { message: "invalid_relay_url" });
  }
});

test("config persistence is private, atomic, and refuses accidental overwrite", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-pairing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "bridge.json");
  const first = parsePairCode(generatePairCode("wss://relay.example.test/socket"));
  const second = parsePairCode(generatePairCode("wss://relay.example.test/socket"));

  await savePairingConfig(first, path);
  const firstSnapshot = await loadPairingConfigSnapshot(path);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await loadPairingConfig(path), first);

  await assert.rejects(savePairingConfig(second, path), { message: "config_exists" });
  assert.deepEqual(await loadPairingConfig(path), first);
  await savePairingConfig(second, path, { overwrite: true });
  assert.deepEqual(await loadPairingConfig(path), second);
  const secondSnapshot = await loadPairingConfigSnapshot(path);
  assert.deepEqual(firstSnapshot.config, first);
  assert.deepEqual(secondSnapshot.config, second);
  assert.notDeepEqual(firstSnapshot.identity, secondSnapshot.identity);

  await chmod(path, 0o644);
  await assert.rejects(loadPairingConfig(path), { message: "invalid_config_file" });
  assert.equal(await removePairingConfig(path), true);
  assert.equal(await removePairingConfig(path), false);
});

test("config loading rejects unsafe file identities and oversized files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-pairing-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = parsePairCode(generatePairCode("wss://relay.example.test/socket"));
  const path = join(root, "bridge.json");

  await savePairingConfig(config, path);
  const details = await stat(path);
  assert.equal(details.uid, process.getuid());
  assert.deepEqual(await loadPairingConfig(path), config);

  const hardLinkPath = join(root, "bridge-hard-link.json");
  await link(path, hardLinkPath);
  await assert.rejects(loadPairingConfig(path), { message: "invalid_config_file" });
  await assert.rejects(loadPairingConfig(hardLinkPath), { message: "invalid_config_file" });

  const symbolicLinkPath = join(root, "bridge-symbolic-link.json");
  await symlink(path, symbolicLinkPath);
  await assert.rejects(loadPairingConfig(symbolicLinkPath), { message: "invalid_config_file" });

  const oversizedPath = join(root, "bridge-oversized.json");
  await writeFile(oversizedPath, Buffer.alloc(8 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(loadPairingConfig(oversizedPath), { message: "invalid_config_file" });
});
