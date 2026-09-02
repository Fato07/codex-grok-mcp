import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/server";
import { doctor, GrokCliError, runGrok } from "../dist/grok-cli.js";
import { createServer } from "../dist/index.js";

const FAKE_GROK = String.raw`#!/usr/bin/env node
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("grok 1.0.13\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "models") {
  process.stdout.write("* grok-4.6\n- grok-4.5\n");
  process.exit(0);
}

const promptArg = args.find((arg) => arg.startsWith("--prompt-file="));
if (promptArg === undefined) throw new Error("missing prompt file");
const promptPath = promptArg.slice("--prompt-file=".length);
const prompt = readFileSync(promptPath, "utf8");
const root = dirname(promptPath);
const authLink = join(process.env.GROK_HOME, "auth.json");
const authTarget = realpathSync(authLink);
const capturePath = join(dirname(authTarget), "capture.jsonl");
const mode = (path) => statSync(path).mode & 0o777;

appendFileSync(
  capturePath,
  JSON.stringify({
    args,
    cwd: process.cwd(),
    env: process.env,
    prompt,
    root,
    grokHomeEntries: readdirSync(process.env.GROK_HOME).sort(),
    authIsSymlink: lstatSync(authLink).isSymbolicLink(),
    authTarget,
    isolatedConfig: readFileSync(join(process.env.GROK_HOME, "config.toml"), "utf8"),
    modes: {
      root: mode(root),
      home: mode(process.env.HOME),
      grokHome: mode(process.env.GROK_HOME),
      cwd: mode(process.cwd()),
      prompt: mode(promptPath),
      config: mode(join(process.env.GROK_HOME, "config.toml")),
    },
  }) + "\n",
);

if (prompt === "__FAIL_SECRET__") {
  process.stderr.write("401 token=TOP_SECRET prompt=__FAIL_SECRET__\n");
  process.exit(7);
}
if (prompt === "__MALFORMED__") {
  process.stdout.write("not json");
  process.exit(0);
}
if (prompt === "__EMPTY_TEXT__") {
  process.stdout.write(JSON.stringify({ text: "  " }));
  process.exit(0);
}
if (prompt === "__TRAILING_JSON__") {
  process.stdout.write('{"text":"ok"} trailing');
  process.exit(0);
}
if (prompt === "__OUTPUT_LIMIT__") {
  process.stdout.write('{"text":"' + "x".repeat(5 * 1024 * 1024));
  setInterval(() => {}, 1_000);
} else if (prompt === "__HANG__") {
  setInterval(() => {}, 1_000);
} else if (prompt === "__SLOW__") {
  setTimeout(() => process.stdout.write(JSON.stringify({ text: prompt })), 300);
} else {
  process.stdout.write(JSON.stringify({ text: prompt }));
}
`;

const fixtures = new Set();
const execFileAsync = promisify(execFile);

async function fixture(extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-test-"));
  fixtures.add(root);
  const authPath = join(root, "auth.json");
  const bin = join(root, "fake-grok.mjs");
  await writeFile(authPath, '{"test":"credential-placeholder"}', { mode: 0o600 });
  await writeFile(bin, FAKE_GROK, { mode: 0o700 });
  await chmod(bin, 0o700);
  return {
    root,
    authPath,
    capturePath: join(root, "capture.jsonl"),
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      GROK_MCP_AUTH_PATH: authPath,
      GROK_MCP_BIN: bin,
      GROK_MCP_MODEL: "grok-4.6",
      GROK_MCP_TIMEOUT_MS: "5000",
      ...extraEnv,
    },
  };
}

async function captures(path) {
  const content = await readFile(path, "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

async function waitForCapture(path) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    try {
      const [capture] = await captures(path);
      if (capture !== undefined) return capture;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fake Grok did not start");
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof GrokCliError && error.code === code,
  );
}

async function removed(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

function platformPath(path) {
  return process.platform === "darwin" && path.startsWith("/private/var/")
    ? path.slice("/private".length)
    : path;
}

test.afterEach(async () => {
  await Promise.all([...fixtures].map((path) => rm(path, { force: true, recursive: true })));
  fixtures.clear();
});

test("runner uses fixed argv, a private isolated home, and a filtered environment", async () => {
  const f = await fixture({
    GROK_AUTH: "must-not-leak",
    GROK_CONFIG: "must-not-leak",
    NODE_OPTIONS: "--inspect=0",
    TOP_SECRET: "must-not-leak",
    XAI_API_KEY: "must-not-leak",
  });
  const prompt = "-starts with a flag\nquotes: '$()' \"; unicode: żółć 🧪";

  const result = await runGrok(prompt, { env: f.env });
  assert.equal(result.text, prompt);
  assert.equal(result.model, "grok-4.6");

  const [capture] = await captures(f.capturePath);
  const promptPath = join(capture.root, "prompt.txt");
  const workPath = join(capture.root, "work");
  assert.deepEqual(capture.args, [
    `--prompt-file=${promptPath}`,
    "--verbatim",
    "--output-format=json",
    "--model=grok-4.6",
    "--no-subagents",
    "--no-plan",
    "--max-turns=1",
    "--permission-mode=dontAsk",
    "--disable-web-search",
    "--deny=Bash",
    "--deny=Edit",
    "--deny=Read",
    "--deny=Grep",
    "--deny=MCPTool",
    "--deny=WebFetch",
    "--deny=WebSearch",
    `--cwd=${workPath}`,
  ]);
  assert(!capture.args.some((arg) => arg.includes(prompt)));
  assert(!capture.args.includes("--no-auto-update"));
  assert(!capture.args.includes("--no-memory"));
  assert.equal(capture.prompt, prompt);
  assert.equal(platformPath(capture.cwd), platformPath(workPath));
  assert.deepEqual(capture.grokHomeEntries, ["auth.json", "config.toml"]);
  assert.equal(capture.authIsSymlink, true);
  assert.equal(capture.authTarget, await realpath(f.authPath));
  assert.equal(capture.isolatedConfig, "[cli]\nauto_update = false\n");
  assert.deepEqual(capture.modes, {
    root: 0o700,
    home: 0o700,
    grokHome: 0o700,
    cwd: 0o700,
    prompt: 0o600,
    config: 0o600,
  });
  for (const key of ["GROK_AUTH", "GROK_CONFIG", "NODE_OPTIONS", "TOP_SECRET", "XAI_API_KEY"]) {
    assert.equal(capture.env[key], undefined, `${key} leaked to child`);
  }
  assert.equal(capture.env.GROK_HOME, join(capture.root, "grok-home"));
  assert.equal(capture.env.HOME, join(capture.root, "home"));
  assert.notEqual(capture.env.HOME, process.env.HOME);
  await removed(capture.root);
});

test("prompt transport preserves edge cases and never reinterprets them as arguments", async () => {
  const f = await fixture();
  const prompts = [
    "--model=attacker-controlled",
    "line one\nline two\nline three",
    "'\"; $(touch /tmp/never); `id`",
    "emoji 🦕 and composed café and decomposed cafe\u0301",
  ];

  for (const prompt of prompts) {
    const result = await runGrok(prompt, { env: f.env });
    assert.equal(result.text, prompt);
  }

  const recorded = await captures(f.capturePath);
  assert.deepEqual(recorded.map((capture) => capture.prompt), prompts);
  for (const capture of recorded) {
    assert(!capture.args.some((arg) => prompts.includes(arg)));
  }
});

test("runner strictly rejects malformed or empty Grok JSON", async (t) => {
  for (const prompt of ["__MALFORMED__", "__EMPTY_TEXT__", "__TRAILING_JSON__"]) {
    await t.test(prompt, async () => {
      const f = await fixture();
      await expectCode(runGrok(prompt, { env: f.env }), "INVALID_OUTPUT");
    });
  }
});

test("child diagnostics and prompts are redacted from errors and logs", async () => {
  const f = await fixture({ TOP_SECRET: "must-not-leak" });
  const originalWrite = process.stderr.write;
  let logs = "";
  process.stderr.write = function (chunk, ...args) {
    logs += String(chunk);
    return true;
  };
  let caught;
  try {
    await runGrok("__FAIL_SECRET__", { env: f.env });
  } catch (error) {
    caught = error;
  } finally {
    process.stderr.write = originalWrite;
  }

  assert(caught instanceof GrokCliError);
  assert.equal(caught.code, "AUTH_REQUIRED");
  const exposed = `${caught.message}\n${caught.stack}\n${logs}`;
  assert(!exposed.includes("TOP_SECRET"));
  assert(!exposed.includes("__FAIL_SECRET__"));
  assert(!exposed.includes(f.root));
});

test("runner caps child output", async () => {
  const f = await fixture();
  await expectCode(runGrok("__OUTPUT_LIMIT__", { env: f.env }), "OUTPUT_LIMIT");
  const [capture] = await captures(f.capturePath);
  await removed(capture.root);
});

test("cancellation terminates the child and removes its sandbox", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = runGrok("__HANG__", { env: f.env, signal: controller.signal });
  const capture = await waitForCapture(f.capturePath);
  controller.abort();
  await expectCode(pending, "CANCELLED");
  await removed(capture.root);
});

test("timeout launches once, terminates the child, and removes its sandbox", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const pending = runGrok("__HANG__", { env: f.env });
  const capture = await waitForCapture(f.capturePath);
  await expectCode(pending, "TIMEOUT");
  assert.equal((await captures(f.capturePath)).length, 1);
  await removed(capture.root);
});

test("a concurrent call returns BUSY without a second launch", async () => {
  const f = await fixture();
  const first = runGrok("__SLOW__", { env: f.env });
  await expectCode(runGrok("second call", { env: f.env }), "BUSY");
  assert.equal((await first).text, "__SLOW__");
  assert.equal((await captures(f.capturePath)).length, 1);
});

test("a failed request is never retried", async () => {
  const f = await fixture();
  await expectCode(runGrok("__FAIL_SECRET__", { env: f.env }), "AUTH_REQUIRED");
  assert.equal((await captures(f.capturePath)).length, 1);
});

test("insecure authentication permissions fail closed before child launch", async () => {
  const f = await fixture();
  await chmod(f.authPath, 0o644);
  await expectCode(runGrok("hello", { env: f.env }), "CONFIG_INVALID");
  await removed(f.capturePath);
});

test("invalid prompts fail before child launch", async (t) => {
  for (const [name, prompt] of [
    ["empty", " \n\t"],
    ["NUL", "hello\0world"],
    ["over 65536 UTF-8 bytes", "x".repeat(65_537)],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      await expectCode(runGrok(prompt, { env: f.env }), "CONFIG_INVALID");
      await removed(f.capturePath);
    });
  }
});

test("unsafe executable and model configuration fail before child launch", async (t) => {
  await t.test("relative executable", async () => {
    const f = await fixture({ GROK_MCP_BIN: "relative-grok" });
    await expectCode(runGrok("hello", { env: f.env }), "CONFIG_INVALID");
    await removed(f.capturePath);
  });
  await t.test("disallowed model", async () => {
    const f = await fixture({ GROK_MCP_MODEL: "attacker-model" });
    await expectCode(runGrok("hello", { env: f.env }), "CONFIG_INVALID");
    await removed(f.capturePath);
  });
});

test("doctor verifies the fake CLI without sending a prompt", async () => {
  const f = await fixture();
  const result = await doctor(f.env);
  assert.deepEqual(result, {
    version: "grok 1.0.13",
    model: "grok-4.6",
    availableModels: ["grok-4.5", "grok-4.6"],
  });
  await removed(f.capturePath);
  assert.equal(await readFile(f.authPath, "utf8"), '{"test":"credential-placeholder"}');
});

test("the npm-style symlinked executable runs doctor", async () => {
  const f = await fixture();
  const binLink = join(f.root, "codex-grok-mcp");
  await symlink(join(process.cwd(), "dist", "index.js"), binLink);

  const { stdout } = await execFileAsync(process.execPath, [binLink, "--doctor"], { env: f.env });
  assert.match(stdout, /Grok CLI: grok 1\.0\.13/);
  assert.match(stdout, /Model: grok-4\.6/);
});

test("MCP exposes only the isolated ask and safe bridge status tools", async () => {
  const f = await fixture();
  const server = createServer(f.env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let nextId = 0;
  const pending = new Map();
  clientTransport.onmessage = (message) => {
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

  try {
    await server.connect(serverTransport);
    await clientTransport.start();
    await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "security-test", version: "1" },
    });
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await request("tools/list");
    assert.deepEqual(listed.tools.map(({ name }) => name), ["grok_ask", "grok_bridge_status"]);
    const ask = listed.tools.find(({ name }) => name === "grok_ask");
    assert.equal(ask.title, "Ask Grok");
    assert.deepEqual(ask.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    const status = listed.tools.find(({ name }) => name === "grok_bridge_status");
    assert.deepEqual(status.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    const called = await request("tools/call", {
      name: "grok_ask",
      arguments: { prompt: "MCP boundary check" },
    });
    assert.equal(called.isError, undefined);
    assert.equal(called.content[0].text, "MCP boundary check");
    assert.deepEqual(
      {
        text: called.structuredContent.text,
        model: called.structuredContent.model,
        usage_boundary: called.structuredContent.usage_boundary,
      },
      {
        text: "MCP boundary check",
        model: "grok-4.6",
        usage_boundary: "grok_account_allowance",
      },
    );

    const invalid = await request("tools/call", {
      name: "grok_ask",
      arguments: { prompt: "must not launch", extra: true },
    });
    assert.equal(invalid.isError, true);
    assert.equal((await captures(f.capturePath)).length, 1);

    const failed = await request("tools/call", {
      name: "grok_ask",
      arguments: { prompt: "__MALFORMED__" },
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    assert.match(failed.content[0].text, /^\[INVALID_OUTPUT\] Grok CLI returned malformed JSON\./);
    assert.match(failed.content[0].text, /Automatic retry is disabled/);
    assert(!failed.content[0].text.includes("__MALFORMED__"));
    assert.equal((await captures(f.capturePath)).length, 2);
  } finally {
    await clientTransport.close();
    await server.close();
  }
});
