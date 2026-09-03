import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LocalGatewayError,
  LocalGrokBotClient,
} from "../dist/grok-bot-client.js";

async function writeSecureDiscovery(path, descriptor) {
  await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
}

test("wildcard gateway URL overrides connect through loopback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-wildcard-gateway-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  await writeSecureDiscovery(discoveryPath, {
    port: 4137,
    pid: 5137,
    startedAt: 6137,
    host: "127.0.0.1",
    token: "gateway-test-token",
  });

  let verifiedHost;
  let requestedUrl;
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: { SAND_GATEWAY_URL: "http://0.0.0.0:4137" },
    verifyServer: (_pid, _port, host) => {
      verifiedHost = host;
      return true;
    },
    fetch: async (input) => {
      requestedUrl = String(input);
      return Response.json({ ok: true, isBusy: false });
    },
  });

  assert.deepEqual(await client.health(), { ok: true, isBusy: false });
  assert.equal(verifiedHost, "127.0.0.1");
  assert.equal(requestedUrl, "http://127.0.0.1:4137/health");
});

test("local gateway client discovers loopback and exposes only bounded calls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-local-gateway-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const token = "gateway-secret-that-must-not-leak";
  const requests = [];
  let mode = "normal";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        slim: request.headers["x-sand-slim-avatars"],
        body: body === "" ? undefined : JSON.parse(body),
      });
      if (mode === "oversized") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(2 * 1024 * 1024 + 1),
        });
        response.end("[]");
        return;
      }
      if (mode === "slow") {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        setTimeout(() => response.end(JSON.stringify({ ok: true, isBusy: false })), 100);
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end(JSON.stringify({ ok: true, isBusy: false }));
      } else if (request.url === "/api/listAgents") {
        response.end(
          JSON.stringify([
            {
              id: "bot-1",
              name: "Ada",
              isGroup: false,
              isRunning: true,
              isComposingMessage: true,
              awaitingUserResponse: null,
              lastMessageId: "message-1",
              newestEntryId: "entry-2",
            },
          ]),
        );
      } else if (request.url === "/api/getAgentTranscriptTail") {
        response.end(
          JSON.stringify({
            entries: [{ seq: 2, id: "entry-2", kind: "message", entry: { private: true } }],
            nextBeforeSeq: 2,
            tailCount: 1,
          }),
        );
      } else if (request.url === "/api/getAsyncTasks") {
        response.end(
          JSON.stringify([
            {
              kind: "shell",
              id: "task-1",
              label: "Build",
              status: "running",
              startedAtMs: 1,
            },
          ]),
        );
      } else if (request.url === "/api/getSubagents") {
        response.end(
          JSON.stringify([
            {
              subagentId: "subagent-1",
              subagentType: "worker",
              title: "Inspect",
              status: "running",
              startedAtMs: 2,
            },
          ]),
        );
      } else {
        response.end(JSON.stringify({ accepted: true }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((caught) => (caught ? reject(caught) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  const discoveryPath = join(root, "gateway.json");
  await writeFile(
    discoveryPath,
    JSON.stringify({
      port: address.port,
      pid: 2468,
      startedAt: Date.now(),
      host: "0.0.0.0",
      token,
    }),
  );
  assert.throws(
    () => new LocalGrokBotClient({ discoveryPath, env: {}, verifyServer: () => true }),
    { code: "CONFIG_INVALID" },
  );
  await chmod(discoveryPath, 0o600);

  let verifiedServer;
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    verifyServer: (pid, port, host) => {
      verifiedServer = { pid, port, host };
      return true;
    },
  });
  assert.deepEqual(client.discovery(), { port: address.port, pid: 2468, hasToken: true });
  assert.deepEqual(verifiedServer, { pid: 2468, port: address.port, host: "127.0.0.1" });
  assert.deepEqual(await client.health(), { ok: true, isBusy: false });
  assert.deepEqual(await client.listAgents(), [
    {
      id: "bot-1",
      name: "Ada",
      isGroup: false,
      isRunning: true,
      isComposingMessage: true,
      awaitingUserResponse: null,
      lastMessageId: "message-1",
      newestEntryId: "entry-2",
    },
  ]);
  assert.deepEqual(
    await client.getAgentTranscriptTail({ id: "bot-1", limit: 10, beforeSeq: 3 }),
    {
      entries: [{ seq: 2, id: "entry-2", kind: "message", entry: { private: true } }],
      nextBeforeSeq: 2,
      tailCount: 1,
    },
  );
  assert.equal((await client.getAsyncTasks({ id: "bot-1" }))[0].id, "task-1");
  assert.equal((await client.getSubagents({ id: "bot-1" }))[0].subagentId, "subagent-1");
  assert.deepEqual(
    await client.sendPrompt({ agentId: "bot-1", prompt: "hello", clientNonce: "nonce-1" }),
    { accepted: true },
  );
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[1].authorization, `Bearer ${token}`);
  assert(requests.slice(1).every((request) => request.authorization === `Bearer ${token}`));
  assert(requests.every((request) => request.slim === "1"));
  assert.deepEqual(requests[2].body, { id: "bot-1", limit: 10, beforeSeq: 3 });
  assert.deepEqual(requests[3].body, { id: "bot-1" });
  assert.deepEqual(requests[4].body, { id: "bot-1" });
  assert.deepEqual(requests[5].body, {
    agentId: "bot-1",
    prompt: "hello",
    clientNonce: "nonce-1",
  });

  await assert.rejects(
    client.getAgentTranscriptTail({ id: "bot-1", limit: 51 }),
    { code: "CONFIG_INVALID" },
  );

  mode = "oversized";
  await assert.rejects(client.listAgents(), { code: "OUTPUT_LIMIT" });
  mode = "slow";
  const impatient = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    timeoutMs: 20,
    verifyServer: () => true,
  });
  await assert.rejects(impatient.health(), { code: "TIMEOUT" });
  mode = "normal";

  assert.throws(
    () =>
      new LocalGrokBotClient({
        env: {
          GROKBOT_GATEWAY_URL: "http://gateway.example.test:1340",
          SAND_GATEWAY_TOKEN: token,
        },
        verifyServer: () => true,
      }),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert(!caught.message.includes(token));
      return true;
    },
  );

  assert.throws(
    () => new LocalGrokBotClient({ discoveryPath, env: {}, verifyServer: () => false }),
    { code: "CONFIG_INVALID" },
  );

  if (process.platform === "linux") {
    const linuxDiscoveryPath = join(root, "gateway-linux.json");
    await writeFile(
      linuxDiscoveryPath,
      JSON.stringify({
        port: address.port,
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        token,
      }),
    );
    await chmod(linuxDiscoveryPath, 0o600);
    assert.equal(new LocalGrokBotClient({ discoveryPath: linuxDiscoveryPath, env: {} }).discovery().pid, process.pid);
  }
});

test("long-lived client refreshes the gateway descriptor and token before each request", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-gateway-refresh-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  const gateways = {
    a: { port: 4101, pid: 5101, startedAt: 6101, host: "127.0.0.1", token: "token-a" },
    b: { port: 4102, pid: 5102, startedAt: 6102, host: "127.0.0.1", token: "token-b" },
  };
  await writeSecureDiscovery(discoveryPath, gateways.a);

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
      return Response.json([
        { id: `bot-${requests.length}`, name: `Gateway ${requests.length}`, isGroup: false },
      ]);
    },
  });

  assert.equal((await client.listAgents())[0].name, "Gateway 1");
  await writeSecureDiscovery(discoveryPath, gateways.b);
  assert.deepEqual(client.discovery(), { port: 4102, pid: 5102, hasToken: true });
  assert.equal((await client.listAgents())[0].name, "Gateway 2");
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:4101/api/listAgents", authorization: "Bearer token-a" },
    { url: "http://127.0.0.1:4102/api/listAgents", authorization: "Bearer token-b" },
  ]);
});

test("descriptor rotation during a request fails closed without retrying", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-gateway-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  await writeSecureDiscovery(discoveryPath, {
    port: 4201,
    pid: 5201,
    startedAt: 6201,
    host: "127.0.0.1",
    token: "token-a",
  });

  let requests = 0;
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    verifyServer: () => true,
    fetch: async () => {
      requests += 1;
      await writeSecureDiscovery(discoveryPath, {
        port: 4202,
        pid: 5202,
        startedAt: 6202,
        host: "127.0.0.1",
        token: "token-b",
      });
      return Response.json([{ id: "bot-a", name: "Gateway A", isGroup: false }]);
    },
  });

  await assert.rejects(client.listAgents(), { code: "CONFIG_INVALID" });
  assert.equal(requests, 1);
});

test("descriptor rotation while reading a response body fails closed without retrying", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-gateway-body-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  const gatewayA = {
    port: 4301,
    pid: 5301,
    startedAt: 6301,
    host: "127.0.0.1",
    token: "token-a",
  };
  const gatewayB = {
    port: 4302,
    pid: 5302,
    startedAt: 6302,
    host: "127.0.0.1",
    token: "token-b",
  };
  await writeSecureDiscovery(discoveryPath, gatewayA);

  let requests = 0;
  let pulls = 0;
  const client = new LocalGrokBotClient({
    discoveryPath,
    env: {},
    verifyServer: () => true,
    fetch: async () => {
      requests += 1;
      return new Response(
        new ReadableStream(
          {
            async pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode('[{"id":"bot-a",'));
                return;
              }
              await writeSecureDiscovery(discoveryPath, gatewayB);
              controller.enqueue(
                new TextEncoder().encode('"name":"Gateway A","isGroup":false}]'),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  await assert.rejects(client.listAgents(), { code: "CONFIG_INVALID" });
  assert.equal(requests, 1);
  assert.equal(pulls, 2);
});
