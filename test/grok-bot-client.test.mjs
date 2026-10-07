import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_GROK_BOT_DATA_ROOT,
  GROK_BOT_DATA_ROOTS,
  LEGACY_GROK_BOT_DATA_ROOT,
  candidateGrokBotDataRoots,
  grokBotDataRoot,
  LocalGatewayError,
  LocalGrokBotClient,
  TestRealDataRootError,
} from "../dist/grok-bot-client.js";
import { applyHermeticEnv } from "./hermetic-setup.mjs";

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
        // Hold the body open until the client aborts. A timed 100 ms reply raced
        // the 20 ms timeout on slow macOS runners and sometimes completed first.
        request.on("close", () => {
          if (!response.writableEnded) response.end();
        });
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
  server.unref();
  context.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((caught) => (caught ? reject(caught) : resolve()));
      }),
  );
  await once(server, "listening");
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
        discoveryPath,
        env: {
          GROKBOT_GATEWAY_URL: "http://gateway.example.test:9",
          SAND_GATEWAY_TOKEN: token,
        },
        verifyServer: () => true,
      }),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "CONFIG_INVALID");
      assert(!caught.message.includes(token));
      return true;
    },
  );

  assert.throws(
    () => new LocalGrokBotClient({ discoveryPath, env: {}, verifyServer: () => false }),
    { code: "GATEWAY_VERIFICATION_FAILED" },
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

test("gateway verification accepts genuine gateway with clock skew (VM pause)", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  
  const root = await mkdtemp(join(tmpdir(), "codex-grok-gateway-skew-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  
  const gateway = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ ok: true, isBusy: false }));
    else if (request.url === "/api/listAgents") response.end("[]");
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  
  gateway.listen(0, "127.0.0.1");
  gateway.unref();
  context.after(
    () =>
      new Promise((resolve) => {
        gateway.closeAllConnections?.();
        gateway.close(() => resolve());
      }),
  );
  await new Promise((resolve, reject) => {
    gateway.once("listening", resolve);
    gateway.once("error", reject);
  });
  const address = gateway.address();
  assert(address && typeof address === "object");
  
  const now = Date.now();
  await writeSecureDiscovery(discoveryPath, {
    port: address.port,
    pid: process.pid,
    startedAt: now - 338_000,
    host: "127.0.0.1",
    token: "test-token",
  });
  
  const client = new LocalGrokBotClient({ discoveryPath, env: {} });
  const discovery = client.discovery();
  assert.equal(discovery.port, address.port);
  assert.equal(discovery.pid, process.pid);
});

test("gateway verification fails for reused PID without listening socket", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  
  const root = await mkdtemp(join(tmpdir(), "codex-grok-reused-pid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  
  await writeSecureDiscovery(discoveryPath, {
    port: 65_000,
    pid: process.pid,
    startedAt: Date.now(),
    host: "127.0.0.1",
    token: "test-token",
  });
  
  assert.throws(
    () => new LocalGrokBotClient({ discoveryPath, env: {} }).discovery(),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "GATEWAY_VERIFICATION_FAILED");
      return true;
    },
  );
});

test("gateway verification rejects descriptor startedAt in the future", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux only");
  
  const root = await mkdtemp(join(tmpdir(), "codex-grok-future-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  
  const gateway = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, isBusy: false }));
  });
  
  gateway.listen(0, "127.0.0.1");
  gateway.unref();
  context.after(
    () =>
      new Promise((resolve) => {
        gateway.closeAllConnections?.();
        gateway.close(() => resolve());
      }),
  );
  await new Promise((resolve, reject) => {
    gateway.once("listening", resolve);
    gateway.once("error", reject);
  });
  const address = gateway.address();
  assert(address && typeof address === "object");
  
  await writeSecureDiscovery(discoveryPath, {
    port: address.port,
    pid: process.pid,
    startedAt: Date.now() + 10_000,
    host: "127.0.0.1",
    token: "test-token",
  });
  
  assert.throws(
    () => new LocalGrokBotClient({ discoveryPath, env: {} }).discovery(),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "GATEWAY_VERIFICATION_FAILED");
      return true;
    },
  );
});

test("env port or bind host that disagrees with gateway.json is a named mismatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-env-mismatch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const discoveryPath = join(root, "gateway.json");
  await writeSecureDiscovery(discoveryPath, {
    port: 4137,
    pid: 5137,
    startedAt: 6137,
    host: "127.0.0.1",
    token: "gateway-test-token",
  });

  assert.throws(
    () =>
      new LocalGrokBotClient({
        discoveryPath,
        env: { SAND_HOST_PORT: "1340" },
        verifyServer: () => true,
      }),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "CONFIG_INVALID");
      assert.equal(caught.reason, "GATEWAY_ENV_MISMATCH");
      assert.match(caught.message, /SAND_HOST_PORT/);
      assert.doesNotMatch(caught.message, /SAND_GATEWAY_BIND_HOST/);
      return true;
    },
  );
  assert.throws(
    () =>
      new LocalGrokBotClient({
        discoveryPath,
        env: { SAND_GATEWAY_BIND_HOST: "10.0.0.1" },
        verifyServer: () => true,
      }),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "CONFIG_INVALID");
      assert.equal(caught.reason, "GATEWAY_ENV_MISMATCH");
      assert.match(caught.message, /SAND_GATEWAY_BIND_HOST/);
      assert.doesNotMatch(caught.message, /SAND_HOST_PORT/);
      return true;
    },
  );
  assert.throws(
    () =>
      new LocalGrokBotClient({
        discoveryPath,
        env: { SAND_HOST_PORT: "1340", SAND_GATEWAY_BIND_HOST: "10.0.0.1" },
        verifyServer: () => true,
      }),
    (caught) => {
      assert(caught instanceof LocalGatewayError);
      assert.equal(caught.code, "CONFIG_INVALID");
      assert.equal(caught.reason, "GATEWAY_ENV_MISMATCH");
      assert.match(caught.message, /SAND_HOST_PORT/);
      assert.match(caught.message, /SAND_GATEWAY_BIND_HOST/);
      return true;
    },
  );
});

function captureStderr(operation) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return original.call(process.stderr, chunk, encoding, callback);
  };
  const exitCode = process.exitCode;
  try {
    return { value: operation(), stderr: chunks.join(""), exitCode: process.exitCode };
  } finally {
    process.stderr.write = original;
    process.exitCode = exitCode;
  }
}

test("client aimed at the real default data root fails with the guard error", () => {
  const captured = captureStderr(() => {
    assert.throws(
      () => new LocalGrokBotClient({ env: {}, verifyServer: () => true }),
      (caught) => {
        assert(caught instanceof TestRealDataRootError);
        assert.equal(caught.message, "test data root resolved to the real Grok Bot data root");
        assert.notEqual(caught.name, "LocalGatewayError");
        return true;
      },
    );
  });
  assert.equal(captured.stderr, "");
  assert.equal(captured.exitCode, process.exitCode);
});

test("without the hermetic flag a non-real SAND_DATA_ROOT resolves with no side effects", (context) => {
  context.after(() => applyHermeticEnv());
  delete process.env.CODEX_GROK_TEST_HERMETIC;
  const fixture = join(tmpdir(), "codex-grok-nonreal-root");
  process.env.SAND_DATA_ROOT = fixture;
  const captured = captureStderr(() => {
    assert.equal(grokBotDataRoot({ SAND_DATA_ROOT: fixture }), fixture);
    assert.equal(grokBotDataRoot({}), DEFAULT_GROK_BOT_DATA_ROOT);
    assert.equal(grokBotDataRoot(), fixture);
  });
  assert.equal(captured.stderr, "");
  assert.equal(captured.exitCode, process.exitCode);
});

test("without the hermetic flag the real root matches production resolution", (context) => {
  context.after(() => applyHermeticEnv());
  delete process.env.CODEX_GROK_TEST_HERMETIC;
  const captured = captureStderr(() => {
    assert.equal(
      grokBotDataRoot({ SAND_DATA_ROOT: DEFAULT_GROK_BOT_DATA_ROOT }),
      DEFAULT_GROK_BOT_DATA_ROOT,
    );
    assert.equal(grokBotDataRoot({}), DEFAULT_GROK_BOT_DATA_ROOT);
  });
  assert.equal(captured.stderr, "");
  assert.equal(captured.exitCode, process.exitCode);
});

test("with the hermetic flag the real root throws TestRealDataRootError", () => {
  const captured = captureStderr(() => {
    assert.throws(
      () => grokBotDataRoot({ SAND_DATA_ROOT: DEFAULT_GROK_BOT_DATA_ROOT }),
      (caught) => caught instanceof TestRealDataRootError,
    );
    assert.throws(
      () => grokBotDataRoot({ SAND_DATA_ROOT: `${DEFAULT_GROK_BOT_DATA_ROOT}/./` }),
      (caught) => caught instanceof TestRealDataRootError,
    );
    assert.throws(
      () => grokBotDataRoot({ SAND_DATA_ROOT: join(DEFAULT_GROK_BOT_DATA_ROOT, "..", "sand-data") }),
      (caught) => caught instanceof TestRealDataRootError,
    );
  });
  assert.equal(captured.stderr, "");
  assert.equal(captured.exitCode, process.exitCode);
});

test("candidate Sand roots include every env derivation plus the fixed defaults", () => {
  const user = join(tmpdir(), "codex-grok-user-data");
  const dataRoot = join(tmpdir(), "codex-grok-data-root");
  assert.deepEqual(candidateGrokBotDataRoots({}), [...GROK_BOT_DATA_ROOTS]);
  assert.deepEqual(
    new Set(candidateGrokBotDataRoots({ SAND_DATA_ROOT: dataRoot })),
    new Set([...GROK_BOT_DATA_ROOTS, dataRoot]),
  );
  assert.deepEqual(
    new Set(candidateGrokBotDataRoots({ SAND_USER_DATA_DIR: user })),
    new Set([...GROK_BOT_DATA_ROOTS, join(user, "sand-data"), join(user, "agent-data")]),
  );
  assert.deepEqual(
    new Set(candidateGrokBotDataRoots({ SAND_USER_DATA_DIR: `  ${user}  ` })),
    new Set([...GROK_BOT_DATA_ROOTS, join(user, "sand-data"), join(user, "agent-data")]),
  );
  assert.deepEqual(
    new Set(
      candidateGrokBotDataRoots({
        SAND_DATA_ROOT: dataRoot,
        SAND_USER_DATA_DIR: user,
      }),
    ),
    new Set([
      ...GROK_BOT_DATA_ROOTS,
      dataRoot,
      join(user, "sand-data"),
      join(user, "agent-data"),
    ]),
  );
  assert.ok(GROK_BOT_DATA_ROOTS.includes(DEFAULT_GROK_BOT_DATA_ROOT));
  assert.ok(GROK_BOT_DATA_ROOTS.includes(LEGACY_GROK_BOT_DATA_ROOT));
});
