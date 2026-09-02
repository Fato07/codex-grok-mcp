#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LocalGatewayError,
  LocalGrokBotClient,
  type LocalAgentSummary,
  type LocalGatewayDiscovery,
  type LocalGatewayHealth,
  type LocalSendPromptInput,
} from "./grok-bot-client.js";
import WebSocket, { type RawData } from "ws";
import {
  bridgeRequestSchema,
  bridgeResponseSchema,
  type BridgeErrorCode,
  type BridgeRequest,
  type BridgeResponse,
} from "./bridge-protocol.js";
import {
  decryptFrame,
  encryptFrame,
  loadPairingConfig,
  parsePairCode,
  removePairingConfig,
  savePairingConfig,
  type PairingConfig,
} from "./bridge-pairing.js";
import { PersistentReplayGuard } from "./bridge-replay.js";

const PROBE_TIMEOUT_MS = 5_000;
const BRIDGE_GATEWAY_TIMEOUT_MS = 10_000;
const MAX_RELAY_FRAME_BYTES = 128 * 1024;
const REQUEST_FRESHNESS_MS = 60_000;
const MAX_RECENT_REQUESTS = 1_024;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export type BridgeProbeClient = {
  discovery(): Pick<LocalGatewayDiscovery, "port" | "pid" | "hasToken">;
  health(): Promise<Pick<LocalGatewayHealth, "ok" | "isBusy">>;
  listAgents(): Promise<
    Array<Pick<LocalAgentSummary, "id" | "isGroup" | "isRunning" | "name">>
  >;
};

export type BridgeClient = BridgeProbeClient & {
  sendPrompt(input: LocalSendPromptInput): Promise<{ accepted: true }>;
};

export type BridgeProbeResult = {
  gateway: {
    port: number;
    pid: number;
    hasToken: boolean;
  };
  health: {
    ok: boolean;
    busy: boolean;
  };
  bot_count: number;
  roster_fingerprint: string;
};

type Writer = { write(chunk: string): unknown };

type CliDependencies = {
  createClient?: () => BridgeClient;
  readPairCode?: () => Promise<string>;
  runBridge?: (config: PairingConfig, client: BridgeClient) => Promise<void>;
  configPath?: string;
  stdout?: Writer;
  stderr?: Writer;
};

export function createBridgeProbeClient(): BridgeClient {
  return new LocalGrokBotClient({ timeoutMs: BRIDGE_GATEWAY_TIMEOUT_MS });
}

export async function probeBridge(client: BridgeProbeClient): Promise<BridgeProbeResult> {
  const discovery = client.discovery();
  const [health, agents] = await Promise.all([client.health(), client.listAgents()]);
  const ids = agents
    .filter((agent) => !agent.isGroup)
    .map((agent) => agent.id)
    .sort();

  return {
    gateway: {
      port: discovery.port,
      pid: discovery.pid,
      hasToken: discovery.hasToken,
    },
    health: {
      ok: health.ok,
      busy: health.isBusy,
    },
    bot_count: ids.length,
    roster_fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(ids)).digest("hex")}`,
  };
}

function bridgeSocketUrl(config: PairingConfig): string {
  const url = new URL(config.relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${config.channel}`;
  url.searchParams.set("role", "bridge");
  return url.toString();
}

function textFrame(data: RawData, isBinary: boolean): string {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));
  if (isBinary || buffer.byteLength > MAX_RELAY_FRAME_BYTES) throw new Error("invalid_frame");
  return buffer.toString("utf8");
}

function responseError(
  request: BridgeRequest,
  code: BridgeErrorCode,
  deliveryMayHaveOccurred: boolean,
  requestId?: string,
): BridgeResponse {
  return {
    v: 1,
    id: request.id,
    ok: false,
    error: {
      code,
      delivery_may_have_occurred: deliveryMayHaveOccurred,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    },
  };
}

function sdkFailure(
  request: BridgeRequest,
  caught: unknown,
  sendStarted: boolean,
): BridgeResponse {
  if (!(caught instanceof LocalGatewayError)) {
    return responseError(request, "UNAVAILABLE", sendStarted);
  }
  const code: BridgeErrorCode = caught.code;
  const rejectedBeforeDelivery = [400, 401, 403, 404, 413, 422].includes(caught.status);
  return responseError(
    request,
    code,
    sendStarted && !rejectedBeforeDelivery,
    caught.requestId,
  );
}

export async function handleBridgeRequest(
  client: BridgeClient,
  request: BridgeRequest,
): Promise<BridgeResponse> {
  try {
    const agents = await client.listAgents();
    const bots = agents
      .filter((agent) => !agent.isGroup)
      .map((agent) => ({ id: agent.id, name: agent.name, is_running: agent.isRunning ?? null }));

    if (request.op === "list_bots") {
      return bridgeResponseSchema.parse({
        v: 1,
        id: request.id,
        op: request.op,
        ok: true,
        result: { bots },
      });
    }

    const bot = bots.find((candidate) => candidate.id === request.args.bot_id);
    if (bot === undefined) return responseError(request, "BOT_NOT_FOUND", false);

    let sendStarted = false;
    try {
      sendStarted = true;
      const receipt = await client.sendPrompt({
        agentId: bot.id,
        prompt: request.args.message,
        clientNonce: request.id,
      });
      if (receipt.accepted !== true) return responseError(request, "INVALID_RESPONSE", true);
      return {
        v: 1,
        id: request.id,
        op: request.op,
        ok: true,
        result: { accepted: true, request_id: request.id },
      };
    } catch (caught) {
      return sdkFailure(request, caught, sendStarted);
    }
  } catch (caught) {
    return sdkFailure(request, caught, false);
  }
}

type RecentRequest = {
  seenAt: number;
  response?: BridgeResponse;
};

type BridgeRuntimeState = {
  busy: boolean;
  recentRequests: Map<string, RecentRequest>;
  replayGuard: PersistentReplayGuard;
};

async function connectOnce(
  config: PairingConfig,
  client: BridgeClient,
  state: BridgeRuntimeState,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(bridgeSocketUrl(config), {
      followRedirects: false,
      handshakeTimeout: 15_000,
      headers: { authorization: `Bearer ${config.relayToken}` },
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
    });
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.terminate();
      resolve();
    };
    const onAbort = (): void => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("message", (data, isBinary) => {
      void (async () => {
        let request: BridgeRequest;
        try {
          const plaintext = decryptFrame(config, "codex", textFrame(data, isBinary));
          request = bridgeRequestSchema.parse(JSON.parse(plaintext.toString("utf8")));
        } catch {
          socket.close(4400, "invalid frame");
          return;
        }

        const now = Date.now();
        for (const [id, record] of state.recentRequests) {
          if (now - record.seenAt > REQUEST_FRESHNESS_MS) state.recentRequests.delete(id);
        }
        const previous = state.recentRequests.get(request.id);
        const stale = Math.abs(now - request.issued_at_ms) > REQUEST_FRESHNESS_MS;
        if (
          stale ||
          previous !== undefined ||
          state.recentRequests.size >= MAX_RECENT_REQUESTS
        ) {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(
                encryptFrame(
                  config,
                  "bridge",
                  JSON.stringify(
                    previous?.response ??
                      responseError(
                        request,
                        "INVALID_RESPONSE",
                        request.op === "send_message" &&
                          (stale ||
                            previous !== undefined ||
                            state.recentRequests.size >= MAX_RECENT_REQUESTS),
                      ),
                  ),
                ),
                { binary: false, compress: false },
              );
            } catch {
              finish();
            }
          }
          return;
        }
        const record: RecentRequest = { seenAt: now };
        state.recentRequests.set(request.id, record);

        let response: BridgeResponse | undefined;
        if (request.op === "send_message") {
          try {
            if ((await state.replayGuard.claim(request.id, now)) === "replay") {
              response = responseError(request, "INVALID_RESPONSE", true);
            }
          } catch {
            response = responseError(request, "CONFIG_INVALID", false);
          }
        }
        response ??= state.busy
          ? responseError(request, "UNAVAILABLE", false)
          : await (async () => {
              state.busy = true;
              try {
                return await handleBridgeRequest(client, request);
              } finally {
                state.busy = false;
              }
            })();
        record.response = response;
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(encryptFrame(config, "bridge", JSON.stringify(response)), {
            binary: false,
            compress: false,
          });
        } catch {
          finish();
        }
      })();
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });
}

function waitForReconnect(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runBridge(
  config: PairingConfig,
  client: BridgeClient = createBridgeProbeClient(),
  signal?: AbortSignal,
  replayRoot?: string,
): Promise<void> {
  let attempt = 0;
  const state: BridgeRuntimeState = {
    busy: false,
    recentRequests: new Map(),
    replayGuard: await PersistentReplayGuard.open(
      config.channel,
      REQUEST_FRESHNESS_MS,
      replayRoot,
    ),
  };
  while (!signal?.aborted) {
    await connectOnce(config, client, state, signal);
    if (signal?.aborted) break;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    await waitForReconnect(delay ?? 15_000, signal);
    attempt += 1;
  }
}

async function readPairCode(): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new Error("interactive_terminal_required");
  }

  output.write("Pairing code: ");
  const wasPaused = input.isPaused();
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (caught?: Error): void => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (caught === undefined) resolve(value);
      else reject(caught);
    };
    const onData = (chunk: string | Buffer): void => {
      const text = chunk
        .toString()
        .replaceAll("\u001b[200~", "")
        .replaceAll("\u001b[201~", "");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("pairing_cancelled"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (/^[A-Za-z0-9_-]$/.test(character)) {
          if (value.length >= 4_096) {
            finish(new Error("pairing_code_too_long"));
            return;
          }
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function runUntilSignal(config: PairingConfig, client: BridgeClient): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runBridge(config, client, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runBridgeCompanion(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const command = argv[0];
  const force = argv.length === 2 && argv[1] === "--force";
  const validArgs = argv.length === 1 || (command === "connect" && force);
  if (!validArgs || !["probe", "connect", "run", "unpair"].includes(command ?? "")) {
    stderr.write(`${JSON.stringify({ error: "unsupported_command" })}\n`);
    return 2;
  }

  try {
    const createClient = dependencies.createClient ?? createBridgeProbeClient;
    if (command === "probe") {
      const result = await probeBridge(createClient());
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (command === "unpair") {
      const removed = await removePairingConfig(dependencies.configPath);
      stdout.write(`${JSON.stringify({ unpaired: removed })}\n`);
      return 0;
    }

    const config =
      command === "connect"
        ? parsePairCode(await (dependencies.readPairCode ?? readPairCode)())
        : await loadPairingConfig(dependencies.configPath);
    if (command === "connect") {
      await savePairingConfig(config, dependencies.configPath, { overwrite: force });
      stdout.write(`${JSON.stringify({ paired: true, mode: "foreground" })}\n`);
    }
    await (dependencies.runBridge ?? runUntilSignal)(config, createClient());
    return 0;
  } catch {
    stderr.write(`${JSON.stringify({ error: `${command ?? "bridge"}_failed` })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBridgeCompanion(process.argv.slice(2));
}
