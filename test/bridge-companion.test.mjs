import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  savePairingConfig,
} from "../dist/bridge-pairing.js";
import { PersistentReplayGuard } from "../dist/bridge-replay.js";
import { CODEX_GROK_VERSION } from "../dist/version.js";
import {
  LocalGatewayError,
  LocalGrokBotClient,
} from "../dist/grok-bot-client.js";

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

  stderr = "";
  exitCode = await runBridgeCompanion(["probe"], {
    createClient: () => {
      throw new LocalGatewayError("CONFIG_INVALID", 0, secretValues[0]);
    },
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, '{"error":"CONFIG_INVALID"}\n');
  for (const secret of secretValues) assert(!stderr.includes(secret));
});

test("probe names a symlinked SAND_DATA_ROOT without leaking paths", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-symlink-root-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const realRoot = join(sandbox, "real-data");
  const symlinkRoot = join(sandbox, "agent-data");
  await mkdir(realRoot);
  await writeFile(
    join(realRoot, "gateway.json"),
    JSON.stringify({
      port: 1340,
      pid: 2468,
      startedAt: Date.now(),
      host: "127.0.0.1",
      token: "gateway-test-token",
    }),
    { mode: 0o600 },
  );
  await symlink(realRoot, symlinkRoot, "dir");

  let stdout = "";
  let stderr = "";
  const exitCode = await runBridgeCompanion(["probe"], {
    createClient: () =>
      new LocalGrokBotClient({
        env: { SAND_DATA_ROOT: symlinkRoot },
        verifyServer: () => true,
      }),
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, '{"error":"CONFIG_INVALID","reason":"DATA_ROOT_SYMLINK"}\n');
  assert(!stderr.includes(sandbox));
});

test("companion routes the bounded lifecycle surface without touching pairing", async () => {
  const commands = [
    "install",
    "start",
    "status",
    "stop",
    "restart",
    "update",
    "rollback",
    "ensure",
  ];
  const calls = [];
  for (const command of commands) {
    let stdout = "";
    let stderr = "";
    const exitCode = await runBridgeCompanion([command], {
      lifecycle: {
        run: async (received) => {
          calls.push(received);
          return {
            command: received,
            state: "running",
            changed: received !== "status",
            active_version: "0.2.0-beta.5",
            previous_version: null,
            protocol_versions: [1, 2, 3],
            pairing_valid: true,
          };
        },
      },
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      command,
      state: "running",
      changed: command !== "status",
      active_version: "0.2.0-beta.5",
      previous_version: null,
      protocol_versions: [1, 2, 3],
      pairing_valid: true,
    });
  }
  assert.deepEqual(calls, commands);

  let stderr = "";
  assert.equal(
    await runBridgeCompanion(["update", "beta"], {
      stderr: { write: (chunk) => (stderr += chunk) },
    }),
    2,
  );
  assert.equal(stderr, '{"error":"unsupported_command"}\n');
});

test("managed candidate preflight returns versions only", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-managed-preflight-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config", "bridge.json");
  await savePairingConfig(
    parsePairCode(generatePairCode("wss://relay.example.test/v1/connect")),
    configPath,
  );
  let stdout = "";
  let stderr = "";
  const exitCode = await runBridgeCompanion(["_managed-preflight"], {
    environment: { CODEX_GROK_MANAGED_CONFIG_PATH: configPath },
    createClient: () => ({
      discovery: () => ({ port: 1340, pid: 1234, hasToken: true }),
      health: async () => ({ ok: true, isBusy: false }),
      listAgents: async () => [
        { id: "private-bot-id", name: "Private Bot", isGroup: false },
      ],
    }),
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    version: CODEX_GROK_VERSION,
    protocol_versions: [1, 2, 3],
  });
  assert(!stdout.includes("private-bot-id"));
  assert(!stdout.includes("Private Bot"));
  assert(!stdout.includes(configPath));
});

test("status handshake returns only allowlisted companion and gateway metadata", async () => {
  const secrets = [
    "bot-secret-id",
    "Ada Secret",
    "gateway-secret-token",
    "https://private.example.test",
    "/home/box/private.json",
    "private transcript",
    "private prompt",
  ];
  const result = await handleBridgeRequest(
    {
      discovery: () => ({
        port: 1340,
        pid: 2468,
        hasToken: true,
        token: secrets[2],
        baseUrl: secrets[3],
        path: secrets[4],
      }),
      health: async () => ({ ok: true, isBusy: true, activeAgentId: secrets[0] }),
      listAgents: async () => [
        {
          id: secrets[0],
          name: secrets[1],
          isGroup: false,
          transcript: secrets[5],
          prompt: secrets[6],
        },
        { id: "group-secret-id", name: "Private group", isGroup: true },
      ],
    },
    {
      v: 3,
      id: randomUUID(),
      issued_at_ms: Date.now(),
      op: "status",
      args: {},
    },
  );

  assert.deepEqual(result.result, {
    companion_version: CODEX_GROK_VERSION,
    supported_protocol_versions: [1, 2, 3],
    capabilities: ["status", "list_bots", "read_bot", "send_message"],
    gateway_healthy: true,
    gateway_busy: true,
    non_group_bot_count: 1,
  });
  const serialized = JSON.stringify(result);
  for (const secret of secrets) assert(!serialized.includes(secret));
  assert(!serialized.includes("group-secret-id"));
  assert(!serialized.includes("Private group"));
});

test("companion distinguishes wrong pairing keys from invalid frames and requests", async () => {
  const replayRoot = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object");
  const relayUrl = `ws://127.0.0.1:${address.port}/v1/connect`;
  const config = parsePairCode(generatePairCode(relayUrl));
  const wrongConfig = {
    ...config,
    key: parsePairCode(generatePairCode(relayUrl)).key,
  };

  const rejection = async (frame) => {
    const controller = new AbortController();
    const connected = once(relay, "connection");
    const bridge = runBridge(config, {}, controller.signal, replayRoot);
    try {
      const [socket] = await connected;
      const closed = once(socket, "close");
      socket.send(frame);
      return await closed;
    } finally {
      controller.abort();
      await bridge;
    }
  };

  try {
    const [wrongKeyCode, wrongKeyReason] = await rejection(
      encryptFrame(wrongConfig, "codex", "{}"),
    );
    assert.equal(wrongKeyCode, 4401);
    assert.equal(wrongKeyReason.toString(), "authentication failed");
    assert(!wrongKeyReason.toString().includes(config.key));
    assert(!wrongKeyReason.toString().includes(wrongConfig.key));

    const [invalidFrameCode, invalidFrameReason] = await rejection("AA");
    assert.equal(invalidFrameCode, 4400);
    assert.equal(invalidFrameReason.toString(), "invalid frame");

    const [invalidRequestCode, invalidRequestReason] = await rejection(
      encryptFrame(config, "codex", "{}"),
    );
    assert.equal(invalidRequestCode, 4400);
    assert.equal(invalidRequestReason.toString(), "invalid frame");
  } finally {
    await new Promise((resolve, reject) => {
      relay.close((caught) => (caught ? reject(caught) : resolve()));
    });
    await rm(replayRoot, { recursive: true, force: true });
  }
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

test("an in-flight gateway send blocks reconnect and drains on shutdown", async () => {
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

    controller.abort();
    const shutdownState = await Promise.race([
      bridge.then(() => "returned"),
      new Promise((resolve) => setImmediate(() => resolve("draining"))),
    ]);
    assert.equal(shutdownState, "draining");
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

test("positive-clock-skew replay stays blocked in-process and after restart", async () => {
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
    issued_at_ms: Date.now() + 59_000,
    op: "send_message",
    args: { bot_id: "bot-1", message: "send once across restarts" },
  };
  const frame = encryptFrame(config, "codex", JSON.stringify(request));
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;

  const firstController = new AbortController();
  const firstRun = runBridge(config, client, firstController.signal, replayRoot);
  let sameProcessResult;
  let sameProcessSendCount;
  let restartResult;
  let secondController;
  let secondRun;
  try {
    const [firstSocket] = await once(relay, "connection");
    let response = once(firstSocket, "message");
    firstSocket.send(frame);
    await response;
    now += 61_000;
    response = once(firstSocket, "message");
    firstSocket.send(frame);
    const [sameProcessData] = await response;
    sameProcessResult = JSON.parse(
      decryptFrame(config, "bridge", sameProcessData.toString()).toString("utf8"),
    );
    sameProcessSendCount = sends.length;
    firstController.abort();
    await firstRun;

    secondController = new AbortController();
    secondRun = runBridge(config, client, secondController.signal, replayRoot);
    const [secondSocket] = await once(relay, "connection");
    response = once(secondSocket, "message");
    secondSocket.send(frame);
    const [data] = await response;
    restartResult = JSON.parse(
      decryptFrame(config, "bridge", data.toString()).toString("utf8"),
    );
  } finally {
    firstController.abort();
    secondController?.abort();
    await firstRun;
    await secondRun;
    Date.now = realNow;
    await new Promise((resolve, reject) => {
      relay.close((caught) => (caught ? reject(caught) : resolve()));
    });
    await rm(replayRoot, { recursive: true, force: true });
  }
  assert.equal(sameProcessResult.ok, true);
  assert.equal(sameProcessSendCount, 1);
  assert.equal(restartResult.ok, false);
  assert.equal(restartResult.error.code, "INVALID_RESPONSE");
  assert.equal(restartResult.error.delivery_may_have_occurred, true);
  assert.equal(sends.length, 1);
});

test("companion marks every post-send gateway status as delivery-uncertain", async () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const requestId = randomUUID();
    const result = await handleBridgeRequest(
      {
        listAgents: async () => [
          { id: "bot-1", name: "Ada", isGroup: false, isRunning: true },
        ],
        sendPrompt: async () => {
          throw new LocalGatewayError("GATEWAY_REJECTED", status, requestId);
        },
      },
      {
        v: 1,
        id: requestId,
        issued_at_ms: Date.now(),
        op: "send_message",
        args: { bot_id: "bot-1", message: "send once" },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.delivery_may_have_occurred, true, `HTTP ${status}`);
  }
});

test("one bridge send cannot validate a Bot on gateway A and send through gateway B", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-operation-gateway-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  const gatewayA = {
    port: 4401,
    pid: 5401,
    startedAt: 6401,
    host: "127.0.0.1",
    token: "token-a",
  };
  const gatewayB = {
    port: 4402,
    pid: 5402,
    startedAt: 6402,
    host: "127.0.0.1",
    token: "token-b",
  };
  await writeFile(discoveryPath, JSON.stringify(gatewayA), { mode: 0o600 });

  const requests = [];
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    verifyServer: () => true,
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (String(input).endsWith("/api/listAgents")) {
        return Response.json([
          { id: "bot-a", name: "Gateway A Bot", isGroup: false, isRunning: true },
        ]);
      }
      return Response.json({ accepted: true });
    },
  });
  const listAgents = client.listAgents.bind(client);
  client.listAgents = async () => {
    const agents = await listAgents();
    await writeFile(discoveryPath, JSON.stringify(gatewayB), { mode: 0o600 });
    return agents;
  };

  const result = await handleBridgeRequest(client, {
    v: 1,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "send_message",
    args: { bot_id: "bot-a", message: "send only on gateway A" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONFIG_INVALID");
  assert.equal(result.error.delivery_may_have_occurred, true);
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:4401/api/listAgents",
      authorization: "Bearer token-a",
    },
  ]);
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

test("an active companion blocks forced reconnect and unpair without changing config", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-companion-"));
  const configPath = join(root, "config", "bridge.json");
  const config = parsePairCode(
    generatePairCode("wss://relay.example.test/v1/connect"),
  );
  await savePairingConfig(config, configPath);

  let stopRun;
  let markStarted;
  const started = new Promise((resolve) => (markStarted = resolve));
  const running = runBridgeCompanion(["run"], {
    configPath,
    createClient: () => ({}),
    runBridge: async () => {
      markStarted();
      await new Promise((resolve) => (stopRun = resolve));
    },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  });
  context.after(async () => {
    stopRun?.();
    await running;
    await rm(root, { recursive: true, force: true });
  });
  await started;
  const before = await readFile(configPath, "utf8");

  let pairCodeReads = 0;
  let connectError = "";
  const connected = await runBridgeCompanion(["connect", "--force"], {
    configPath,
    createClient: () => ({}),
    readPairCode: async () => {
      pairCodeReads += 1;
      return generatePairCode("wss://other.example.test/v1/connect");
    },
    runBridge: async () => undefined,
    stdout: { write: () => undefined },
    stderr: { write: (chunk) => (connectError += chunk) },
  });
  assert.equal(connected, 1);
  assert.equal(connectError, '{"error":"companion_already_running"}\n');
  assert.equal(pairCodeReads, 0);
  assert.equal(await readFile(configPath, "utf8"), before);

  let unpairError = "";
  const unpaired = await runBridgeCompanion(["unpair"], {
    configPath,
    stdout: { write: () => undefined },
    stderr: { write: (chunk) => (unpairError += chunk) },
  });
  assert.equal(unpaired, 1);
  assert.equal(unpairError, '{"error":"companion_already_running"}\n');
  assert.equal(await readFile(configPath, "utf8"), before);

  stopRun();
  assert.equal(await running, 0);
});

test("companion returns a bounded sanitized read-only Bot snapshot", async () => {
  const bot = {
    id: "bot-1",
    name: "Ada",
    isGroup: false,
    isRunning: true,
    isComposingMessage: false,
    awaitingUserResponse: { kind: "question" },
  };
  const transcriptCalls = [];
  let entries = [
    { seq: 1, id: "user-1", kind: "message", role: "user", content: "status?", timestampMs: 10 },
    { seq: 2, kind: "message", role: "assistant", content: "partial", streaming: true },
    { seq: 3, kind: "tool-call", name: "shell", input: "private" },
    { seq: 4, kind: "send-message", message: { type: "widget", content: "private" } },
    {
      seq: 5,
      entry: {
        kind: "message",
        role: "assistant",
        content: "working\r\nsa\u0000\u009fe\u202e\u2066",
        timestampMs: 20,
      },
    },
    {
      seq: 6,
      kind: "send-message",
      message: { type: "text", content: "peer update" },
      author: { id: "peer-1", name: "Turing" },
      timestampMs: 30,
    },
  ];
  const client = {
    discovery: () => ({ port: 1340, pid: 1, hasToken: true }),
    health: async () => ({ ok: true, isBusy: false }),
    listAgents: async () => [
      bot,
      { id: "group-1", name: "Room", isGroup: true, isRunning: false },
    ],
    getAgentTranscriptTail: async (input) => {
      transcriptCalls.push(input);
      return { entries, nextBeforeSeq: 1, tailCount: entries.length };
    },
    getAsyncTasks: async () => [{ status: "running" }, { status: "running" }],
    getSubagents: async () => [{ status: "running" }, { status: "complete" }],
    sendPrompt: async () => ({ accepted: true }),
  };

  const read = await handleBridgeRequest(client, {
    v: 2,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "read_bot",
    args: { bot_id: bot.id, limit: 6, before_sequence: 7 },
  });
  assert.equal(read.ok, true);
  assert.equal(read.v, 2);
  assert.deepEqual(read.result, {
    bot_id: bot.id,
    is_running: true,
    is_composing: false,
    awaiting_user: true,
    async_task_count: 2,
    running_subagent_count: 1,
    messages: [
      { speaker: "user", text: "status?", timestamp_ms: 10 },
      { speaker: "bot", text: "working\nsae", timestamp_ms: 20 },
      { speaker: "peer", text: "peer update", timestamp_ms: 30 },
    ],
    next_before_sequence: 1,
    truncated: false,
  });
  assert.deepEqual(transcriptCalls, [{ id: bot.id, limit: 6, beforeSeq: 7 }]);
  assert(!JSON.stringify(read).includes("private"));

  entries = [9, 10, 11, 12].map((seq) => ({
    seq,
    kind: "message",
    role: "assistant",
    content: "🙂".repeat(20_000),
  }));
  const bounded = await handleBridgeRequest(client, {
    v: 2,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "read_bot",
    args: { bot_id: bot.id, limit: 4 },
  });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.result.truncated, true);
  assert.equal(bounded.result.messages.length, 3);
  assert.equal(bounded.result.next_before_sequence, 10);
  assert(
    bounded.result.messages.every(
      ({ text }) => Buffer.byteLength(text, "utf8") <= 16 * 1024,
    ),
  );
  assert(
    bounded.result.messages.reduce(
      (bytes, { text }) => bytes + Buffer.byteLength(text, "utf8"),
      0,
    ) <= 48 * 1024,
  );
  assert(Buffer.byteLength(JSON.stringify(bounded.result), "utf8") <= 64 * 1024);

  const group = await handleBridgeRequest(client, {
    v: 2,
    id: randomUUID(),
    issued_at_ms: Date.now(),
    op: "read_bot",
    args: { bot_id: "group-1", limit: 1 },
  });
  assert.equal(group.ok, false);
  assert.equal(group.error.code, "BOT_NOT_FOUND");
  assert.equal(group.v, 2);
  assert.equal(transcriptCalls.length, 2);
});
