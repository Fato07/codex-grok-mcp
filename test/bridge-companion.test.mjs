import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import {
  handleBridgeRequest,
  runBridge,
  runBridgeCompanion,
} from "../dist/bridge-companion.js";
import {
  decryptFrame,
  encryptFrame,
  generatePairCode,
  parsePairCode,
} from "../dist/bridge-pairing.js";
import { PersistentReplayGuard } from "../dist/bridge-replay.js";

test("probe emits only allowlisted metadata and sanitizes failures", async () => {
  const botId = "00000000-0000-4000-8000-0000000000a1";
  const groupId = "00000000-0000-4000-8000-0000000000ff";
  const secretValues = [
    "gateway-test-token",
    "Ada",
    "Group room",
    botId,
    groupId,
    "/home/box/sand-data/gateway.json",
    "http://127.0.0.1:1340",
    "private transcript",
    "private prompt",
  ];
  const client = {
    discovery: () => ({
      port: 1340,
      pid: 2468,
      hasToken: true,
      token: secretValues[0],
      baseUrl: secretValues[6],
      path: secretValues[5],
    }),
    health: async () => ({ ok: true, isBusy: false, activeAgentId: botId }),
    listAgents: async () => [
      {
        id: botId,
        name: secretValues[1],
        isGroup: false,
        path: secretValues[5],
        transcript: secretValues[7],
        prompt: secretValues[8],
      },
      { id: groupId, name: secretValues[2], isGroup: true },
    ],
  };

  let stdout = "";
  let stderr = "";
  let exitCode = await runBridgeCompanion(["probe"], {
    createClient: () => client,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });
  const result = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(result, {
    gateway: { port: 1340, pid: 2468, hasToken: true },
    health: { ok: true, busy: false },
    bot_count: 1,
    roster_fingerprint: `sha256:${createHash("sha256")
      .update(JSON.stringify([botId]))
      .digest("hex")}`,
  });
  for (const secret of secretValues) assert(!stdout.includes(secret));

  stdout = "";
  stderr = "";
  const failure = `failed with ${secretValues.join(" ")}`;
  exitCode = await runBridgeCompanion(["probe"], {
    createClient: () => ({
      ...client,
      listAgents: async () => {
        throw new Error(failure);
      },
    }),
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, '{"error":"probe_failed"}\n');
  assert(!stderr.includes(failure));
  for (const secret of secretValues) assert(!stderr.includes(secret));
});

test("companion replays the authenticated receipt without sending twice", async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(
    generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
  );
  const controller = new AbortController();
  const sends = [];
  const client = {
    discovery: () => ({ port: 1340, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => [
      { id: "bot-1", name: "Ada", isGroup: false, isRunning: true },
    ],
    sendPrompt: async (input) => {
      sends.push(input);
      return { accepted: true };
    },
  };
  const bridge = runBridge(config, client, controller.signal, replayRoot);

  try {
    const [socket] = await once(relay, "connection");
    const request = {
      v: 1,
      id: randomUUID(),
      issued_at_ms: Date.now(),
      op: "send_message",
      args: { bot_id: "bot-1", message: "send once" },
    };
    const frame = encryptFrame(config, "codex", JSON.stringify(request));

    let response = once(socket, "message");
    socket.send(frame);
    const [first] = await response;
    assert.equal(
      JSON.parse(decryptFrame(config, "bridge", first.toString()).toString("utf8")).ok,
      true,
    );

    response = once(socket, "message");
    socket.send(frame);
    const [replayed] = await response;
    const replayResult = JSON.parse(
      decryptFrame(config, "bridge", replayed.toString()).toString("utf8"),
    );
    assert.equal(replayResult.ok, true);
    assert.equal(replayResult.result.request_id, request.id);
    assert.equal(sends.length, 1);
  } finally {
    controller.abort();
    await bridge;
    await new Promise((resolve, reject) => {
      relay.close((caught) => (caught ? reject(caught) : resolve()));
    });
    await rm(replayRoot, { recursive: true, force: true });
  }
});

test("an in-flight gateway send blocks a second send after relay reconnect", async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(
    generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
  );
  const controller = new AbortController();
  let releaseSend;
  let sendStarted;
  const started = new Promise((resolve) => (sendStarted = resolve));
  const sends = [];
  const client = {
    discovery: () => ({ port: 1340, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => [
      { id: "bot-1", name: "Ada", isGroup: false, isRunning: true },
    ],
    sendPrompt: async (input) => {
      sends.push(input);
      sendStarted();
      return await new Promise((resolve) => (releaseSend = resolve));
    },
  };
  const bridge = runBridge(config, client, controller.signal, replayRoot);

  try {
    const [first] = await once(relay, "connection");
    first.send(
      encryptFrame(
        config,
        "codex",
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          issued_at_ms: Date.now(),
          op: "send_message",
          args: { bot_id: "bot-1", message: "first" },
        }),
      ),
    );
    await started;

    const reconnected = once(relay, "connection");
    first.terminate();
    const [second] = await reconnected;
    const response = once(second, "message");
    second.send(
      encryptFrame(
        config,
        "codex",
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          issued_at_ms: Date.now(),
          op: "send_message",
          args: { bot_id: "bot-1", message: "second" },
        }),
      ),
    );
    const [data] = await response;
    const result = JSON.parse(
      decryptFrame(config, "bridge", data.toString()).toString("utf8"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNAVAILABLE");
    assert.equal(result.error.delivery_may_have_occurred, false);
    assert.equal(sends.length, 1);
  } finally {
    releaseSend?.({ accepted: true });
    controller.abort();
    await bridge;
    await new Promise((resolve, reject) => {
      relay.close((caught) => (caught ? reject(caught) : resolve()));
    });
    await rm(replayRoot, { recursive: true, force: true });
  }
});

test("persistent replay state blocks a captured send after companion restart", async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(
    generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
  );
  const sends = [];
  const client = {
    discovery: () => ({ port: 1340, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => [
      { id: "bot-1", name: "Ada", isGroup: false, isRunning: true },
    ],
    sendPrompt: async (input) => {
      sends.push(input);
      return { accepted: true };
    },
  };
  const request = {
    v: 1,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "send_message",
    args: { bot_id: "bot-1", message: "send once across restarts" },
  };
  const frame = encryptFrame(config, "codex", JSON.stringify(request));

  const firstController = new AbortController();
  const firstRun = runBridge(config, client, firstController.signal, replayRoot);
  const [firstSocket] = await once(relay, "connection");
  let response = once(firstSocket, "message");
  firstSocket.send(frame);
  await response;
  firstController.abort();
  await firstRun;

  const secondController = new AbortController();
  const secondRun = runBridge(config, client, secondController.signal, replayRoot);
  try {
    const [secondSocket] = await once(relay, "connection");
    response = once(secondSocket, "message");
    secondSocket.send(frame);
    const [data] = await response;
    const result = JSON.parse(
      decryptFrame(config, "bridge", data.toString()).toString("utf8"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_RESPONSE");
    assert.equal(result.error.delivery_may_have_occurred, true);
    assert.equal(sends.length, 1);
  } finally {
    secondController.abort();
    await secondRun;
    await new Promise((resolve, reject) => {
      relay.close((caught) => (caught ? reject(caught) : resolve()));
    });
    await rm(replayRoot, { recursive: true, force: true });
  }
});

test("replay claims are atomic across independently opened companion guards", async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  try {
    const channel = parsePairCode(
      generatePairCode("wss://relay.example.test/v1/connect"),
    ).channel;
    const [first, second] = await Promise.all([
      PersistentReplayGuard.open(channel, 60_000, replayRoot),
      PersistentReplayGuard.open(channel, 60_000, replayRoot),
    ]);
    const id = randomUUID();
    const outcomes = await Promise.all([
      first.claim(id, Date.now()),
      second.claim(id, Date.now()),
    ]);
    assert.deepEqual(outcomes.sort(), ["claimed", "replay"]);
    await chmod(join(replayRoot, `channel-${channel}`, id), 0o644);
    await assert.rejects(first.claim(randomUUID(), Date.now()), {
      message: "replay_guard_failed",
    });
  } finally {
    await rm(replayRoot, { recursive: true, force: true });
  }
});

test("companion pairs without echoing the code and validates exact Bot IDs before a send", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-companion-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  const pairCode = generatePairCode("wss://relay.example.test/v1/connect");
  const bot = { id: "bot-1", name: "Ada", isGroup: false, isRunning: true };
  const sends = [];
  const client = {
    discovery: () => ({ port: 1340, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => [bot, { id: "group-1", name: "Room", isGroup: true, isRunning: false }],
    sendPrompt: async (input) => {
      sends.push(input);
      return { accepted: true };
    },
  };
  let stdout = "";
  let stderr = "";

  const paired = await runBridgeCompanion(["connect"], {
    configPath,
    createClient: () => client,
    readPairCode: async () => pairCode,
    runBridge: async () => undefined,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });
  assert.equal(paired, 0);
  assert.equal(stderr, "");
  assert.equal(stdout, '{"paired":true,"mode":"foreground"}\n');
  assert(!stdout.includes(pairCode));

  const requestId = randomUUID();
  const listed = await handleBridgeRequest(client, {
    v: 1,
    id: requestId,
    issued_at_ms: Date.now(),
    op: "list_bots",
    args: {},
  });
  assert.deepEqual(listed.result.bots, [
    { id: bot.id, name: bot.name, is_running: true },
  ]);

  const missing = await handleBridgeRequest(client, {
    v: 1,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "send_message",
    args: { bot_id: "missing", message: "hello" },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "BOT_NOT_FOUND");
  assert.equal(sends.length, 0);

  const sent = await handleBridgeRequest(client, {
    v: 1,
    id: requestId,
    issued_at_ms: Date.now(),
    op: "send_message",
    args: { bot_id: bot.id, message: "hello" },
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.result.accepted, true);
  assert.deepEqual(sends, [
    { agentId: bot.id, prompt: "hello", clientNonce: requestId },
  ]);
});
