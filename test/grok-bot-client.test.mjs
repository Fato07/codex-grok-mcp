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
