import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from "@modelcontextprotocol/server";
import { WebSocketServer } from "ws";
import {
  decryptFrame,
  encryptFrame,
  generatePairCode,
  parsePairCode,
} from "../dist/bridge-pairing.js";
import { createDirectGatewayTransport } from "../dist/direct-gateway-transport.js";
import { registerGrokBotTools } from "../dist/grok-bot-gateway.js";
import { createRelayTransport } from "../dist/relay-transport.js";

// Operator-only synthetic measurement. It never reads live gateway configuration.
const BOT_ID = "00000000-0000-4000-8000-0000000000a1";
const FIXTURE_DELAY_MS = 75;

const round = (value) => Math.round(value * 10) / 10;
const median = (values) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

async function openMcp(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let nextId = 0;

  clientTransport.onmessage = (message) => {
    if (!("id" in message) || "method" in message) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };

  const request = async (method, params = {}) => {
    const id = ++nextId;
    const response = new Promise((resolve) => pending.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    const message = await response;
    if ("error" in message) throw new Error(JSON.stringify(message.error));
    return message.result;
  };

  try {
    await server.connect(serverTransport);
    await clientTransport.start();
    await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "transport-boundary-measurement", version: "1" },
    });
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (error) {
    try {
      await clientTransport.close();
    } finally {
      await server.close();
    }
    throw error;
  }

  return {
    request,
    async close() {
      try {
        await clientTransport.close();
      } finally {
        await server.close();
      }
    },
  };
}

async function readBot(mcp) {
  const result = await mcp.request("tools/call", {
    name: "grok_read_bot",
    arguments: { bot_id: BOT_ID, limit: 5 },
  });
  assert.equal(result.isError, undefined);
  return result;
}

async function measureDirect() {
  const realFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  let paths = [];

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(FIXTURE_DELAY_MS);
    active -= 1;

    if (path === "/api/listAgents") {
      return Response.json([
        {
          id: BOT_ID,
          name: "Fixture Bot",
          isGroup: false,
          isRunning: true,
          isComposingMessage: false,
          awaitingUserResponse: null,
        },
      ]);
    }
    if (path === "/api/getAgentTranscriptTail") {
      return Response.json({ entries: [], nextBeforeSeq: 1 });
    }
    if (path === "/api/getAsyncTasks" || path === "/api/getSubagents") {
      return Response.json([]);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

  let mcp;
  try {
    const server = new McpServer({ name: "direct-measurement", version: "1" });
    registerGrokBotTools(
      server,
      createDirectGatewayTransport({
        baseUrl: "http://127.0.0.1:1340",
        token: "fixture-token",
      }),
    );
    mcp = await openMcp(server);
    await readBot(mcp);
    maxActive = 0;

    const samplesMs = [];
    const gatewayRequestsPerCall = [];
    const gatewayRequestSequences = [];
    for (let sample = 0; sample < 5; sample += 1) {
      paths = [];
      const startedAt = performance.now();
      await readBot(mcp);
      samplesMs.push(round(performance.now() - startedAt));
      gatewayRequestsPerCall.push(paths.length);
      gatewayRequestSequences.push([...paths]);
      assert.deepEqual(paths.slice(0, 2), ["/api/listAgents", "/api/listAgents"]);
      assert.deepEqual([...paths.slice(2)].sort(), [
        "/api/getAgentTranscriptTail",
        "/api/getAsyncTasks",
        "/api/getSubagents",
      ].sort());
    }
    assert.equal(maxActive, 3);

    return {
      samples_ms: samplesMs,
      median_ms: median(samplesMs),
      gateway_requests_per_call: gatewayRequestsPerCall,
      gateway_request_sequences: gatewayRequestSequences,
      max_concurrent_gateway_requests: maxActive,
    };
  } finally {
    globalThis.fetch = realFetch;
    await mcp?.close();
  }
}

async function closeWebSocketServer(server) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve, reject) =>
    server.close((error) =>
      error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
    ),
  );
}

async function measurePaired() {
  const fixture = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await once(fixture, "listening");
    const address = fixture.address();
    assert(address && typeof address === "object");
    const config = parsePairCode(
      generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
    );
    let active = 0;
    let maxActive = 0;
    let operations = [];

    fixture.on("connection", (socket) => {
      socket.once("message", async (data) => {
        const request = JSON.parse(
          decryptFrame(config, "codex", data.toString()).toString("utf8"),
        );
        operations.push(request.op);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(FIXTURE_DELAY_MS);
        active -= 1;

        const response =
          request.op === "list_bots"
            ? {
                v: 1,
                id: request.id,
                op: "list_bots",
                ok: true,
                result: {
                  bots: [{ id: BOT_ID, name: "Fixture Bot", is_running: true }],
                },
              }
            : {
                v: 2,
                id: request.id,
                op: "read_bot",
                ok: true,
                result: {
                  bot_id: BOT_ID,
                  is_running: true,
                  is_composing: false,
                  awaiting_user: false,
                  async_task_count: 0,
                  running_subagent_count: 0,
                  messages: [],
                  next_before_sequence: null,
                  truncated: false,
                },
              };
        socket.send(encryptFrame(config, "bridge", JSON.stringify(response)));
      });
    });

    const server = new McpServer({ name: "paired-measurement", version: "1" });
    registerGrokBotTools(server, createRelayTransport(config));
    const mcp = await openMcp(server);
    try {
      const readPair = () => Promise.all([readBot(mcp), readBot(mcp)]);
      await readPair();
      maxActive = 0;

      const samplesMs = [];
      const operationSequences = [];
      for (let sample = 0; sample < 5; sample += 1) {
        operations = [];
        const startedAt = performance.now();
        await readPair();
        samplesMs.push(round(performance.now() - startedAt));
        operationSequences.push([...operations]);
        assert.deepEqual(operations, ["list_bots", "list_bots", "read_bot", "read_bot"]);
      }
      assert.equal(maxActive, 1);

      return {
        samples_ms: samplesMs,
        median_ms: median(samplesMs),
        bridge_operation_sequences: operationSequences,
        max_concurrent_bridge_operations: maxActive,
      };
    } finally {
      await mcp.close();
    }
  } finally {
    await closeWebSocketServer(fixture);
  }
}

async function measurePolling() {
  let readsThisRun = 0;
  let listsThisRun = 0;
  const transport = {
    async listBots() {
      listsThisRun += 1;
      return [{ id: BOT_ID, name: "Fixture Bot", is_running: true }];
    },
    async readBot() {
      readsThisRun += 1;
      const working = readsThisRun === 1;
      return {
        bot_id: BOT_ID,
        is_running: working,
        is_composing: false,
        awaiting_user: false,
        async_task_count: 0,
        running_subagent_count: 0,
        messages: [],
        next_before_sequence: null,
        truncated: false,
      };
    },
    async sendMessage() {
      throw new Error("measurement fixture does not send");
    },
  };
  const server = new McpServer({ name: "polling-measurement", version: "1" });
  registerGrokBotTools(server, transport);
  const mcp = await openMcp(server);

  const run = async () => {
    readsThisRun = 0;
    listsThisRun = 0;
    const startedAt = performance.now();
    const result = await mcp.request("tools/call", {
      name: "grok_wait_for_bot",
      arguments: { bot_id: BOT_ID, limit: 5, timeout_seconds: 5 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.stop_reason, "idle");
    assert.equal(result.structuredContent.activity_state, "idle");
    assert.equal(result.structuredContent.observed_working, true);
    assert.equal(result.structuredContent.observations, 2);
    assert.equal(readsThisRun, 2);
    assert.equal(listsThisRun, 1);
    return round(performance.now() - startedAt);
  };

  try {
    await run();
    const samplesMs = [];
    for (let sample = 0; sample < 3; sample += 1) samplesMs.push(await run());
    return {
      samples_ms: samplesMs,
      median_ms: median(samplesMs),
      successful_observations_per_call: 2,
      requested_poll_interval_ms: 3_000,
    };
  } finally {
    await mcp.close();
  }
}

try {
  const direct = await measureDirect();
  const paired = await measurePaired();
  const polling = await measurePolling();
  console.log(
    JSON.stringify(
      {
        scope: "local synthetic fixtures only; no live gateway or Bot data",
        environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
        fixture_delay_ms: { direct_and_paired: FIXTURE_DELAY_MS, polling: 0 },
        execution_order: [
          "one unreported direct grok_read_bot warm-up",
          "five sequential direct grok_read_bot calls",
          "one unreported paired warm-up of two simultaneous grok_read_bot calls",
          "five sequential paired batches, each with two simultaneous grok_read_bot calls",
          "one unreported working-to-idle grok_wait_for_bot warm-up",
          "three sequential working-to-idle grok_wait_for_bot calls",
        ],
        direct_grok_read_bot: direct,
        paired_two_concurrent_grok_read_bot_calls: paired,
        working_then_idle_polling: polling,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "transport measurement failed");
  process.exitCode = 1;
}
