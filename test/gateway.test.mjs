import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from "@modelcontextprotocol/server";
import { registerGrokBotTools } from "../dist/grok-bot-gateway.js";
import { createServer } from "../dist/index.js";

const TOKEN = "gateway-test-token";
const BOTS = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Ada",
    isRunning: true,
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "Turing",
    isRunning: false,
  },
  {
    id: "00000000-0000-4000-8000-0000000000a3",
    name: "Grace",
  },
];

async function openMcp(env, { approvePingAll = false, server } = {}) {
  const mcpServer = server ?? createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const elicitationRequests = [];
  let nextId = 0;
  const pending = new Map();
  clientTransport.onmessage = async (message) => {
    if ("method" in message) {
      if (message.method === "elicitation/create" && "id" in message) {
        elicitationRequests.push(message.params);
        await clientTransport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: approvePingAll
            ? { action: "accept", content: { confirm: true } }
            : { action: "decline" },
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
    capabilities: { elicitation: {} },
    clientInfo: { name: "gateway-test", version: "1" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    elicitationRequests,
    request,
    async close() {
      await clientTransport.close();
      await mcpServer.close();
    },
  };
}

async function startGateway(handler) {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const seen = {
      path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      authorization: request.headers.authorization,
      body: raw.length === 0 ? undefined : JSON.parse(raw),
    };
    requests.push(seen);

    const result = await handler(seen);
    response.writeHead(result?.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result?.body ?? null));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    })),
  };
}

function gatewayEnv(gateway) {
  return {
    GROKBOT_GATEWAY_URL: gateway.url,
    SAND_GATEWAY_TOKEN: TOKEN,
  };
}

test("gateway tools use the two-operation transport seam", async () => {
  const calls = [];
  const transport = {
    async listBots() {
      calls.push({ operation: "listBots" });
      return BOTS.map(({ id, name, isRunning }) => ({
        id,
        name,
        is_running: isRunning ?? null,
      }));
    },
    async sendMessage(botId, message) {
      calls.push({ operation: "sendMessage", botId, message });
      return { accepted: true, requestId: "transport-request-id" };
    },
  };
  const server = new McpServer({ name: "transport-test", version: "1" });
  registerGrokBotTools(server, transport);
  const mcp = await openMcp({}, { server });

  try {
    const sent = await mcp.request("tools/call", {
      name: "grok_send_bot_message",
      arguments: { bot_id: BOTS[0].id, message: "through the seam" },
    });
    assert.equal(sent.structuredContent.request_id, "transport-request-id");
    assert.deepEqual(calls, [
      { operation: "listBots" },
      {
        operation: "sendMessage",
        botId: BOTS[0].id,
        message: "through the seam",
      },
    ]);
  } finally {
    await mcp.close();
  }
});

test("persistent Bot tools are opt-in and partial gateway credentials fail closed", async () => {
  const mcp = await openMcp({});
  try {
    const listed = await mcp.request("tools/list");
    assert.deepEqual(listed.tools.map(({ name }) => name), ["grok_ask"]);
  } finally {
    await mcp.close();
  }

  assert.throws(
    () => createServer({ GROKBOT_GATEWAY_URL: "http://127.0.0.1:1340" }),
    /GROKBOT_GATEWAY_URL|SAND_GATEWAY_TOKEN/,
  );
  assert.throws(
    () => createServer({ SAND_GATEWAY_TOKEN: TOKEN }),
    (error) => error instanceof Error && !error.message.includes(TOKEN),
  );
  assert.throws(
    () =>
      createServer({
        GROKBOT_GATEWAY_URL: "http://gateway.example.com:1340",
        SAND_GATEWAY_TOKEN: TOKEN,
      }),
    (error) =>
      error instanceof Error && /HTTPS|loopback/.test(error.message) && !error.message.includes(TOKEN),
  );
});

test("configured gateway exposes roster and exact-ID send with an acceptance receipt", async () => {
  const gateway = await startGateway(({ path }) => {
    if (path === "/api/listAgents") {
      return {
        body: [
          ...BOTS,
          {
            id: "00000000-0000-4000-8000-0000000000ff",
            name: "Group room",
            isGroup: true,
            isRunning: false,
          },
        ],
      };
    }
    if (path === "/api/sendPrompt") return { body: { accepted: true } };
    return { status: 404, body: { error: "not found" } };
  });
  const mcp = await openMcp(gatewayEnv(gateway));

  try {
    const listed = await mcp.request("tools/list");
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      ["grok_ask", "grok_list_bots", "grok_send_bot_message", "grok_ping_all_bots"],
    );

    const roster = await mcp.request("tools/call", {
      name: "grok_list_bots",
      arguments: {},
    });
    assert.deepEqual(roster.structuredContent.bots, [
      { id: BOTS[0].id, name: "Ada", is_running: true },
      { id: BOTS[1].id, name: "Turing", is_running: false },
      { id: BOTS[2].id, name: "Grace", is_running: null },
    ]);
    assert.equal(roster.structuredContent.experimental, true);
    assert.equal(roster.structuredContent.bot_count, 3);
    assert.equal(typeof roster.structuredContent.roster_fingerprint, "string");

    gateway.requests.length = 0;
    const sent = await mcp.request("tools/call", {
      name: "grok_send_bot_message",
      arguments: { bot_id: BOTS[0].id, message: "status only" },
    });
    assert.deepEqual(
      {
        experimental: sent.structuredContent.experimental,
        bot_id: sent.structuredContent.bot_id,
        bot_name: sent.structuredContent.bot_name,
        accepted: sent.structuredContent.accepted,
        completion_boundary: sent.structuredContent.completion_boundary,
      },
      {
        experimental: true,
        bot_id: BOTS[0].id,
        bot_name: "Ada",
        accepted: true,
        completion_boundary: "gateway_accepted_not_bot_reply",
      },
    );
    assert.equal(typeof sent.structuredContent.request_id, "string");
    assert.deepEqual(gateway.requests.map(({ path }) => path), [
      "/api/listAgents",
      "/api/sendPrompt",
    ]);
    assert.deepEqual(
      {
        agentId: gateway.requests[1].body.agentId,
        prompt: gateway.requests[1].body.prompt,
      },
      { agentId: BOTS[0].id, prompt: "status only" },
    );
    for (const request of gateway.requests) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`);
    }
  } finally {
    await mcp.close();
    await gateway.close();
  }
});

test("ambiguous 409 send failures are not retried and remain outcome unknown", async () => {
  let sendCount = 0;
  const gateway = await startGateway(({ path }) => {
    if (path === "/api/listAgents") return { body: BOTS };
    if (path === "/api/sendPrompt") {
      sendCount += 1;
      return { status: 409, body: { error: `ambiguous acceptance ${TOKEN}` } };
    }
    return { status: 404, body: { error: "not found" } };
  });
  const mcp = await openMcp(gatewayEnv(gateway));

  try {
    const failed = await mcp.request("tools/call", {
      name: "grok_send_bot_message",
      arguments: { bot_id: BOTS[0].id, message: "send once" },
    });
    assert.equal(failed.isError, true);
    assert.equal(sendCount, 1);
    assert(!JSON.stringify(failed).includes(TOKEN));
    assert.match(failed.content[0].text, /outcome is unknown/i);
  } finally {
    await mcp.close();
    await gateway.close();
  }
});

test("ping-all preview performs no sends and stale or mismatched confirmation is rejected", async () => {
  let roster = BOTS.slice(0, 2);
  const gateway = await startGateway(({ path }) => {
    if (path === "/api/listAgents") return { body: roster };
    if (path === "/api/sendPrompt") return { body: { accepted: true } };
    return { status: 404, body: { error: "not found" } };
  });
  const mcp = await openMcp(gatewayEnv(gateway));

  try {
    const preview = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {},
    });
    assert.equal(preview.structuredContent.requires_confirmation, true);
    assert.equal(preview.structuredContent.message, "PING");
    assert.equal(preview.structuredContent.bot_count, 2);
    assert.equal(gateway.requests.filter(({ path }) => path === "/api/sendPrompt").length, 0);

    const declined = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        bot_ids: BOTS.slice(0, 2).map(({ id }) => id),
        confirmation: "PING_ALL",
      },
    });
    assert.equal(declined.isError, true);
    assert.equal(mcp.elicitationRequests.length, 1);
    assert.equal(gateway.requests.filter(({ path }) => path === "/api/sendPrompt").length, 0);

    const mismatched = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        bot_ids: [BOTS[0].id],
        confirmation: "PING_ALL",
      },
    });
    assert.equal(mismatched.isError, true);
    assert.equal(gateway.requests.filter(({ path }) => path === "/api/sendPrompt").length, 0);

    roster = BOTS;
    const stale = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        bot_ids: BOTS.slice(0, 2).map(({ id }) => id),
        confirmation: "PING_ALL",
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(gateway.requests.filter(({ path }) => path === "/api/sendPrompt").length, 0);
  } finally {
    await mcp.close();
    await gateway.close();
  }
});

test("confirmed ping-all sends sequentially once per Bot and returns per-Bot receipts", async () => {
  let activeSends = 0;
  let maxActiveSends = 0;
  const sendBodies = [];
  const gateway = await startGateway(async ({ path, body }) => {
    if (path === "/api/listAgents") return { body: BOTS };
    if (path !== "/api/sendPrompt") return { status: 404, body: { error: "not found" } };

    sendBodies.push(body);
    activeSends += 1;
    maxActiveSends = Math.max(maxActiveSends, activeSends);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeSends -= 1;
    if (body.agentId === BOTS[1].id) {
      return { status: 503, body: { error: `temporary ${TOKEN}` } };
    }
    return { body: { accepted: true } };
  });
  const mcp = await openMcp(gatewayEnv(gateway), { approvePingAll: true });

  try {
    const preview = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {},
    });
    const confirmed = await mcp.request("tools/call", {
      name: "grok_ping_all_bots",
      arguments: {
        roster_fingerprint: preview.structuredContent.roster_fingerprint,
        bot_ids: BOTS.map(({ id }) => id),
        confirmation: "PING_ALL",
      },
    });

    assert.equal(confirmed.isError, undefined);
    assert.deepEqual(
      confirmed.structuredContent.receipts.map(({ bot_id, bot_name, status }) => ({
        bot_id,
        bot_name,
        status,
      })),
      [
        { bot_id: BOTS[0].id, bot_name: "Ada", status: "accepted" },
        { bot_id: BOTS[1].id, bot_name: "Turing", status: "outcome_unknown" },
        { bot_id: BOTS[2].id, bot_name: "Grace", status: "accepted" },
      ],
    );
    assert.deepEqual(
      {
        requires_confirmation: confirmed.structuredContent.requires_confirmation,
        message: confirmed.structuredContent.message,
        accepted_count: confirmed.structuredContent.accepted_count,
        failed_count: confirmed.structuredContent.failed_count,
        outcome_unknown_count: confirmed.structuredContent.outcome_unknown_count,
        not_attempted_count: confirmed.structuredContent.not_attempted_count,
        completion_boundary: confirmed.structuredContent.completion_boundary,
      },
      {
        requires_confirmation: false,
        message: "PING",
        accepted_count: 2,
        failed_count: 0,
        outcome_unknown_count: 1,
        not_attempted_count: 0,
        completion_boundary: "gateway_accepted_not_bot_reply",
      },
    );
    assert.equal(maxActiveSends, 1);
    assert.equal(mcp.elicitationRequests.length, 1);
    assert.deepEqual(
      sendBodies.map(({ agentId, prompt }) => ({ agentId, prompt })),
      BOTS.map(({ id }) => ({ agentId: id, prompt: "PING" })),
    );
    assert(!JSON.stringify(confirmed).includes(TOKEN));
  } finally {
    await mcp.close();
    await gateway.close();
  }
});
