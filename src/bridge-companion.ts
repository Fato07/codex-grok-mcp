#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalGatewayError,
  LocalGrokBotClient,
  TestRealDataRootError,
  type LocalAgentSummary,
  type LocalAttachmentChunk,
  type LocalGatewayDiscovery,
  type LocalGatewayHealth,
  type LocalHostStatus,
  type LocalSendPromptInput,
  type LocalUploadAttachmentResult,
} from "./grok-bot-client.js";
import WebSocket, { type RawData } from "ws";
import {
  bridgeRequestSchema,
  bridgeResponseSchema,
  createBridgeReadSnapshot,
  type BridgeErrorCode,
  type BridgeErrorReason,
  type BridgeRequest,
  type BridgeResponse,
} from "./bridge-protocol.js";
import {
  BridgePairingError,
  canonicalBridgeConfigPath,
  decryptFrame,
  defaultBridgeConfigPath,
  encryptFrame,
  loadPairingConfig,
  parsePairCode,
  removePairingConfig,
  savePairingConfig,
  type PairingConfig,
} from "./bridge-pairing.js";
import { PersistentReplayGuard } from "./bridge-replay.js";
import {
  BridgeLifecycle,
  BridgeLifecycleError,
  type LifecycleCommand,
  type LifecycleResult,
} from "./bridge-lifecycle.js";
import { BridgeRuntimeError, CompanionLease } from "./bridge-runtime.js";
import {
  BRIDGE_ADVERTISED_PROTOCOL_VERSIONS,
  BRIDGE_ATTACHMENT_CAPABILITIES,
  BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL_VERSIONS,
  BRIDGE_STATUS_PROTOCOL_VERSION,
  CODEX_GROK_VERSION,
} from "./version.js";
import {
  AttachmentError,
  attachmentExtension,
  attachmentSessionStore,
  assertAttachmentBotId,
  committedHostPathIsValid,
  decodeChunkBytes,
  defaultAttachmentStagingRoot,
  extractTranscriptAttachments,
  fetchSizeCap,
  isAttachmentHostAllowed,
  openConfinedBotAttachment,
  sandRootForAttachments,
  toPublicAttachmentMeta,
} from "./attachments.js";

const PROBE_TIMEOUT_MS = 5_000;
const BRIDGE_GATEWAY_TIMEOUT_MS = 10_000;
const MAX_RELAY_FRAME_BYTES = 128 * 1024;
const FRAME_AUTH_FAILED_CLOSE_CODE = 4401;
const REQUEST_FRESHNESS_MS = 60_000;
const REPLAY_RETENTION_MS = REQUEST_FRESHNESS_MS * 2;
const MAX_RECENT_REQUESTS = 1_024;
export const RELAY_PING_INTERVAL_MS = 30_000;
export const RELAY_PONG_DEADLINE_MS = 10_000;
export const RELAY_HEALTHY_UPTIME_MS = 10_000;
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export type RunBridgeOptions = {
  pingIntervalMs?: number;
  pongDeadlineMs?: number;
  healthyUptimeMs?: number;
  reconnectDelaysMs?: readonly number[];
};

export type BridgeProbeClient = {
  discovery(): Pick<LocalGatewayDiscovery, "port" | "pid" | "hasToken">;
  health(): Promise<Pick<LocalGatewayHealth, "ok" | "isBusy">>;
  listAgents(): Promise<
    Array<
      Pick<
        LocalAgentSummary,
        | "awaitingUserResponse"
        | "id"
        | "isComposingMessage"
        | "isGroup"
        | "isRunning"
        | "name"
      >
    >
  >;
};

export type BridgeClient = BridgeProbeClient & {
  withGatewaySnapshot?<T>(operation: () => Promise<T>): Promise<T>;
  getAgentTranscriptTail(input: {
    id: string;
    limit: number;
    beforeSeq?: number;
  }): Promise<{ entries: unknown[]; nextBeforeSeq?: number | undefined }>;
  getAsyncTasks(input: { id: string }): Promise<unknown[]>;
  getSubagents(input: { id: string }): Promise<Array<{ status: string }>>;
  sendPrompt(input: LocalSendPromptInput): Promise<{ accepted: true }>;
  getHostStatus?(input?: { includeManagedCapabilities?: boolean }): Promise<Pick<LocalHostStatus, "hostVersion">>;
  uploadAttachment?(input: {
    agentId: string;
    filename: string;
    bytesBase64: string;
  }): Promise<LocalUploadAttachmentResult>;
  readAttachmentChunk?(input: {
    agentId: string;
    path: string;
    offset: number;
    length: number;
  }): Promise<LocalAttachmentChunk | null>;
};

export type BridgeRequestContext = {
  stagingRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  resolveOpenedFd?: (fd: number) => string;
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
  environment?: NodeJS.ProcessEnv;
  lifecycle?: { run(command: LifecycleCommand): Promise<LifecycleResult> };
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
  commitMayHaveOccurred?: boolean,
  reason?: BridgeErrorReason,
): BridgeResponse {
  return {
    v: request.v,
    id: request.id,
    ok: false,
    error: {
      code,
      delivery_may_have_occurred: deliveryMayHaveOccurred,
      ...(commitMayHaveOccurred === undefined
        ? {}
        : { commit_may_have_occurred: commitMayHaveOccurred }),
      ...(requestId === undefined || requestId === "" ? {} : { request_id: requestId }),
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function sdkFailure(
  request: BridgeRequest,
  caught: unknown,
  sendStarted: boolean,
  commitMayHaveOccurred?: boolean,
): BridgeResponse {
  if (caught instanceof TestRealDataRootError) throw caught;
  if (caught instanceof AttachmentError) {
    return responseError(request, caught.code, sendStarted, undefined, commitMayHaveOccurred);
  }
  if (!(caught instanceof LocalGatewayError)) {
    return responseError(request, "UNAVAILABLE", sendStarted, undefined, commitMayHaveOccurred);
  }
  const code: BridgeErrorCode = caught.code;
  return responseError(
    request,
    code,
    sendStarted,
    caught.requestId,
    commitMayHaveOccurred,
    caught.reason === "GATEWAY_ENV_MISMATCH" ? "GATEWAY_ENV_MISMATCH" : undefined,
  );
}

export async function handleBridgeRequest(
  client: BridgeClient,
  request: BridgeRequest,
  context: BridgeRequestContext = {},
): Promise<BridgeResponse> {
  try {
    return await (client.withGatewaySnapshot === undefined
      ? handleBridgeRequestWithGateway(client, request, context)
      : client.withGatewaySnapshot(() =>
          handleBridgeRequestWithGateway(client, request, context),
        ));
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    return sdkFailure(request, caught, false);
  }
}

function requestContext(context: BridgeRequestContext): {
  env: NodeJS.ProcessEnv;
  store: ReturnType<typeof attachmentSessionStore>;
} {
  const env = context.env ?? process.env;
  return {
    env,
    store: attachmentSessionStore(
      context.stagingRoot ?? defaultAttachmentStagingRoot(env),
      context.now,
    ),
  };
}

async function attachmentCapabilityError(
  client: BridgeClient,
  request: BridgeRequest,
  env: NodeJS.ProcessEnv,
): Promise<BridgeResponse | undefined> {
  try {
    if (client.getHostStatus === undefined) return responseError(request, "UPGRADE_REQUIRED", false);
    const host = await client.getHostStatus();
    if (isAttachmentHostAllowed(host.hostVersion, env) === false) {
      return responseError(request, "UPGRADE_REQUIRED", false);
    }
    return undefined;
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    if (caught instanceof LocalGatewayError && caught.status === 404) {
      return responseError(request, "UPGRADE_REQUIRED", false);
    }
    if (caught instanceof LocalGatewayError) return sdkFailure(request, caught, false);
    return responseError(request, "UPGRADE_REQUIRED", false);
  }
}

async function handleBridgeRequestWithGateway(
  client: BridgeClient,
  request: BridgeRequest,
  context: BridgeRequestContext,
): Promise<BridgeResponse> {
  const { env, store } = requestContext(context);
  if (request.op === "status") {
    const [health, agents] = await Promise.all([client.health(), client.listAgents()]);
    let extraCapabilities: string[] = [];
    try {
      if (client.getHostStatus !== undefined) {
        const host = await client.getHostStatus();
        if (isAttachmentHostAllowed(host.hostVersion, env)) {
          extraCapabilities = [...BRIDGE_ATTACHMENT_CAPABILITIES];
        }
      }
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
    }
    return bridgeResponseSchema.parse({
      v: BRIDGE_STATUS_PROTOCOL_VERSION,
      id: request.id,
      op: request.op,
      ok: true,
      result: {
        companion_version: CODEX_GROK_VERSION,
        supported_protocol_versions: [...BRIDGE_ADVERTISED_PROTOCOL_VERSIONS],
        capabilities: [...BRIDGE_CAPABILITIES, ...extraCapabilities],
        gateway_healthy: health.ok,
        gateway_busy: health.isBusy,
        non_group_bot_count: agents.filter((agent) => !agent.isGroup).length,
      },
    });
  }

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
  if (
    request.op === "attachment_stage" ||
    request.op === "attachment_commit" ||
    request.op === "attachment_fetch" ||
    (request.op === "send_message" && request.args.attachment_refs !== undefined)
  ) {
    try {
      assertAttachmentBotId(bot.id);
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
      return responseError(request, "ATTACHMENT_REJECTED", false);
    }
  }

  if (request.op === "read_bot") {
    const agent = agents.find((candidate) => candidate.id === bot.id);
    if (agent === undefined) return responseError(request, "BOT_NOT_FOUND", false);
    const [tail, tasks, subagents] = await Promise.all([
      client.getAgentTranscriptTail({
        id: bot.id,
        limit: request.args.limit,
        ...(request.args.before_sequence === undefined
          ? {}
          : { beforeSeq: request.args.before_sequence }),
      }),
      client.getAsyncTasks({ id: bot.id }),
      client.getSubagents({ id: bot.id }),
    ]);
    if (tail.entries.length > request.args.limit) {
      return responseError(request, "INVALID_RESPONSE", false);
    }
    const snapshot = createBridgeReadSnapshot({
      bot_id: bot.id,
      is_running: bot.is_running,
      is_composing: agent.isComposingMessage ?? null,
      awaiting_user:
        agent.awaitingUserResponse === undefined
          ? null
          : agent.awaitingUserResponse !== null && agent.awaitingUserResponse !== false,
      async_task_count: tasks.length,
      running_subagent_count: subagents.filter(({ status }) => status === "running").length,
      entries: tail.entries,
      next_before_sequence: tail.nextBeforeSeq ?? null,
    });
    if (request.v !== BRIDGE_ATTACHMENT_PROTOCOL_VERSION) {
      return bridgeResponseSchema.parse({
        v: 2,
        id: request.id,
        op: request.op,
        ok: true,
        result: snapshot,
      });
    }
    return bridgeResponseSchema.parse({
      v: BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
      id: request.id,
      op: request.op,
      ok: true,
      result: {
        ...snapshot,
        attachments: extractTranscriptAttachments(tail.entries, bot.id).map(toPublicAttachmentMeta),
      },
    });
  }

  if (
    request.op === "attachment_stage" ||
    request.op === "attachment_commit" ||
    request.op === "attachment_fetch" ||
    (request.op === "send_message" && request.args.attachment_refs !== undefined)
  ) {
    const gated = await attachmentCapabilityError(client, request, env);
    if (gated !== undefined) return gated;
  }

  if (request.op === "attachment_stage") {
    const staged = store.stage({
      uploadId: request.args.upload_id,
      botId: bot.id,
      name: request.args.name,
      mime: request.args.mime,
      totalSize: request.args.total_size,
      sha256: request.args.sha256,
      seq: request.args.seq,
      offset: request.args.offset,
      bytes: decodeChunkBytes(request.args.bytes_b64),
    });
    return bridgeResponseSchema.parse({
      v: BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
      id: request.id,
      op: request.op,
      ok: true,
      result: {
        state: "staged",
        upload_id: request.args.upload_id,
        received_bytes: staged.received,
        total_size: staged.totalSize,
        complete: staged.complete,
      },
    });
  }

  if (request.op === "attachment_commit") {
    const completed = store.takeComplete(request.args.upload_id, bot.id);
    const fresh = await client.listAgents();
    if (fresh.some((agent) => agent.isGroup === false && agent.id === bot.id) === false) {
      return responseError(request, "ATTACHMENT_STALE", false);
    }
    if (client.uploadAttachment === undefined) return responseError(request, "UPGRADE_REQUIRED", false);
    let commitStarted = false;
    try {
      commitStarted = true;
      const uploaded = await client.uploadAttachment({
        agentId: bot.id,
        filename: completed.record.name,
        bytesBase64: completed.bytes.toString("base64"),
      });
      const extension = attachmentExtension(completed.record.name);
      if (
        committedHostPathIsValid(
          uploaded.path,
          bot.id,
          completed.record.sha256,
          extension,
          sandRootForAttachments(env),
        ) === false
      ) {
        return responseError(request, "ATTACHMENT_INTEGRITY", false, undefined, true);
      }
      const attachmentRef = store.rememberCommit(completed.record, uploaded.path);
      return bridgeResponseSchema.parse({
        v: BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
        id: request.id,
        op: request.op,
        ok: true,
        result: { state: "committed", attachment_ref: attachmentRef },
      });
    } catch (caught) {
      return sdkFailure(request, caught, false, commitStarted);
    }
  }

  if (request.op === "attachment_fetch") {
    const tail = await client.getAgentTranscriptTail({ id: bot.id, limit: 50 });
    const located = extractTranscriptAttachments(tail.entries, bot.id).find(
      (entry) => entry.entry_id === request.args.entry_id,
    );
    if (located === undefined) return responseError(request, "ATTACHMENT_STALE", false);
    if (located.fetchable === false || located.path === undefined || located.kind === "external") {
      return responseError(request, "ATTACHMENT_REJECTED", false);
    }
    const cached = store.lookupFetch(bot.id, located.entry_id);
    const confined =
      cached === undefined
        ? openConfinedBotAttachment(
            located.path,
            bot.id,
            sandRootForAttachments(env),
            fetchSizeCap(located.kind),
            located.name,
            context.resolveOpenedFd,
          )
        : undefined;
    if (confined !== undefined) {
      store.rememberFetch({
        botId: bot.id,
        entryId: located.entry_id,
        sha256: confined.sha256,
        mime: confined.mime,
        name: located.name,
        bytes: confined.bytes,
        createdAt: store.now(),
      });
    }
    const bytes = cached?.bytes ?? confined?.bytes;
    const digest = cached?.sha256 ?? confined?.sha256;
    const mime = cached?.mime ?? confined?.mime;
    if (bytes === undefined || digest === undefined || mime === undefined) {
      return responseError(request, "ATTACHMENT_STALE", false);
    }
    const window = bytes.subarray(request.args.offset, request.args.offset + request.args.length);
    if (window.length === 0) return responseError(request, "ATTACHMENT_REJECTED", false);
    return bridgeResponseSchema.parse({
      v: BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
      id: request.id,
      op: request.op,
      ok: true,
      result: {
        bytes_b64: window.toString("base64"),
        total_size: bytes.length,
        sha256: digest,
        mime,
        name: located.name,
        truncated: request.args.offset > 0 || request.args.offset + window.length < bytes.length,
      },
    });
  }

  let sendStarted = false;
  try {
    const attachmentRefs = request.op === "send_message" ? request.args.attachment_refs : undefined;
    const committed =
      attachmentRefs === undefined ? undefined : store.lookup(attachmentRefs[0], bot.id);
    sendStarted = true;
    const receipt = await client.sendPrompt({
      agentId: bot.id,
      prompt: request.args.message,
      clientNonce: request.id,
      ...(committed === undefined
        ? {}
        : {
            attachmentPaths: [committed.path],
            attachmentNames: [committed.name],
          }),
    });
    if (receipt.accepted !== true) return responseError(request, "INVALID_RESPONSE", true);
    return {
      v: request.v,
      id: request.id,
      op: request.op,
      ok: true,
      result: { accepted: true, request_id: request.id },
    };
  } catch (caught) {
    return sdkFailure(request, caught, sendStarted);
  }
}

type RecentRequest = {
  seenAt: number;
  response?: BridgeResponse;
};

type BridgeRuntimeState = {
  activeHandlers: Set<Promise<void>>;
  busy: boolean;
  recentRequests: Map<string, RecentRequest>;
  replayGuard: PersistentReplayGuard;
  requestContext: BridgeRequestContext;
};

async function connectOnce(
  config: PairingConfig,
  client: BridgeClient,
  state: BridgeRuntimeState,
  signal: AbortSignal | undefined,
  liveness: { pingIntervalMs: number; pongDeadlineMs: number; healthyUptimeMs: number },
): Promise<boolean> {
  if (signal?.aborted) return false;
  let provenHealthy = false;
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(bridgeSocketUrl(config), {
      followRedirects: false,
      handshakeTimeout: 15_000,
      headers: { authorization: `Bearer ${config.relayToken}` },
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
    });
    let settled = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let healthyTimer: ReturnType<typeof setTimeout> | undefined;

    const clearLiveness = (): void => {
      if (pingTimer !== undefined) clearInterval(pingTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (healthyTimer !== undefined) clearTimeout(healthyTimer);
      pingTimer = undefined;
      deadlineTimer = undefined;
      healthyTimer = undefined;
    };
    const markHealthy = (): void => {
      provenHealthy = true;
    };
    const noteInbound = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const armDeadline = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => finish(), liveness.pongDeadlineMs);
    };
    const startLiveness = (): void => {
      healthyTimer = setTimeout(markHealthy, liveness.healthyUptimeMs);
      pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          finish();
          return;
        }
        try {
          socket.ping();
        } catch {
          finish();
          return;
        }
        armDeadline();
      }, liveness.pingIntervalMs);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearLiveness();
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.terminate();
      } catch {
        // CONNECTING terminate emits or throws on some Node/ws pairs.
      }
      resolve();
    };
    const onAbort = (): void => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("open", startLiveness);
    socket.on("pong", () => {
      noteInbound();
      markHealthy();
    });
    socket.on("ping", noteInbound);

    socket.on("message", (data, isBinary) => {
      noteInbound();
      if (settled || signal?.aborted) return;
      const handler = (async () => {
        let request: BridgeRequest;
        try {
          const plaintext = decryptFrame(config, "codex", textFrame(data, isBinary));
          request = bridgeRequestSchema.parse(JSON.parse(plaintext.toString("utf8")));
          markHealthy();
        } catch (caught) {
          const authenticationFailed =
            caught instanceof BridgePairingError && caught.code === "frame_auth_failed";
          socket.close(
            authenticationFailed ? FRAME_AUTH_FAILED_CLOSE_CODE : 4400,
            authenticationFailed ? "authentication failed" : "invalid frame",
          );
          return;
        }

        const now = Date.now();
        for (const [id, record] of state.recentRequests) {
          if (now - record.seenAt > REPLAY_RETENTION_MS) state.recentRequests.delete(id);
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
                return await handleBridgeRequest(client, request, state.requestContext);
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
      state.activeHandlers.add(handler);
      void handler.then(
        () => state.activeHandlers.delete(handler),
        () => {
          state.activeHandlers.delete(handler);
          finish();
        },
      );
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });
  return provenHealthy;
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
  onReady?: () => Promise<void>,
  requestContext: BridgeRequestContext = {},
  options: RunBridgeOptions = {},
): Promise<void> {
  let attempt = 0;
  const pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
  const pongDeadlineMs = options.pongDeadlineMs ?? RELAY_PONG_DEADLINE_MS;
  const healthyUptimeMs = options.healthyUptimeMs ?? RELAY_HEALTHY_UPTIME_MS;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const state: BridgeRuntimeState = {
    activeHandlers: new Set(),
    busy: false,
    recentRequests: new Map(),
    replayGuard: await PersistentReplayGuard.open(
      config.channel,
      REPLAY_RETENTION_MS,
      replayRoot,
    ),
    requestContext,
  };
  await onReady?.();
  try {
    while (!signal?.aborted) {
      const established = await connectOnce(config, client, state, signal, {
        pingIntervalMs,
        pongDeadlineMs,
        healthyUptimeMs,
      });
      if (signal?.aborted) break;
      if (established) attempt = 0;
      const delay = reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)];
      await waitForReconnect(delay ?? 15_000, signal);
      attempt += 1;
    }
  } finally {
    await Promise.allSettled(state.activeHandlers);
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

async function runUntilSignal(
  config: PairingConfig,
  client: BridgeClient,
  onReady?: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runBridge(config, client, controller.signal, undefined, onReady);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

type ManagedEnvironment = {
  configPath: string;
  integrity: string;
  readyNonce: string;
  readyPath: string;
};

function managedEnvironment(environment: NodeJS.ProcessEnv): ManagedEnvironment {
  const configPath = environment.CODEX_GROK_MANAGED_CONFIG_PATH;
  const integrity = environment.CODEX_GROK_MANAGED_INTEGRITY;
  const readyNonce = environment.CODEX_GROK_MANAGED_READY_NONCE;
  const readyPath = environment.CODEX_GROK_MANAGED_READY_PATH;
  if (
    configPath === undefined ||
    readyPath === undefined ||
    !isAbsolute(configPath) ||
    !isAbsolute(readyPath) ||
    /[\u0000-\u001f\u007f]/.test(configPath) ||
    /[\u0000-\u001f\u007f]/.test(readyPath) ||
    integrity === undefined ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
    readyNonce === undefined ||
    !/^[A-Za-z0-9_-]{43}$/.test(readyNonce) ||
    Buffer.from(readyNonce, "base64url").length !== 32
  ) {
    throw new Error("invalid_managed_environment");
  }
  return {
    configPath: canonicalBridgeConfigPath(configPath),
    integrity,
    readyNonce,
    readyPath: resolve(readyPath),
  };
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("managed_linux_required");
  return process.getuid();
}

async function writeManagedReady(path: string, nonce: string): Promise<void> {
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  if (
    parentDetails.isSymbolicLink() ||
    !parentDetails.isDirectory() ||
    parentDetails.uid !== currentUid() ||
    (parentDetails.mode & 0o7777) !== 0o700
  ) {
    throw new Error("invalid_ready_directory");
  }
  const temporaryPath = join(parent, `.ready-${process.pid}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(
      `${JSON.stringify({
        ok: true,
        version: CODEX_GROK_VERSION,
        protocol_versions: [...BRIDGE_PROTOCOL_VERSIONS],
        nonce,
      })}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (caught) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw caught;
  }
}

async function runManagedPreflight(
  environment: NodeJS.ProcessEnv,
  createClient: () => BridgeClient,
  stdout: Writer,
): Promise<number> {
  const configPath = environment.CODEX_GROK_MANAGED_CONFIG_PATH;
  if (configPath === undefined || !isAbsolute(configPath)) {
    throw new Error("invalid_managed_environment");
  }
  await loadPairingConfig(canonicalBridgeConfigPath(configPath));
  await probeBridge(createClient());
  stdout.write(
    `${JSON.stringify({
      ok: true,
      version: CODEX_GROK_VERSION,
      protocol_versions: [...BRIDGE_PROTOCOL_VERSIONS],
    })}\n`,
  );
  return 0;
}

async function runManagedWorker(
  environment: NodeJS.ProcessEnv,
  createClient: () => BridgeClient,
): Promise<number> {
  const managed = managedEnvironment(environment);
  const config = await loadPairingConfig(managed.configPath);
  const client = createClient();
  await probeBridge(client);
  const lease = await CompanionLease.acquire(managed.configPath, {
    companionVersion: CODEX_GROK_VERSION,
    launchToken: managed.readyNonce,
    protocolVersions: BRIDGE_PROTOCOL_VERSIONS,
    releaseIntegrity: managed.integrity,
  });
  try {
    await runUntilSignal(config, client, () =>
      writeManagedReady(managed.readyPath, managed.readyNonce),
    );
    return 0;
  } finally {
    await lease.release();
  }
}

export async function runBridgeCompanion(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = dependencies.environment ?? process.env;
  const command = argv[0];
  const force = argv.length === 2 && argv[1] === "--force";
  const lifecycleCommands: LifecycleCommand[] = [
    "install",
    "start",
    "status",
    "stop",
    "restart",
    "update",
    "rollback",
    "ensure",
    "uninstall",
  ];
  const internalCommands = ["_managed-preflight", "_managed-run"];
  const validArgs = argv.length === 1 || (command === "connect" && force);
  if (
    !validArgs ||
    ![
      "probe",
      "connect",
      "run",
      "unpair",
      ...lifecycleCommands,
      ...internalCommands,
    ].includes(command ?? "")
  ) {
    stderr.write(`${JSON.stringify({ error: "unsupported_command" })}\n`);
    return 2;
  }

  try {
    const createClient = dependencies.createClient ?? createBridgeProbeClient;
    if (command === "_managed-preflight") {
      return await runManagedPreflight(environment, createClient, stdout);
    }
    if (command === "_managed-run") {
      return await runManagedWorker(environment, createClient);
    }
    if (command === "probe") {
      const result = await probeBridge(createClient());
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const configPath = canonicalBridgeConfigPath(
      dependencies.configPath ?? defaultBridgeConfigPath(),
    );
    if (lifecycleCommands.includes(command as LifecycleCommand)) {
      const lifecycle =
        dependencies.lifecycle ?? new BridgeLifecycle({ configPath });
      const result = await lifecycle.run(command as LifecycleCommand);
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const lease = await CompanionLease.acquire(configPath);
    try {
      if (command === "unpair") {
        const removed = await removePairingConfig(configPath);
        stdout.write(`${JSON.stringify({ unpaired: removed })}\n`);
        return 0;
      }

      const config =
        command === "connect"
          ? parsePairCode(await (dependencies.readPairCode ?? readPairCode)())
          : await loadPairingConfig(configPath);
      if (command === "connect") {
        await savePairingConfig(config, configPath, { overwrite: force });
        stdout.write(`${JSON.stringify({ paired: true, mode: "foreground" })}\n`);
      }
      await (dependencies.runBridge ?? runUntilSignal)(config, createClient());
      return 0;
    } finally {
      await lease.release();
    }
  } catch (caught) {
    const error =
      caught instanceof BridgeLifecycleError
        ? caught.code
        : caught instanceof BridgeRuntimeError
        ? caught.code
        : caught instanceof TestRealDataRootError
          ? "CONFIG_INVALID"
        : caught instanceof LocalGatewayError
          ? caught.code
          : `${command ?? "bridge"}_failed`;
    const reason =
      caught instanceof TestRealDataRootError
        ? caught.reason
        : caught instanceof LocalGatewayError && caught.reason !== undefined
        ? caught.reason
        : caught instanceof BridgeLifecycleError && caught.reason !== undefined
          ? caught.reason
          : undefined;
    stderr.write(
      `${JSON.stringify({ error, ...(reason === undefined ? {} : { reason }) })}\n`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBridgeCompanion(process.argv.slice(2));
}
