import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from "@modelcontextprotocol/server";
import { WebSocketServer } from "ws";
import { hermetic } from "./hermetic-setup.mjs";
import {
  ATTACHMENT_HOST_ALLOWLIST_EXTRA_ENV,
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TTL_MS,
  AttachmentError,
  assertNotSensitiveAttachmentSource,
  assertSafeBotAttachmentPath,
  attachmentPreviewToken,
  attachmentSessionStore,
  expectedCommittedPath,
  isUnderBotAttachmentRoots,
  openConfinedBotAttachment,
  validateLocalAttachmentFile,
} from "../dist/attachments.js";
import { handleBridgeRequest } from "../dist/bridge-companion.js";
import {
  decryptFrame,
  generatePairCode,
  parsePairCode,
} from "../dist/bridge-pairing.js";
import {
  GrokBotGatewayError,
  HUMAN_APPROVAL_MIN_MS,
  registerGrokBotTools,
  setApprovalNowMsForTest,
} from "../dist/grok-bot-gateway.js";
import {
  DEFAULT_GROK_BOT_DATA_ROOT,
  LEGACY_GROK_BOT_DATA_ROOT,
  LocalGrokBotClient,
} from "../dist/grok-bot-client.js";
import { createRelayTransport } from "../dist/relay-transport.js";

const BOT = "bot-ada";
const OTHER_BOT = "bot-other";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resetAttachmentSessionStore(root) {
  attachmentSessionStore(root, undefined, { reset: true });
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

async function writeBotAttachment(botId, name, contents) {
  const directory = join(hermetic.dataRoot, "agents", botId, "attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

function attachmentGuard(home = hermetic.accountHome, extra = {}) {
  const guard = {
    homes: extra.homes ?? [home],
    sandRoots: extra.sandRoots ?? [hermetic.defaultSandRoot, hermetic.legacySandRoot],
  };
  if (extra.resolveOpenedFd !== undefined) guard.resolveOpenedFd = extra.resolveOpenedFd;
  return guard;
}

const FIXTURE_GUARD = attachmentGuard();

function unavailableOpenedFd() {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

async function openAttachmentMcp(
  transport,
  {
    approve = false,
    elicitationAction,
    capabilities = { elicitation: {} },
    approvalElapsedMs = 0,
    elicitationExtras = {},
  } = {},
) {
  const mcpServer = new McpServer({ name: "attachment-tool-test", version: "1" });
  registerGrokBotTools(mcpServer, transport, { attachmentGuard: FIXTURE_GUARD });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const elicitationRequests = [];
  let nextId = 0;
  const pending = new Map();
  const action = elicitationAction ?? (approve ? "accept" : "decline");
  let nowMs = 1_000_000;
  setApprovalNowMsForTest(() => nowMs);
  clientTransport.onmessage = async (message) => {
    if ("method" in message) {
      if (message.method === "elicitation/create" && "id" in message) {
        elicitationRequests.push(message.params);
        nowMs += approvalElapsedMs;
        await clientTransport.send({
          jsonrpc: "2.0",
          id: message.id,
          result:
            action === "accept"
              ? { action: "accept", content: { confirm: true }, ...elicitationExtras }
              : { action, ...elicitationExtras },
        });
      }
      return;
    }
    if (!("id" in message)) return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
  };
  const request = async (method, params = {}) => {
    const id = ++nextId;
    const response = new Promise((resolve) => pending.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    const message = await response;
    if ("error" in message) throw new Error(JSON.stringify(message.error));
    return message.result;
  };
  await mcpServer.connect(serverTransport);
  await clientTransport.start();
  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities,
    clientInfo: { name: "attachment-test", version: "1" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    elicitationRequests,
    request,
    async close() {
      setApprovalNowMsForTest();
      await clientTransport.close();
      await mcpServer.close();
    },
  };
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
    () => validateLocalAttachmentFile(link, undefined, process.env, hermetic.accountHome, FIXTURE_GUARD),
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
    () => validateLocalAttachmentFile(path, undefined, process.env, hermetic.accountHome, FIXTURE_GUARD),
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
  await mkdir(join(hermetic.dataRoot, "agents", BOT, "attachments"), { recursive: true, mode: 0o700 });
  const oversized = Buffer.alloc(ATTACHMENT_IMAGE_MAX_BYTES + 1);
  PNG.copy(oversized);
  await writeFile(path, oversized);
  const client = mockClient({
    transcript: [{ id: "img-1", kind: "user-attachment", file_path: path, file_name: "shot.png", seq: 1 }],
  });
  const result = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "img-1", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_TOO_LARGE");
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("magic and extension mismatch is rejected", async (context) => {
  const dir = await fixtureDir(context, "att-magic");
  const path = join(dir, "not-a-png.png");
  await writeFile(path, JPEG);
  assert.throws(
    () => validateLocalAttachmentFile(path, undefined, process.env, hermetic.accountHome, FIXTURE_GUARD),
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
    () => validateLocalAttachmentFile(path, undefined, process.env, hermetic.accountHome, FIXTURE_GUARD),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_REJECTED");
      return true;
    },
  );
});

test("missing outbound source is ATTACHMENT_REJECTED", () => {
  const missing = join(hermetic.base, "missing-outbound.txt");
  assert.throws(
    () =>
      validateLocalAttachmentFile(
        missing,
        "note.txt",
        { SAND_DATA_ROOT: hermetic.dataRoot },
        hermetic.accountHome,
        FIXTURE_GUARD,
      ),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
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
  const opened = await handleBridgeRequest(
    client,
    request("attachment_stage", {
      upload_id: uploadId,
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: first.length + second.length,
      sha256: sha256(Buffer.concat([first, second])),
      seq: 0,
      offset: 0,
      bytes_b64: first.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(opened.ok, true);
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
      offset: 0,
      bytes_b64: second.toString("base64"),
    }),
    { stagingRoot, env },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
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
  await assert.rejects(lstat(join(stagingRoot, uploadId)), { code: "ENOENT" });
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
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return originalWrite.call(process.stderr, chunk, encoding, callback);
  };
  context.after(() => {
    process.stderr.write = originalWrite;
  });
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
  assert.match(writes.join(""), /unverified host/);
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
  if (process.platform !== "linux") return context.skip("Linux only");
  const stagingRoot = await fixtureDir(context, "att-fresh-path");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const digest = sha256(PNG);
  const freshPath = expectedCommittedPath(hermetic.dataRoot, BOT, digest, ".png");
  await mkdir(join(hermetic.dataRoot, "agents", BOT, "attachments"), { recursive: true, mode: 0o700 });
  await writeFile(freshPath, PNG);
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
  assert.deepEqual(client.calls.readAttachmentChunk, []);
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

test("nonexistent attachment path is ATTACHMENT_STALE", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-b1-missing");
  const ghost = join(hermetic.dataRoot, "agents", BOT, "attachments", "ghost.txt");
  await mkdir(join(hermetic.dataRoot, "agents", BOT, "attachments"), { recursive: true, mode: 0o700 });
  assert.throws(() => assertSafeBotAttachmentPath(ghost, BOT, hermetic.dataRoot), (caught) => {
    assert(caught instanceof AttachmentError);
    assert.equal(caught.code, "ATTACHMENT_STALE");
    return true;
  });
  const result = await handleBridgeRequest(
    mockClient({
      transcript: [{ id: "ghost", kind: "user-attachment", file_path: ghost, file_name: "ghost.txt", seq: 1 }],
    }),
    request("attachment_fetch", { bot_id: BOT, entry_id: "ghost", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_STALE");
});

test("dangling symlink in attachments is ATTACHMENT_REJECTED", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-b1-dangle");
  const dangling = await writeBotAttachment(BOT, "dangle.json", "{}");
  await rm(dangling);
  await symlink(join(hermetic.base, "later.json"), dangling);
  assert.throws(() => assertSafeBotAttachmentPath(dangling, BOT, hermetic.dataRoot), (caught) => {
    assert(caught instanceof AttachmentError);
    assert.equal(caught.code, "ATTACHMENT_STALE");
    return true;
  });
  const result = await handleBridgeRequest(
    mockClient({
      transcript: [{ id: "dangle", kind: "user-attachment", file_path: dangling, file_name: "dangle.json", seq: 1 }],
    }),
    request("attachment_fetch", { bot_id: BOT, entry_id: "dangle", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
});

test("hardlink in attachments is ATTACHMENT_REJECTED and does not leak", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-b3-hardlink");
  const secretDir = join(hermetic.base, "home", ".config", "codex-grok-mcp");
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  const secret = join(secretDir, "bridge.json");
  await writeFile(secret, '{"FIXTURE_SECRET":"s3cr3t"}', { mode: 0o600 });
  const linked = join(hermetic.dataRoot, "agents", BOT, "attachments", "hard.json");
  await mkdir(join(hermetic.dataRoot, "agents", BOT, "attachments"), { recursive: true, mode: 0o700 });
  await link(secret, linked);
  const result = await handleBridgeRequest(
    mockClient({
      transcript: [{ id: "hard", kind: "user-attachment", file_path: linked, file_name: "hard.json", seq: 1 }],
    }),
    request("attachment_fetch", { bot_id: BOT, entry_id: "hard", offset: 0, length: 64 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
  assert.equal(JSON.stringify(result).includes("FIXTURE_SECRET"), false);
});

test("symlink swap after a successful confined open does not leak on later windows", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const stagingRoot = await fixtureDir(context, "att-b2-swap");
  const secret = join(hermetic.base, "swap-secret.txt");
  await writeFile(secret, "FIXTURE_SECRET".padEnd(70_000, "B"));
  const big = await writeBotAttachment(BOT, "big.txt", "A".repeat(70_000));
  const client = mockClient({
    transcript: [{ id: "big", kind: "user-attachment", file_path: big, file_name: "big.txt", seq: 1 }],
  });
  const first = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "big", offset: 0, length: 16 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(first.ok, true);
  await rm(big);
  await symlink(secret, big);
  const second = await handleBridgeRequest(
    client,
    request("attachment_fetch", { bot_id: BOT, entry_id: "big", offset: 65_536, length: 4_464 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(second.ok, true);
  assert.equal(Buffer.from(second.result.bytes_b64, "base64").toString("utf8").includes("FIXTURE_SECRET"), false);
  assert.match(Buffer.from(second.result.bytes_b64, "base64").toString("utf8"), /^A+$/);
  assert.deepEqual(client.calls.readAttachmentChunk, []);
});

test("symlink in attachments at fetch time is ATTACHMENT_REJECTED", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-symlink-fetch");
  const secret = join(hermetic.base, "bridge-secret.json");
  await writeFile(secret, '{"FIXTURE_SECRET":"s3cr3t"}');
  const linked = join(hermetic.dataRoot, "agents", BOT, "attachments", "link.json");
  await mkdir(join(hermetic.dataRoot, "agents", BOT, "attachments"), { recursive: true, mode: 0o700 });
  await symlink(secret, linked);
  const result = await handleBridgeRequest(
    mockClient({
      transcript: [{ id: "link", kind: "user-attachment", file_path: linked, file_name: "link.json", seq: 1 }],
    }),
    request("attachment_fetch", { bot_id: BOT, entry_id: "link", offset: 0, length: 64 }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_REJECTED");
});

test("outbound denies grok auth.json by path and by file identity", async (context) => {
  const home = join(hermetic.base, "deny-home");
  const grokDir = join(home, ".grok");
  await mkdir(grokDir, { recursive: true, mode: 0o700 });
  const auth = join(grokDir, "auth.json");
  await writeFile(auth, '{"token":"nope"}', { mode: 0o600 });
  assert.throws(
    () => validateLocalAttachmentFile(auth, "auth.json", { SAND_DATA_ROOT: hermetic.dataRoot }, home, attachmentGuard(home)),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
  const copy = join(hermetic.base, "not-secret.json");
  await link(auth, copy);
  assert.throws(
    () => validateLocalAttachmentFile(copy, "not-secret.json", { SAND_DATA_ROOT: hermetic.dataRoot }, home, attachmentGuard(home)),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
});

test("outbound denies pairing bridge.json and shows the resolved path on a safe file", async (context) => {
  const home = join(hermetic.base, "pair-home");
  const configDir = join(home, ".config", "codex-grok-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const pairing = join(configDir, "bridge.json");
  await writeFile(pairing, '{"key":"nope"}', { mode: 0o600 });
  assert.throws(
    () => validateLocalAttachmentFile(pairing, "bridge.json", { SAND_DATA_ROOT: hermetic.dataRoot }, home, attachmentGuard(home)),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
  const safe = await writeText(hermetic.base, "ok.txt", "hello attachment\n");
  const decision = validateLocalAttachmentFile(safe, "ok.txt", { SAND_DATA_ROOT: hermetic.dataRoot }, home, attachmentGuard(home));
  assert.equal(decision.resolved_path, realpathSync(safe));
});

test("preview token binds bot, name, type, size, and sha", () => {
  const token = attachmentPreviewToken({
    bot_id: BOT,
    path_identity: "a".repeat(64),
    sha256: "b".repeat(64),
    size: 12,
    mime: "text/plain",
    name: "note.txt",
    roster_fingerprint: "sha256:" + "c".repeat(64),
  });
  const other = attachmentPreviewToken({
    bot_id: OTHER_BOT,
    path_identity: "a".repeat(64),
    sha256: "b".repeat(64),
    size: 12,
    mime: "text/plain",
    name: "note.txt",
    roster_fingerprint: "sha256:" + "c".repeat(64),
  });
  assert.notEqual(token, other);
  assert.match(token, /^[a-f0-9]{64}$/);
});

test("upload_id reuse after a store restart is ATTACHMENT_STALE", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-reuse");
  const env = { SAND_DATA_ROOT: hermetic.dataRoot };
  const bytes = Buffer.from("hello attachment\n");
  const uploadId = randomUUID();
  const first = await handleBridgeRequest(
    mockClient(),
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
  assert.equal(first.ok, true);
  resetAttachmentSessionStore(stagingRoot);
  const reused = await handleBridgeRequest(
    mockClient(),
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
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "ATTACHMENT_STALE");
});

test("whole-object SHA mismatch at stage completion is ATTACHMENT_INTEGRITY", async (context) => {
  const stagingRoot = await fixtureDir(context, "att-sha-complete");
  const bytes = Buffer.from("hello attachment\n");
  const result = await handleBridgeRequest(
    mockClient(),
    request("attachment_stage", {
      upload_id: randomUUID(),
      bot_id: BOT,
      name: "note.txt",
      mime: "text/plain",
      total_size: bytes.length,
      sha256: "a".repeat(64),
      seq: 0,
      offset: 0,
      bytes_b64: bytes.toString("base64"),
    }),
    { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ATTACHMENT_INTEGRITY");
});

test("dot-dot in a filename segment is allowed when the path stays confined", () => {
  assert.equal(
    isUnderBotAttachmentRoots(
      join(hermetic.dataRoot, "agents", BOT, "attachments", "a..b.txt"),
      BOT,
      hermetic.dataRoot,
    ),
    true,
  );
});

test("tool preview transfers nothing and a preview mismatch is ROSTER_CHANGED", async (context) => {
  const root = await fixtureDir(context, "att-tool-preview");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  let staged = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      staged += 1;
      throw new Error("should not stage");
    },
    async commitAttachment() {
      throw new Error("should not commit");
    },
  };
  const mcp = await openAttachmentMcp(transport);
  try {
    const preview = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: { bot_id: BOT, path },
    });
    assert.equal(preview.structuredContent.requires_confirmation, true);
    assert.equal(preview.structuredContent.state, "validated");
    assert.match(preview.content[0].text, /No file transferred/);
    assert.match(preview.content[0].text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(staged, 0);
    const mismatch = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: "d".repeat(64),
      },
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0].text, /ROSTER_CHANGED/);
    assert.equal(staged, 0);
  } finally {
    await mcp.close();
  }
});

test("declined attachment elicitation is CANCELLED with no stage call", async (context) => {
  const root = await fixtureDir(context, "att-tool-decline");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  let staged = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      staged += 1;
    },
    async commitAttachment() {
      throw new Error("unused");
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, {
    approve: false,
    approvalElapsedMs: HUMAN_APPROVAL_MIN_MS,
  });
  try {
    const declined = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /CANCELLED/);
    assert.match(declined.content[0].text, /approval_action=decline/);
    assert.match(declined.content[0].text, /on-request/);
    assert.equal(staged, 0);
    assert.equal(mcp.elicitationRequests.length, 1);
  } finally {
    await mcp.close();
  }
});

test("cancelled attachment elicitation is CANCELLED with approval_action=cancel", async (context) => {
  const root = await fixtureDir(context, "att-tool-cancel");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  let staged = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      staged += 1;
    },
    async commitAttachment() {
      throw new Error("unused");
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, {
    elicitationAction: "cancel",
    approvalElapsedMs: HUMAN_APPROVAL_MIN_MS,
  });
  try {
    const cancelled = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /CANCELLED/);
    assert.match(cancelled.content[0].text, /approval_action=cancel/);
    assert.doesNotMatch(cancelled.content[0].text, /approval_action=decline/);
    assert.equal(staged, 0);
    assert.equal(mcp.elicitationRequests.length, 1);
  } finally {
    await mcp.close();
  }
});

test("attachment confirm without a prompting client is APPROVAL_UNAVAILABLE", async (context) => {
  const root = await fixtureDir(context, "att-tool-no-elicit");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  let staged = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      staged += 1;
    },
    async commitAttachment() {
      throw new Error("unused");
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, {
    approve: false,
    capabilities: {},
  });
  try {
    const unavailable = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /APPROVAL_UNAVAILABLE/);
    assert.match(unavailable.content[0].text, /on-request, not never/);
    assert.doesNotMatch(unavailable.content[0].text, /CANCELLED/);
    assert.equal(staged, 0);
    assert.equal(mcp.elicitationRequests.length, 0);
  } finally {
    await mcp.close();
  }
});

function unusedSendTransport(listBots, staged) {
  return {
    listBots,
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      staged.value += 1;
    },
    async commitAttachment() {
      throw new Error("unused");
    },
  };
}

function confirmAttachmentArgs(path, preview) {
  return {
    bot_id: BOT,
    path,
    roster_fingerprint: preview.structuredContent.roster_fingerprint,
    confirmation: "SEND_ATTACHMENT",
    path_identity: preview.structuredContent.path_identity,
    sha256: preview.structuredContent.sha256,
    preview_token: preview.structuredContent.preview_token,
  };
}

test("fast auto-decline of attachment elicitation is APPROVAL_UNAVAILABLE", async (context) => {
  const root = await fixtureDir(context, "att-tool-fast-decline");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const staged = { value: 0 };
  const transport = unusedSendTransport(async () => [{ id: BOT, name: "Ada", is_running: true }], staged);
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, { approve: false, approvalElapsedMs: 1_700 });
  try {
    const unavailable = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: confirmAttachmentArgs(path, preview),
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /APPROVAL_UNAVAILABLE/);
    assert.doesNotMatch(unavailable.content[0].text, /CANCELLED/);
    assert.equal(staged.value, 0);
    assert.equal(mcp.elicitationRequests.length, 1);
  } finally {
    await mcp.close();
  }
});

test("signaled auto-decline of attachment elicitation is APPROVAL_UNAVAILABLE", async (context) => {
  const root = await fixtureDir(context, "att-tool-signaled-decline");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const staged = { value: 0 };
  const transport = unusedSendTransport(async () => [{ id: BOT, name: "Ada", is_running: true }], staged);
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, {
    approve: false,
    approvalElapsedMs: HUMAN_APPROVAL_MIN_MS,
    elicitationExtras: { _meta: { approval_policy: "never" } },
  });
  try {
    const unavailable = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: confirmAttachmentArgs(path, preview),
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /APPROVAL_UNAVAILABLE/);
    assert.equal(staged.value, 0);
  } finally {
    await mcp.close();
  }
});

test("explicit form elicitation capability can prompt; url-only cannot", async (context) => {
  const root = await fixtureDir(context, "att-tool-elicit-modes");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const staged = { value: 0 };
  const transport = unusedSendTransport(async () => [{ id: BOT, name: "Ada", is_running: true }], staged);
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const form = await openAttachmentMcp(transport, {
    approve: false,
    capabilities: { elicitation: { form: {} } },
    approvalElapsedMs: HUMAN_APPROVAL_MIN_MS,
  });
  try {
    const declined = await form.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: confirmAttachmentArgs(path, preview),
    });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /CANCELLED/);
    assert.equal(form.elicitationRequests.length, 1);
  } finally {
    await form.close();
  }
  const urlOnly = await openAttachmentMcp(transport, {
    approve: false,
    capabilities: { elicitation: { url: {} } },
  });
  try {
    const unavailable = await urlOnly.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: confirmAttachmentArgs(path, preview),
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /APPROVAL_UNAVAILABLE/);
    assert.equal(urlOnly.elicitationRequests.length, 0);
    assert.equal(staged.value, 0);
  } finally {
    await urlOnly.close();
  }
});

test("attachment preview with is_running false then confirm with true succeeds", async (context) => {
  const root = await fixtureDir(context, "att-tool-running-flip");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  let running = false;
  let staged = 0;
  let sent = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: running }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      sent += 1;
      return { accepted: true, requestId: "req-running-flip" };
    },
    async stageAttachment() {
      staged += 1;
      return { state: "staged", upload_id: "u1", received_bytes: 18, total_size: 18, complete: true };
    },
    async commitAttachment() {
      return { state: "committed", attachment_ref: "ref-running-flip" };
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  assert.equal(preview.structuredContent.requires_confirmation, true);
  running = true;
  const mcp = await openAttachmentMcp(transport, { approve: true });
  try {
    const confirmed = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: confirmAttachmentArgs(path, preview),
    });
    assert.equal(confirmed.isError, undefined);
    assert.equal(confirmed.structuredContent.accepted, true);
    assert.equal(staged >= 1, true);
    assert.equal(sent, 1);
  } finally {
    await mcp.close();
  }
});

test("send without stage or commit is UPGRADE_REQUIRED", async (context) => {
  const root = await fixtureDir(context, "att-tool-upgrade");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, { approve: true });
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /UPGRADE_REQUIRED/);
    assert.match(result.content[0].text, /failed_stage=validated/);
  } finally {
    await mcp.close();
  }
});

test("tool fetch returns one verified image and never treats a window as the whole file", async () => {
  const body = Buffer.concat([PNG, Buffer.alloc(70_000, 0x41)]);
  let fetches = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async fetchAttachment({ offset, length }) {
      fetches += 1;
      const window = body.subarray(offset, offset + length);
      return {
        bytes_b64: window.toString("base64"),
        total_size: body.length,
        sha256: sha256(body),
        mime: "image/png",
        name: "shot.png",
        truncated: offset + window.length < body.length,
      };
    },
  };
  const mcp = await openAttachmentMcp(transport);
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_fetch_bot_attachment",
      arguments: { bot_id: BOT, entry_id: "img-1" },
    });
    assert.equal(result.structuredContent.untrusted_external_content, true);
    assert.equal(result.structuredContent.truncated, false);
    assert.equal(result.structuredContent.total_size, body.length);
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].data, body.toString("base64"));
    assert.match(result.content[0].text, /UNTRUSTED EXTERNAL CONTENT/);
    assert.equal(fetches >= 2, true);
  } finally {
    await mcp.close();
  }
});

test("inbound open without /proc/self/fd is ATTACHMENT_REJECTED", async () => {
  const path = await writeBotAttachment(BOT, "noproc.txt", "SAFE_BYTES");
  assert.throws(
    () =>
      openConfinedBotAttachment(
        path,
        BOT,
        hermetic.dataRoot,
        ATTACHMENT_MAX_BYTES,
        "noproc.txt",
        unavailableOpenedFd,
      ),
    (caught) => {
      assert(caught instanceof AttachmentError);
      assert.equal(caught.code, "ATTACHMENT_REJECTED");
      return true;
    },
  );
});

test("inbound parent-directory swap with no /proc does not leak", async (context) => {
  const attachments = join(hermetic.dataRoot, "agents", BOT, "attachments");
  const path = await writeBotAttachment(BOT, "inside.txt", "SAFE_BYTES");
  const outside = join(hermetic.base, "b5-parent-outside");
  await mkdir(outside, { recursive: true, mode: 0o700 });
  await writeFile(join(outside, "inside.txt"), "FIXTURE_SECRET");
  const swapThenFail = () => {
    const moved = `${attachments}.real`;
    rmSync(moved, { recursive: true, force: true });
    renameSync(attachments, moved);
    symlinkSync(outside, attachments);
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  try {
    assert.throws(
      () =>
        openConfinedBotAttachment(
          path,
          BOT,
          hermetic.dataRoot,
          ATTACHMENT_MAX_BYTES,
          "inside.txt",
          swapThenFail,
        ),
      (caught) => {
        assert(caught instanceof AttachmentError);
        assert.equal(caught.code, "ATTACHMENT_REJECTED");
        assert.equal(String(caught.message).includes("FIXTURE_SECRET"), false);
        return true;
      },
    );
    const stagingRoot = await fixtureDir(context, "att-b5-parent");
    const result = await handleBridgeRequest(
      mockClient({
        transcript: [{ id: "inside", kind: "user-attachment", file_path: path, file_name: "inside.txt", seq: 1 }],
      }),
      request("attachment_fetch", { bot_id: BOT, entry_id: "inside", offset: 0, length: 16 }),
      { stagingRoot, env: { SAND_DATA_ROOT: hermetic.dataRoot }, resolveOpenedFd: unavailableOpenedFd },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ATTACHMENT_REJECTED");
    assert.equal(JSON.stringify(result).includes("FIXTURE_SECRET"), false);
  } finally {
    rmSync(attachments, { recursive: true, force: true });
    rmSync(`${attachments}.real`, { recursive: true, force: true });
  }
});

test("parent-directory swap after a confined open is ATTACHMENT_REJECTED", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const attachments = join(hermetic.dataRoot, "agents", BOT, "attachments");
  rmSync(attachments, { recursive: true, force: true });
  const path = await writeBotAttachment(BOT, "keep.txt", "SAFE_BYTES");
  const first = openConfinedBotAttachment(path, BOT, hermetic.dataRoot, ATTACHMENT_MAX_BYTES, "keep.txt");
  assert.equal(first.bytes.toString("utf8"), "SAFE_BYTES");
  const outside = join(hermetic.base, "b5-parent-after");
  await mkdir(outside, { recursive: true, mode: 0o700 });
  await writeFile(join(outside, "keep.txt"), "FIXTURE_SECRET");
  rmSync(attachments, { recursive: true, force: true });
  symlinkSync(outside, attachments);
  try {
    assert.throws(
      () => openConfinedBotAttachment(path, BOT, hermetic.dataRoot, ATTACHMENT_MAX_BYTES, "keep.txt"),
      (caught) => {
        assert(caught instanceof AttachmentError);
        assert.equal(caught.code, "ATTACHMENT_REJECTED");
        return true;
      },
    );
  } finally {
    rmSync(attachments, { recursive: true, force: true });
  }
});

test("outbound still rejects injected account-home credentials when hermetic env is spoofed", async (context) => {
  const accountHome = join(hermetic.base, "sh2-account-home");
  const spoofHome = join(hermetic.base, "sh2-spoof-home");
  const decoyAccount = join(hermetic.base, "sh2-decoy-account");
  await mkdir(join(accountHome, ".grok"), { recursive: true, mode: 0o700 });
  await mkdir(join(accountHome, ".codex"), { recursive: true, mode: 0o700 });
  await mkdir(join(accountHome, ".config", "codex-grok-mcp"), { recursive: true, mode: 0o700 });
  await mkdir(spoofHome, { recursive: true, mode: 0o700 });
  await mkdir(decoyAccount, { recursive: true, mode: 0o700 });
  const grokAuth = join(accountHome, ".grok", "auth.json");
  const codexAuth = join(accountHome, ".codex", "auth.json");
  const pairing = join(accountHome, ".config", "codex-grok-mcp", "bridge.json");
  await writeFile(grokAuth, '{"token":"grok"}', { mode: 0o600 });
  await writeFile(codexAuth, '{"token":"codex"}', { mode: 0o600 });
  await writeFile(pairing, '{"key":"pair"}', { mode: 0o600 });
  const previousHome = process.env.HOME;
  const previousAccount = process.env.CODEX_GROK_TEST_ACCOUNT_HOME;
  process.env.HOME = spoofHome;
  process.env.CODEX_GROK_TEST_HERMETIC = "1";
  process.env.CODEX_GROK_TEST_ACCOUNT_HOME = decoyAccount;
  context.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAccount === undefined) delete process.env.CODEX_GROK_TEST_ACCOUNT_HOME;
    else process.env.CODEX_GROK_TEST_ACCOUNT_HOME = previousAccount;
  });
  const env = {
    HOME: spoofHome,
    CODEX_GROK_TEST_HERMETIC: "1",
    CODEX_GROK_TEST_ACCOUNT_HOME: decoyAccount,
    SAND_DATA_ROOT: hermetic.dataRoot,
  };
  for (const [path, name] of [
    [grokAuth, "auth.json"],
    [codexAuth, "auth.json"],
    [pairing, "bridge.json"],
  ]) {
    assert.throws(
      () => validateLocalAttachmentFile(path, name, env, spoofHome, attachmentGuard(accountHome)),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound falls back to path realpath when /proc/self/fd is unavailable", async () => {
  const safe = await writeText(hermetic.base, "fallback.txt", "hello fallback\n");
  const decision = validateLocalAttachmentFile(
    safe,
    "fallback.txt",
    { SAND_DATA_ROOT: hermetic.dataRoot },
    hermetic.accountHome,
    attachmentGuard(hermetic.accountHome, { resolveOpenedFd: unavailableOpenedFd }),
  );
  assert.equal(decision.bytes.toString("utf8"), "hello fallback\n");
  assert.equal(decision.resolved_path, realpathSync(safe));
});

test("hermetic setup isolates XDG pairing trees from the passwd home", () => {
  const passwd = userInfo().homedir;
  assert.equal(process.env.XDG_CONFIG_HOME, hermetic.xdgConfigHome);
  assert.equal(process.env.XDG_DATA_HOME, hermetic.xdgDataHome);
  assert.equal(process.env.XDG_STATE_HOME, hermetic.xdgStateHome);
  assert.notEqual(process.env.XDG_CONFIG_HOME, join(passwd, ".config"));
});

test("hermetic deny list does not syscall the passwd home XDG pairing tree", async () => {
  const passwd = userInfo().homedir;
  const safe = await writeText(hermetic.base, "xdg-isolate.txt", "hello attachment\n");
  const env = {
    HOME: hermetic.accountHome,
    SAND_DATA_ROOT: hermetic.dataRoot,
    XDG_CONFIG_HOME: join(passwd, ".config"),
    XDG_DATA_HOME: join(passwd, ".local", "share"),
    XDG_STATE_HOME: join(passwd, ".local", "state"),
  };
  const decision = validateLocalAttachmentFile(
    safe,
    "note.txt",
    env,
    hermetic.accountHome,
    attachmentGuard(hermetic.accountHome),
  );
  assert.equal(decision.bytes.toString("utf8"), "hello attachment\n");
});

test("outbound denies default connector trees when XDG is redirected", async () => {
  const home = join(hermetic.base, "re1-home");
  const xdgConfig = join(hermetic.base, "re1-xdg-config");
  const xdgData = join(hermetic.base, "re1-xdg-data");
  const xdgState = join(hermetic.base, "re1-xdg-state");
  const staging = join(hermetic.base, "re1-staging");
  const paths = [
    join(home, ".config", "codex-grok-mcp", "bridge.json"),
    join(home, ".config", "codex-grok-mcp", "bridge.json.lifecycle.json"),
    join(home, ".config", "codex-grok-mcp", "other.json"),
    join(home, ".local", "share", "codex-grok-mcp", "companion", "state.json"),
    join(home, ".local", "share", "codex-grok-mcp", "other.json"),
    join(home, ".local", "state", "codex-grok-mcp", "replay", "r.json"),
    join(home, ".local", "state", "codex-grok-mcp", "attachments", "a.txt"),
    join(home, ".local", "state", "codex-grok-mcp", "other.json"),
    join(xdgConfig, "codex-grok-mcp", "bridge.json"),
    join(xdgConfig, "codex-grok-mcp", "other.json"),
    join(xdgData, "codex-grok-mcp", "companion", "state.json"),
    join(xdgData, "codex-grok-mcp", "other.json"),
    join(xdgState, "codex-grok-mcp", "replay", "r.json"),
    join(xdgState, "codex-grok-mcp", "attachments", "a.txt"),
    join(xdgState, "codex-grok-mcp", "other.json"),
    join(staging, "upload.txt"),
  ];
  for (const path of paths) {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, path.endsWith(".txt") ? "hello attachment\n" : '{"secret":true}\n', { mode: 0o600 });
  }
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    CODEX_GROK_ATTACHMENT_STAGING_ROOT: staging,
    SAND_DATA_ROOT: hermetic.dataRoot,
  };
  for (const path of paths) {
    assert.throws(
      () =>
        validateLocalAttachmentFile(path, path.endsWith(".txt") ? "note.txt" : "note.json", env, home, attachmentGuard(home)),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound denies credential paths that differ only by case on a case-insensitive filesystem", async (context) => {
  const probe = join(hermetic.base, "case-fs-probe");
  await mkdir(probe, { recursive: true, mode: 0o700 });
  await writeFile(join(probe, "a"), "x");
  let caseSensitive = false;
  try {
    caseSensitive = (await lstat(join(probe, "a"))).ino !== (await lstat(join(probe, "A"))).ino;
  } catch {
    caseSensitive = true;
  }
  if (caseSensitive) return context.skip("filesystem is case-sensitive");
  const home = join(hermetic.base, "case-home");
  await mkdir(join(home, ".grok"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".grok", "auth.json"), '{"token":"grok"}', { mode: 0o600 });
  await writeFile(join(home, ".ssh", "x"), "ssh-key\n", { mode: 0o600 });
  await writeFile(join(home, ".codex", "config.toml"), "model = \"x\"\n", { mode: 0o600 });
  const env = { HOME: home, SAND_DATA_ROOT: hermetic.dataRoot };
  const variants = [
    [join(home, ".GROK", "auth.json"), "auth.json"],
    [join(home, ".SSH", "x"), "key.txt"],
    [join(home, ".Codex", "config.toml"), "note.txt"],
  ];
  for (const [path, name] of variants) {
    assert.throws(
      () => validateLocalAttachmentFile(path, name, env, home, attachmentGuard(home)),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("empty AttachmentPathGuard homes or sandRoots is rejected", async () => {
  const safe = await writeText(hermetic.base, "empty-guard.txt", "hello attachment\n");
  const env = { HOME: hermetic.accountHome, SAND_DATA_ROOT: hermetic.dataRoot };
  assert.throws(
    () =>
      validateLocalAttachmentFile(safe, "note.txt", env, hermetic.accountHome, {
        homes: [],
        sandRoots: [hermetic.defaultSandRoot],
      }),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
  assert.throws(
    () =>
      validateLocalAttachmentFile(safe, "note.txt", env, hermetic.accountHome, {
        homes: [hermetic.accountHome],
        sandRoots: [],
      }),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
  assert.throws(
    () =>
      validateLocalAttachmentFile(safe, "note.txt", env, hermetic.accountHome, {
        homes: ["relative-home"],
        sandRoots: [hermetic.defaultSandRoot],
      }),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
  assert.throws(
    () =>
      validateLocalAttachmentFile(safe, "note.txt", env, hermetic.accountHome, {
        homes: [hermetic.accountHome],
        sandRoots: ["relative-sand"],
      }),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
});

test("production without a guard full-pins the default Sand and home trees", async () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const preload = fileURLToPath(new URL("./production-full-pin-preload.cjs", import.meta.url));
  const script = join(hermetic.base, "sh2-production-full-pin.mjs");
  await writeFile(
    script,
    `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GROK_BOT_DATA_ROOT,
  LEGACY_GROK_BOT_DATA_ROOT,
} from ${JSON.stringify(join(repo, "dist/grok-bot-client.js"))};
import { AttachmentError, validateLocalAttachmentFile } from ${JSON.stringify(join(repo, "dist/attachments.js"))};

const home = process.env.HOME;
const tmp = process.env.TMPDIR;
const env = { HOME: home, SAND_DATA_ROOT: process.env.SAND_DATA_ROOT };
const grokDir = join(home, ".grok");
mkdirSync(grokDir, { recursive: true, mode: 0o700 });
const auth = join(grokDir, "auth.json");
writeFileSync(auth, '{"token":"x"}\\n', { mode: 0o600 });
const authStat = lstatSync(auth);
const grokStat = lstatSync(grokDir);
const sandIds = globalThis.CODEX_GROK_FULL_PIN_SAND_IDS;
assert.equal(typeof sandIds?.gateway?.dev, "number");
assert.equal(typeof sandIds?.config?.dev, "number");

const decoyAuth = join(tmp, "bound-auth.txt");
const decoyGateway = join(tmp, "bound-gateway.txt");
const decoyGrokDir = join(tmp, "bound-grok-dir");
const decoyGrokFile = join(decoyGrokDir, "note.txt");
const decoySandDir = join(tmp, "bound-sand-dir");
const decoySandFile = join(decoySandDir, "note.txt");
const ok = join(tmp, "sh2-ok.txt");
writeFileSync(decoyAuth, "hello attachment\\n");
writeFileSync(decoyGateway, "hello attachment\\n");
mkdirSync(decoyGrokDir, { recursive: true, mode: 0o700 });
mkdirSync(decoySandDir, { recursive: true, mode: 0o700 });
writeFileSync(decoyGrokFile, "hello attachment\\n");
writeFileSync(decoySandFile, "hello attachment\\n");
writeFileSync(ok, "hello attachment\\n");
const decoyAuthStat = lstatSync(decoyAuth);
const decoyGatewayStat = lstatSync(decoyGateway);
const decoyGrokDirStat = lstatSync(decoyGrokDir);
const decoySandDirStat = lstatSync(decoySandDir);

globalThis.CODEX_GROK_FULL_PIN_OVERLAYS = [
  { from: decoyAuthStat, to: { dev: authStat.dev, ino: authStat.ino, file: true } },
  { from: decoyGatewayStat, to: { dev: sandIds.gateway.dev, ino: sandIds.gateway.ino, file: true } },
  { from: decoyGrokDirStat, to: { dev: grokStat.dev, ino: grokStat.ino, file: false } },
  { from: decoySandDirStat, to: { dev: sandIds.config.dev, ino: sandIds.config.ino, file: false } },
];

validateLocalAttachmentFile(ok, "ok.txt", env, home);
const pinned = globalThis.CODEX_GROK_FULL_PIN_CALLS ?? [];
const needed = [
  join(DEFAULT_GROK_BOT_DATA_ROOT, "gateway.json"),
  join(DEFAULT_GROK_BOT_DATA_ROOT, "config"),
  join(LEGACY_GROK_BOT_DATA_ROOT, "gateway.json"),
  join(LEGACY_GROK_BOT_DATA_ROOT, "config"),
  join(home, ".grok"),
];
for (const path of needed) {
  assert.equal(
    pinned.some((entry) => entry.includes(path)),
    true,
    \`missing full-pin of \${path} in \${JSON.stringify(pinned)}\`,
  );
}

const denied = [
  [decoyAuth, "auth.txt"],
  [decoyGateway, "gateway.txt"],
  [decoyGrokFile, "note.txt"],
  [decoySandFile, "note.txt"],
];
for (const [path, name] of denied) {
  assert.throws(
    () => validateLocalAttachmentFile(path, name, env, home),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    \`expected identity deny for \${path}\`,
  );
}

const codexTarget = join(tmp, "codex-target");
mkdirSync(codexTarget, { recursive: true, mode: 0o700 });
const linkedAuth = join(codexTarget, "auth.json");
writeFileSync(linkedAuth, '{"token":"codex"}\\n', { mode: 0o600 });
symlinkSync(codexTarget, join(home, ".codex"));
assert.throws(
  () => validateLocalAttachmentFile(linkedAuth, "auth.json", env, home),
  (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
);
`,
  );
  for (const hermeticFlag of ["0", "1"]) {
    const pinHome = join(hermetic.base, `pin-home-${hermeticFlag}`);
    await mkdir(pinHome, { recursive: true, mode: 0o700 });
    const env = { ...process.env, HOME: pinHome };
    delete env.NODE_OPTIONS;
    if (hermeticFlag === "1") env.CODEX_GROK_TEST_HERMETIC = "1";
    else delete env.CODEX_GROK_TEST_HERMETIC;
    const traced = spawnSync(process.execPath, ["--require", preload, script], {
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    assert.equal(traced.status, 0, `hermetic=${hermeticFlag}\n${traced.stdout}\n${traced.stderr}`);
  }
});

test("outbound without sandRoots still denies the fixed default and legacy roots", () => {
  const home = join(hermetic.base, "fallback-home");
  const env = { HOME: home, SAND_DATA_ROOT: hermetic.dataRoot };
  const fakeStats = { dev: 1, ino: 99, isFile: () => true, isDirectory: () => false };
  const guard = { homes: [home] };
  for (const path of [
    join(DEFAULT_GROK_BOT_DATA_ROOT, "gateway.json"),
    join(DEFAULT_GROK_BOT_DATA_ROOT, "config", "c.json"),
    join(LEGACY_GROK_BOT_DATA_ROOT, "gateway.json"),
    join(LEGACY_GROK_BOT_DATA_ROOT, "config", "c.json"),
  ]) {
    assert.throws(
      () => assertNotSensitiveAttachmentSource(path, fakeStats, env, home, guard),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound still denies default and legacy sand roots when SAND_DATA_ROOT is redirected", async () => {
  const home = join(hermetic.base, "g1-home");
  const redirected = join(hermetic.base, "g1-sand");
  const defaultRoot = join(hermetic.base, "g1-default-sand");
  const legacyRoot = join(hermetic.base, "g1-legacy-sand");
  for (const root of [redirected, defaultRoot, legacyRoot]) {
    await mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "gateway.json"), '{"port":1}\n', { mode: 0o600 });
    await writeFile(join(root, "config", "c.json"), '{"x":1}\n', { mode: 0o600 });
  }
  const env = { HOME: home, SAND_DATA_ROOT: redirected };
  const guard = attachmentGuard(home, { sandRoots: [defaultRoot, legacyRoot] });
  for (const path of [
    join(redirected, "gateway.json"),
    join(redirected, "config", "c.json"),
    join(defaultRoot, "gateway.json"),
    join(defaultRoot, "config", "c.json"),
    join(legacyRoot, "gateway.json"),
    join(legacyRoot, "config", "c.json"),
  ]) {
    assert.throws(
      () =>
        validateLocalAttachmentFile(
          path,
          path.endsWith(".json") ? "note.json" : "note.txt",
          env,
          home,
          guard,
        ),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound denies every Sand candidate when SAND_DATA_ROOT and SAND_USER_DATA_DIR are both set", async () => {
  const home = join(hermetic.base, "g1d-home");
  const dataRoot = join(hermetic.base, "g1d-sand-data-root");
  const userRoot = join(hermetic.base, "g1d-user-data");
  const userSand = join(userRoot, "sand-data");
  const userAgent = join(userRoot, "agent-data");
  const defaultRoot = join(hermetic.base, "g1d-default-sand");
  const legacyRoot = join(hermetic.base, "g1d-legacy-sand");
  for (const root of [dataRoot, userSand, userAgent, defaultRoot, legacyRoot]) {
    await mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "gateway.json"), '{"port":1}\n', { mode: 0o600 });
    await writeFile(join(root, "config", "c.json"), '{"x":1}\n', { mode: 0o600 });
  }
  const env = {
    HOME: home,
    SAND_DATA_ROOT: dataRoot,
    SAND_USER_DATA_DIR: userRoot,
  };
  const guard = attachmentGuard(home, { sandRoots: [defaultRoot, legacyRoot] });
  for (const path of [
    join(dataRoot, "gateway.json"),
    join(dataRoot, "config", "c.json"),
    join(userSand, "gateway.json"),
    join(userSand, "config", "c.json"),
    join(userAgent, "gateway.json"),
    join(userAgent, "config", "c.json"),
    join(defaultRoot, "gateway.json"),
    join(defaultRoot, "config", "c.json"),
    join(legacyRoot, "gateway.json"),
    join(legacyRoot, "config", "c.json"),
  ]) {
    assert.throws(
      () =>
        validateLocalAttachmentFile(
          path,
          path.endsWith(".json") ? "note.json" : "note.txt",
          env,
          home,
          guard,
        ),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
  const fakeStats = { dev: 1, ino: 99, isFile: () => true, isDirectory: () => false };
  for (const path of [
    join(DEFAULT_GROK_BOT_DATA_ROOT, "gateway.json"),
    join(DEFAULT_GROK_BOT_DATA_ROOT, "config", "c.json"),
    join(LEGACY_GROK_BOT_DATA_ROOT, "gateway.json"),
    join(LEGACY_GROK_BOT_DATA_ROOT, "config", "c.json"),
  ]) {
    assert.throws(
      () => assertNotSensitiveAttachmentSource(path, fakeStats, env, home, guard),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound denies redirected CODEX_HOME and GROK_HOME wholesale", async () => {
  const home = join(hermetic.base, "re2-home");
  const codexHome = join(hermetic.base, "re2-codex-home");
  const grokHome = join(hermetic.base, "re2-grok-home");
  const paths = [
    join(home, ".codex", "auth.json"),
    join(home, ".grok", "auth.json"),
    join(codexHome, "auth.json"),
    join(codexHome, "config.toml"),
    join(grokHome, "auth.json"),
    join(grokHome, "other.json"),
  ];
  for (const path of paths) {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, path.endsWith(".toml") ? "model = \"x\"\n" : '{"secret":true}\n', {
      mode: 0o600,
    });
  }
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    SAND_DATA_ROOT: hermetic.dataRoot,
  };
  for (const path of paths) {
    assert.throws(
      () =>
        validateLocalAttachmentFile(
          path,
          path.endsWith(".toml") ? "note.txt" : "note.json",
          env,
          home,
          attachmentGuard(home),
        ),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  }
});

test("outbound denies a directory whose inode matches a credential tree", async () => {
  const home = join(hermetic.base, "rb1-home");
  const ssh = join(home, ".ssh");
  await mkdir(ssh, { recursive: true, mode: 0o700 });
  const key = join(ssh, "id_ed25519");
  await writeFile(key, "ssh-key\n", { mode: 0o600 });
  const aliasPath = join(hermetic.base, "rb1-lexical-alias", "id_ed25519");
  const fd = openSync(key, fsConstants.O_RDONLY);
  try {
    const stats = fstatSync(fd);
    assert.throws(
      () =>
        assertNotSensitiveAttachmentSource(
          aliasPath,
          stats,
          { HOME: home, SAND_DATA_ROOT: hermetic.dataRoot },
          home,
          attachmentGuard(home),
          { fd, resolveOpenedFd: () => key },
        ),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  } finally {
    closeSync(fd);
  }
});

// Ancestor-dev/ino only: a whole denied directory bind-mounted elsewhere.
// Subdirectory binds and same-user rename races are documented residuals.
test("outbound ancestor-dev-ino check denies a bind-mounted credential directory", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  const home = join(hermetic.base, "rb1-bind-home");
  const ssh = join(home, ".ssh");
  await mkdir(ssh, { recursive: true, mode: 0o700 });
  await writeFile(join(ssh, "id_ed25519"), "ssh-key\n", { mode: 0o600 });
  const aliasDir = join(hermetic.base, "rb1-bind-alias");
  await mkdir(aliasDir, { recursive: true, mode: 0o700 });
  const mounted = spawnSync("mount", ["--bind", ssh, aliasDir], { encoding: "utf8" });
  if (mounted.status !== 0) return context.skip("bind mount requires privileges");
  context.after(() => {
    spawnSync("umount", [aliasDir], { encoding: "utf8" });
  });
  const aliasKey = join(aliasDir, "id_ed25519");
  assert.throws(
    () =>
      validateLocalAttachmentFile(
        aliasKey,
        "key.txt",
        { HOME: home, SAND_DATA_ROOT: hermetic.dataRoot },
        home,
        attachmentGuard(home),
      ),
    (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
  );
});

test("outbound folds macOS paths with NFC before deny comparison", async () => {
  const homeNfc = join(hermetic.base, "nfc-caf\u00e9");
  const grok = join(homeNfc, ".grok");
  await mkdir(grok, { recursive: true, mode: 0o700 });
  const auth = join(grok, "auth.json");
  await writeFile(auth, '{"token":"grok"}', { mode: 0o600 });
  const homeNfd = homeNfc.normalize("NFD");
  assert.notEqual(homeNfc, homeNfd);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try {
    assert.throws(
      () =>
        validateLocalAttachmentFile(
          auth,
          "auth.json",
          { HOME: homeNfd, SAND_DATA_ROOT: hermetic.dataRoot },
          homeNfd,
          attachmentGuard(homeNfd),
        ),
      (caught) => caught instanceof AttachmentError && caught.code === "ATTACHMENT_REJECTED",
    );
  } finally {
    if (descriptor === undefined) delete process.platform;
    else Object.defineProperty(process, "platform", descriptor);
  }
});

test("hermetic attachment deny and data-root guard do not syscall real Sand roots", async () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const script = join(hermetic.base, "sh1-no-real-root.mjs");
  await writeFile(
    script,
    `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GROK_BOT_DATA_ROOT,
  TestRealDataRootError,
  grokBotDataRoot,
} from ${JSON.stringify(join(repo, "dist/grok-bot-client.js"))};
import { validateLocalAttachmentFile } from ${JSON.stringify(join(repo, "dist/attachments.js"))};
grokBotDataRoot();
try {
  grokBotDataRoot({ SAND_DATA_ROOT: DEFAULT_GROK_BOT_DATA_ROOT });
  throw new Error("expected TestRealDataRootError");
} catch (caught) {
  if (!(caught instanceof TestRealDataRootError)) throw caught;
}
const home = process.env.HOME;
const sand = process.env.SAND_DATA_ROOT;
const defaultRoot = join(process.env.TMPDIR, "sh1-default-sand");
const legacyRoot = join(process.env.TMPDIR, "sh1-legacy-sand");
mkdirSync(defaultRoot, { recursive: true, mode: 0o700 });
mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
const file = join(process.env.TMPDIR, "sh1-ok.txt");
writeFileSync(file, "hello attachment\\n");
validateLocalAttachmentFile(file, "ok.txt", { HOME: home, SAND_DATA_ROOT: sand }, home, {
  homes: [home],
  sandRoots: [defaultRoot, legacyRoot],
});
`,
  );
  const spy = fileURLToPath(new URL("./real-root-fs-spy.cjs", import.meta.url));
  const env = { ...process.env };
  const alreadyLoaded = (env.NODE_OPTIONS ?? "").includes("real-root-fs-spy");
  const traced = spawnSync(process.execPath, alreadyLoaded ? [script] : ["--require", spy, script], {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  assert.equal(traced.status, 0, traced.stderr);
  assert.equal(traced.stderr.includes("REAL_ROOT_SYSCALLS"), false, traced.stderr);
});

test("tool fetch rejects an oversize companion total_size on the first window", async () => {
  let fetches = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async fetchAttachment() {
      fetches += 1;
      return {
        bytes_b64: PNG.toString("base64"),
        total_size: ATTACHMENT_IMAGE_MAX_BYTES + 1,
        sha256: "a".repeat(64),
        mime: "image/png",
        name: "huge.png",
        truncated: true,
      };
    },
  };
  const mcp = await openAttachmentMcp(transport);
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_fetch_bot_attachment",
      arguments: { bot_id: BOT, entry_id: "huge-1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ATTACHMENT_TOO_LARGE/);
    assert.equal(fetches, 1);
  } finally {
    await mcp.close();
  }
});

test("tool fetch rejects windows that disagree", async () => {
  const body = Buffer.concat([PNG, Buffer.alloc(70_000, 0x41)]);
  let fetches = 0;
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async fetchAttachment({ offset, length }) {
      fetches += 1;
      const window = body.subarray(offset, offset + length);
      return {
        bytes_b64: window.toString("base64"),
        total_size: offset === 0 ? body.length : body.length + 1,
        sha256: sha256(body),
        mime: "image/png",
        name: "shot.png",
        truncated: offset + window.length < body.length,
      };
    },
  };
  const mcp = await openAttachmentMcp(transport);
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_fetch_bot_attachment",
      arguments: { bot_id: BOT, entry_id: "disagree-1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ATTACHMENT_INTEGRITY/);
    assert.equal(fetches >= 2, true);
  } finally {
    await mcp.close();
  }
});

test("tool fetch rejects a reassembled hash mismatch", async () => {
  const body = Buffer.concat([PNG, Buffer.alloc(70_000, 0x41)]);
  const other = Buffer.concat([PNG, Buffer.alloc(70_000, 0x42)]);
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async fetchAttachment({ offset, length }) {
      const window = body.subarray(offset, offset + length);
      return {
        bytes_b64: window.toString("base64"),
        total_size: body.length,
        sha256: sha256(other),
        mime: "image/png",
        name: "shot.png",
        truncated: offset + window.length < body.length,
      };
    },
  };
  const mcp = await openAttachmentMcp(transport);
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_fetch_bot_attachment",
      arguments: { bot_id: BOT, entry_id: "hash-1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ATTACHMENT_INTEGRITY/);
  } finally {
    await mcp.close();
  }
});

test("tool send surfaces failed_stage=staged", async (context) => {
  const root = await fixtureDir(context, "att-stage-fail");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      throw new GrokBotGatewayError("UNAVAILABLE", "stage failed");
    },
    async commitAttachment() {
      throw new Error("should not commit");
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, { approve: true });
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed_stage=staged/);
  } finally {
    await mcp.close();
  }
});

test("tool send surfaces failed_stage=committed", async (context) => {
  const root = await fixtureDir(context, "att-commit-fail");
  const path = await writeText(root, "note.txt", "hello attachment\n");
  const transport = {
    async listBots() {
      return [{ id: BOT, name: "Ada", is_running: true }];
    },
    async readBot() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async stageAttachment() {
      return { received: 18, total_size: 18, complete: true };
    },
    async commitAttachment() {
      throw new GrokBotGatewayError("ATTACHMENT_INTEGRITY", "commit failed", {
        commitMayHaveOccurred: true,
      });
    },
  };
  const previewServer = await openAttachmentMcp(transport);
  const preview = await previewServer.request("tools/call", {
    name: "grok_send_bot_attachment",
    arguments: { bot_id: BOT, path },
  });
  await previewServer.close();
  const mcp = await openAttachmentMcp(transport, { approve: true });
  try {
    const result = await mcp.request("tools/call", {
      name: "grok_send_bot_attachment",
      arguments: {
        bot_id: BOT,
        path,
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        confirmation: "SEND_ATTACHMENT",
        path_identity: preview.structuredContent.path_identity,
        sha256: preview.structuredContent.sha256,
        preview_token: preview.structuredContent.preview_token,
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed_stage=committed/);
    assert.match(result.content[0].text, /commit_may_have_occurred/);
  } finally {
    await mcp.close();
  }
});

