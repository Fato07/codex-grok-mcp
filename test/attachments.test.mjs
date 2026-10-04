import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { hermetic } from "./hermetic-setup.mjs";
import {
  ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV,
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TTL_MS,
  AttachmentError,
  expectedCommittedPath,
  resetAttachmentSessionStore,
  validateLocalAttachmentFile,
} from "../dist/attachments.js";
import { handleBridgeRequest } from "../dist/bridge-companion.js";
import {
  decryptFrame,
  generatePairCode,
  parsePairCode,
} from "../dist/bridge-pairing.js";
import { GrokBotGatewayError } from "../dist/grok-bot-gateway.js";
import { LocalGrokBotClient } from "../dist/grok-bot-client.js";
import { createRelayTransport } from "../dist/relay-transport.js";

const BOT = "bot-ada";
const OTHER_BOT = "bot-other";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureDir(context, label) {
  const root = await mkdtemp(join(hermetic.base, `${label}-`));
  resetAttachmentSessionStore(root);
  context.after(() => resetAttachmentSessionStore(root));
  return root;
}

function request(op, args, v = 4) {
  return {
    v,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op,
    args,
  };
}

function mockClient({
  bots,
  hostVersion = "f5c783a",
  transcript = [],
  uploadPath,
  chunk,
  sendImpl,
} = {}) {
  const calls = {
    readAttachmentChunk: [],
    uploadAttachment: [],
    sendPrompt: [],
    getHostStatus: 0,
    listAgents: 0,
  };
  let currentBots =
    bots ?? [{ id: BOT, name: "Ada", isGroup: false, isRunning: true, isComposingMessage: false }];
  return {
    calls,
    setBots(next) {
      currentBots = next;
    },
    discovery: () => ({ port: 1, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => {
      calls.listAgents += 1;
      return currentBots;
    },
    getHostStatus: async () => {
      calls.getHostStatus += 1;
      return { hostVersion };
    },
    getAgentTranscriptTail: async () => ({ entries: transcript, nextBeforeSeq: 1 }),
    getAsyncTasks: async () => [],
    getSubagents: async () => [],
    sendPrompt: async (input) => {
      calls.sendPrompt.push(input);
      return sendImpl === undefined ? { accepted: true } : sendImpl(input);
    },
    uploadAttachment: async (input) => {
      calls.uploadAttachment.push(input);
      return { path: typeof uploadPath === "function" ? uploadPath(input) : uploadPath };
    },
    readAttachmentChunk: async (input) => {
      calls.readAttachmentChunk.push(input);
      if (typeof chunk === "function") return chunk(input);
      return chunk ?? null;
    },
  };
}

async function writeText(dir, name, contents) {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

test("path escape .. is rejected and never forwarded to readAttachment", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-dotdot");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const badPath = join(hermetic.dataRoot, "agents", BOT, "attachments", "..", "secret.txt");
  const client = mockClient({
    transcript: [{ id: "entry-1", kind: "user-attachment", file_path: badPath, file_name: "secret.txt", seq: 1 }],
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "entry-1", offset: 0, length: 16 }),
    { stagingRoot, env },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("path escape absolute box path is rejected and never forwarded to readAttachment", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-box");
  const client = mockClient({
    transcript: [
      {
        id: "entry-box",
        kind: "user-attachment",
        file_path: "/workspace/secret.json",
        file_name: "secret.json",
        seq: 2,
      },
    ],
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "entry-box", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("path escape other Bot dir is rejected and never forwarded to readAttachment", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-other");
  const otherPath = join(hermetic.dataRoot, "agents", OTHER_BOT, "attachments", `${"a".repeat(64)}.txt`);
  const client = mockClient({
    transcript: [
      { id: "entry-other", kind: "user-attachment", file_path: otherPath, file_name: "x.txt", seq: 3 },
    ],
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "entry-other", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("path escape URL is rejected and never forwarded to readAttachment", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-url");
  const client = mockClient({
    transcript: [
      {
        id: "entry-url",
        kind: "send-message",
        message: { type: "attachment", url: "https://example.test/file.png", file_name: "file.png" },
        seq: 4,
      },
    ],
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "entry-url", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("symlinked source file is rejected", async (context) => {
  const dir = await fixtureDir(context, "att-symlink-src");
  const target = await writeText(dir, "note.txt", "hello attachment");
  const link = join(dir, "note-link.txt");
  await symlink(target, link);
  assert.throws(
    () => validateLocalAttachmentFile(link),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_REJECTED");
      return true;
    },
  );
});

test("symlink in staging is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-symlink-stage");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const uploadId = randomUUID();
  const client = mockClient();
  const first = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length + 8,
      sha256: sha256(Buffer.concat([bytes, Buffer.from("moredata")])),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(first.ok, true);
  const dataPath = join(stagingRoot, uploadId, "data");
  const decoy = await writeText(stagingRoot, "decoy.txt", "hijacked");
  await rm(dataPath);
  await symlink(decoy, dataPath);
  const second = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length + 8,
      sha256: sha256(Buffer.concat([bytes, Buffer.from("moredata")])),
      seq: 1,
      offset: bytes.length,
      bytes_b64: Buffer.from("moredata").toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "ATTACHMENT_REJECTED");
});

test("oversize 2 MiB + 1 is rejected", async (context) => {
  const dir = await fixtureDir(context, "att-oversize-2");
  const path = join(dir, "big.txt");
  await writeFile(path, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
  assert.throws(
    () => validateLocalAttachmentFile(path),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_TOO_LARGE");
      return true;
    },
  );
});

test("oversize 5 MiB image + 1 is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-oversize-5");
  const path = join(hermetic.dataRoot, "agents", BOT, "attachments", `${"b".repeat(64)}.png`);
  const client = mockClient({
    transcript: [{ id: "img-1", kind: "user-attachment", file_path: path, file_name: "shot.png", seq: 1 }],
    chunk: {
      bytesBase64: PNG.toString("base64"),
      totalSize: ATTACHMENT_IMAGE_MAX_BYTES + 1,
      mime: "image/png",
    },
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "img-1", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_TOO_LARGE");
  assert.equal(client.calls.readAttachmentChunk.length, 1);
  assert.equal(client.calls.readAttachmentChunk[0].path, path);
});

test("magic and extension mismatch is rejected", async (context) => {
  const dir = await fixtureDir(context, "att-magic");
  const path = join(dir, "not-a-png.png");
  await writeFile(path, JPEG);
  assert.throws(
    () => validateLocalAttachmentFile(path),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_REJECTED");
      return true;
    },
  );
});

test("empty file is rejected", async (context) => {
  const dir = await fixtureDir(context, "att-empty");
  const path = await writeText(dir, "empty.txt", "");
  assert.throws(
    () => validateLocalAttachmentFile(path),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_REJECTED");
      return true;
    },
  );
});

test("stale roster Bot removed between preview and commit", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-stale-roster");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const uploadId = randomUUID();
  const present = [{ id: BOT, name: "Ada", isGroup: false, isRunning: true, isComposingMessage: false }];
  let lists = 0;
  const client = mockClient();
  client.listAgents = async () => {
    lists += 1;
    return lists <= 2 ? present : [];
  };
  const staged = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: sha256(bytes),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(staged.ok, true);
  const committed = await handleBridgeRequest(
    client,
    request("attachment_commit", { upload_id: uploadId, bot_id: BOT }),
    { stagingRoot, env },
  );
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "ATTACHMENT_STALE");
  assert.equal(client.calls.uploadAttachment.length, 0);
});

test("SHA mismatch in the returned path is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-sha-path");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const digest = sha256(bytes);
  const uploadId = randomUUID();
  const client = mockClient({
    uploadPath: join(hermetic.dataRoot, "agents", BOT, "attachments", `${"c".repeat(64)}.txt`),
  });
  const staged = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: digest,
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(staged.ok, true);
  const committed = await handleBridgeRequest(
    client,
    request("attachment_commit", { upload_id: uploadId, bot_id: BOT }),
    { stagingRoot, env },
  );
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "ATTACHMENT_INTEGRITY");
  assert.equal(committed.error.commit_may_have_occurred, true);
});

test("chunk replay with the same bytes is accepted", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-replay");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const uploadId = randomUUID();
  const client = mockClient();
  const args = {
    upload_id: uploadId,
    bot_id: BOT,
    name: "note.txt",
    mime: "text/plain",
    total_size: bytes.length,
    sha256: sha256(bytes),
    seq: 0,
    offset: 0,
    bytes_b64: bytes.toString("base64"),
  };
  const first = await handleBridgeRequest(client, request("attachment_stage", args), { stagingRoot, env });
  const second = await handleBridgeRequest(client, request("attachment_stage", args), { stagingRoot, env });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.result.complete, true);
});

test("chunk replay with different bytes is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-replay-diff");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const uploadId = randomUUID();
  const client = mockClient();
  const args = {
    upload_id: uploadId,
    bot_id: BOT,
    name: "note.txt",
    mime: "text/plain",
    total_size: bytes.length,
    sha256: sha256(bytes),
    seq: 0,
    offset: 0,
    bytes_b64: bytes.toString("base64"),
  };
  assert.equal((await handleBridgeRequest(client, request("attachment_stage", args), { stagingRoot, env })).ok, true);
  const replayed = await handleBridgeRequest(
    client,
    request("attachment_stage", { ...args, bytes_b64: Buffer.from("HELLO ATTACHMENT\n").toString("base64") }),
    { stagingRoot, env },
  );
  assert.equal(replayed.ok, false);
  assert.equal(replayed.error.code, "ATTACHMENT_INTEGRITY");
});

test("chunk out-of-order is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-ooo");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const first = Buffer.from("hello ");
  const second = Buffer.from("world\n");
  const uploadId = randomUUID();
  const client = mockClient();
  const result = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: first.length + second.length,
      sha256: sha256(Buffer.concat([first, second])),
      seq: 1,
      offset: first.length,
      bytes_b64: second.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_STALE");
});

test("chunk gap is rejected", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-gap");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const first = Buffer.from("hello ");
  const second = Buffer.from("world\n");
  const uploadId = randomUUID();
  const client = mockClient();
  assert.equal(
    (
      await handleBridgeRequest(
        client,
        request("attachment_stage", {
          upload_id: uploadId,
          bot_id: BOT,
          name: "note.txt",
          mime: "text/plain",
          total_size: first.length + second.length + 4,
          sha256: sha256(Buffer.concat([first, second, Buffer.from("gap!")])),
          seq: 0,
          offset: 0,
          bytes_b64: first.toString("base64"),
        }),
        { stagingRoot, env },
      )
    ).ok,
    true,
  );
  const gapped = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: first.length + second.length + 4,
      sha256: sha256(Buffer.concat([first, second, Buffer.from("gap!")])),
      seq: 2,
      offset: first.length + second.length,
      bytes_b64: Buffer.from("gap!").toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(gapped.ok, false);
  assert.equal(gapped.error.code, "ATTACHMENT_REJECTED");
});

test("TTL expiry cleanup deletes a stale staging upload", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-ttl");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  let now = 1_000_000;
  const bytes = Buffer.from("hello attachment\n");
  const more = Buffer.from("more");
  const uploadId = randomUUID();
  const client = mockClient();
  const staged = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length + more.length,
      sha256: sha256(Buffer.concat([bytes, more])),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env, now: () => now },
  );
  assert.equal(staged.ok, true);
  now += ATTACHMENT_TTL_MS + 1;
  const expired = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length + more.length,
      sha256: sha256(Buffer.concat([bytes, more])),
      seq: 1,
      offset: bytes.length,
      bytes_b64: more.toString("base64"),
    }),
    { stagingRoot, env, now: () => now },
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "ATTACHMENT_STALE");
});

test("version gating allows the pinned hostVersion", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-host-allow");
  const bytes = Buffer.from("hello attachment\n");
  const result = await handleBridgeRequest(
    mockClient({ hostVersion: "f5c783a" }),
    request("attachment_stage", {
      upload_id: randomUUID(),
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: sha256(bytes),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.state, "staged");
});

test("version gating rejects an unknown hostVersion", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-host-deny");
  const bytes = Buffer.from("hello attachment\n");
  const result = await handleBridgeRequest(
    mockClient({ hostVersion: "deadbeef" }),
    request("attachment_stage", {
      upload_id: randomUUID(),
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: sha256(bytes),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UPGRADE_REQUIRED");
});

test("version gating override on accepts an extra host and logs unverified host", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-override-on");
  const previous = process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
  process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV] = "deadbeef";
  context.after(() => {
    if (previous === undefined) delete process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
    else process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV] = previous;
  });
  const bytes = Buffer.from("hello attachment\n");
  const writes = [];
  const { logUnverifiedHostOverride, attachmentHostAllowlist } = await import("../dist/attachments.js");
  const allow = attachmentHostAllowlist(process.env);
  logUnverifiedHostOverride(allow.unverifiedExtra, (chunk) => writes.push(chunk));
  assert.match(writes.join(""), /unverified host/);
  const result = await handleBridgeRequest(
    mockClient({ hostVersion: "deadbeef" }),
    request("attachment_stage", {
      upload_id: randomUUID(),
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: sha256(bytes),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot, [ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV]: "deadbeef" } },
  );
  assert.equal(result.ok, true);
});

test("version gating override off keeps an unknown host closed", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-override-off");
  const previous = process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
  delete process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
  context.after(() => {
    if (previous === undefined) delete process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV];
    else process.env[ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV] = previous;
  });
  const bytes = Buffer.from("hello attachment\n");
  const result = await handleBridgeRequest(
    mockClient({ hostVersion: "deadbeef" }),
    request("attachment_stage", {
      upload_id: randomUUID(),
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: sha256(bytes),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UPGRADE_REQUIRED");
});

test("old companion maps attachment 4400 to UPGRADE_REQUIRED", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`));
  server.on("connection", (socket) => {
    socket.once("message", () => socket.close(4400, "invalid frame"));
  });
  try {
    const transport = createRelayTransport(config);
    await assert.rejects(
      transport.stageAttachment({
        upload_id: randomUUID(),
        bot_id: BOT,
        name: "note.txt",
        mime: "text/plain",
        total_size: 4,
        sha256: "a".repeat(64),
        seq: 0,
        offset: 0,
        bytes_b64: Buffer.from("abcd").toString("base64"),
      }),
      (caught) => {
        assert(caught instanceof GrokBotGatewayError);
        assert.equal(caught.code, "UPGRADE_REQUIRED");
        assert.equal(caught.deliveryMayHaveOccurred, false);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      for (const client of server.clients) client.terminate();
      server.close((caught) => (caught ? reject(caught) : resolve()));
    });
  }
});

test("stale entry_id returns ATTACHMENT_STALE", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-stale-entry");
  const result = await handleBridgeRequest(
    mockClient({ transcript: [] }),
    request("attachment_fetch", { bot_id: BOT, entry_id: "missing-entry", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_STALE");
});

test("no retry after an ambiguous send", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`));
  let sends = 0;
  server.on("connection", (socket) => {
    socket.once("message", (data) => {
      const body = JSON.parse(decryptFrame(config, "codex", data.toString("utf8")).toString("utf8"));
      if (body.op === "send_message") {
        sends += 1;
        socket.close(4404, "peer unavailable");
        return;
      }
      socket.close(4400, "invalid frame");
    });
  });
  try {
    const transport = createRelayTransport(config);
    await assert.rejects(
      transport.sendMessage("bot-1", "with file", undefined, { attachmentRefs: [randomUUID()] }),
      (caught) => {
        assert(caught instanceof GrokBotGatewayError);
        assert.equal(caught.code, "UNAVAILABLE");
        assert.equal(caught.deliveryMayHaveOccurred, true);
        return true;
      },
    );
    assert.equal(sends, 1);
  } finally {
    await new Promise((resolve, reject) => {
      for (const client of server.clients) client.terminate();
      server.close((caught) => (caught ? reject(caught) : resolve()));
    });
  }
});

test("readAttachment is only called with a path taken from a fresh transcript entry", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-fresh-path");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const digest = sha256(PNG);
  const freshPath = expectedCommittedPath(hermetic.dataRoot, BOT, digest, ".png");
  const client = mockClient({
    transcript: [
      { id: "fresh-1", kind: "user-attachment", file_path: freshPath, file_name: "shot.png", seq: 9 },
    ],
    chunk: (input) => ({
      bytesBase64: PNG.toString("base64"),
      totalSize: PNG.length,
      mime: "image/png",
      echoed: input.path,
    }),
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "fresh-1", offset: 0, length: 16 }),
    { stagingRoot, env },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    client.calls.readAttachmentChunk.map((call) => call.path),
    [freshPath],
  );
  assert.equal(result.result.sha256, digest);
});

test("successful commit and send keep the VM path off the relay result", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-commit-send");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const digest = sha256(bytes);
  const uploadId = randomUUID();
  const committedPath = expectedCommittedPath(hermetic.dataRoot, BOT, digest, ".txt");
  const client = mockClient({ uploadPath: committedPath });
  const staged = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: digest,
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(staged.ok, true);
  const committed = await handleBridgeRequest(
    client,
    request("attachment_commit", { upload_id: uploadId, bot_id: BOT }),
    { stagingRoot, env },
  );
  assert.equal(committed.ok, true);
  assert.equal(committed.result.state, "committed");
  assert.match(committed.result.attachment_ref, /^[0-9a-f-]{36}$/i);
  assert(!JSON.stringify(committed).includes(committedPath));
  const sent = await handleBridgeRequest(
    client,
    request(
      "send_message",
      { bot_id: BOT, message: "see file", attachment_refs: [committed.result.attachment_ref] },
      4,
    ),
    { stagingRoot, env },
  );
  assert.equal(sent.ok, true);
  assert.deepEqual(client.calls.sendPrompt[0].attachmentPaths, [committedPath]);
  assert.deepEqual(client.calls.sendPrompt[0].attachmentNames, ["note.txt"]);
  assert.equal(sent.error, undefined);
  assert(!JSON.stringify(sent).includes(committedPath));
});

test("status advertises attachment capabilities only for an allowlisted host", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-status-caps");
  const allowed = await handleBridgeRequest(
    mockClient({ hostVersion: "f5c783a" }),
    request("status", {}, 3),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.deepEqual(allowed.result.supported_protocol_versions, [1, 2, 3, 4]);
  assert.deepEqual(allowed.result.capabilities, [
    "status",
    "list_bots",
    "read_bot",
    "send_message",
    "attachment_send_v1",
    "attachment_read_v1",
  ]);
  const denied = await handleBridgeRequest(
    mockClient({ hostVersion: "unknown" }),
    request("status", {}, 3),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.deepEqual(denied.result.capabilities, ["status", "list_bots", "read_bot", "send_message"]);
});

test("new LocalGrokBotClient attachment RPCs use an explicit discoveryPath and env", async (context) => {
  const root = await fixtureDir(context, "att-client");
  const discoveryPath = join(root, "gateway.json");
  await writeFile(
    discoveryPath,
    JSON.stringify({ port: 4137, pid: 5137, startedAt: 6137, host: "127.0.0.1", token: "gateway-test-token" }),
    { mode: 0o600 },
  );
  const seen = [];
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    verifyServer: () => true,
    fetch: async (input, init) => {
      seen.push({ url: String(input), body: init?.body });
      if (String(input).endsWith("/getHostStatus")) {
        return Response.json({ hostVersion: "f5c783a", capabilities: [] });
      }
      if (String(input).endsWith("/uploadAttachment")) {
        return Response.json({ path: "/tmp/should-not-matter" });
      }
      return Response.json({
        bytesBase64: PNG.toString("base64"),
        totalSize: PNG.length,
        mime: "image/png",
      });
    },
  });
  assert.equal((await client.getHostStatus()).hostVersion, "f5c783a");
  assert.equal((await client.uploadAttachment({ agentId: BOT, filename: "a.png", bytesBase64: PNG.toString("base64") })).path, "/tmp/should-not-matter");
  assert.equal((await client.readAttachmentChunk({ agentId: BOT, path: "/ignored", offset: 0, length: 8 })).totalSize, PNG.length);
  assert.equal(seen.length, 3);
});
