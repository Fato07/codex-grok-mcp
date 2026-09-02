import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_SAND_ROOT = "/home/box/sand-data";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 50;
const MAX_STATUS_ROWS = 500;

const discoveryFileSchema = z
  .object({
    port: z.number().int().positive(),
    pid: z.number().int().positive(),
    startedAt: z.number().positive().finite(),
    scheme: z.enum(["http", "https"]).optional(),
    host: z.string().optional(),
    token: z.string().min(1).max(4_096).optional(),
  })
  .passthrough();

const healthSchema = z
  .object({ ok: z.boolean(), isBusy: z.boolean() })
  .passthrough();

const agentSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().max(512),
    isGroup: z.boolean(),
    isRunning: z.boolean().optional(),
    isComposingMessage: z.boolean().optional(),
    awaitingUserResponse: z.unknown().optional(),
    lastMessageId: z.string().min(1).max(512).nullable().optional(),
    newestEntryId: z.string().min(1).max(512).nullable().optional(),
  })
  .passthrough();

const sendResultSchema = z.object({ accepted: z.literal(true) }).passthrough();

const transcriptTailInputSchema = z
  .object({
    id: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(MAX_TRANSCRIPT_ENTRIES),
    beforeSeq: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

const transcriptTailSchema = z
  .object({
    entries: z.array(z.unknown()).max(MAX_TRANSCRIPT_ENTRIES),
    nextBeforeSeq: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();

const asyncTaskSchema = z
  .object({
    kind: z.enum(["subagent", "shell", "cloud-agent"]),
    id: z.string().min(1).max(512),
    label: z.string().max(4_096),
    status: z.literal("running"),
    startedAtMs: z.number().nonnegative().finite(),
    detail: z.string().max(16_384).optional(),
    subagentType: z.string().max(512).optional(),
  })
  .passthrough();

const subagentSchema = z
  .object({
    subagentId: z.string().min(1).max(512),
    subagentType: z.string().max(512),
    title: z.string().max(4_096),
    status: z.string().max(512),
    startedAtMs: z.number().nonnegative().finite(),
  })
  .passthrough();

const agentIdInputSchema = z.object({ id: z.string().min(1).max(512) }).strict();

export type LocalGatewayDiscovery = {
  port: number;
  pid: number;
  hasToken: boolean;
};

export type LocalGatewayHealth = z.infer<typeof healthSchema>;
export type LocalAgentSummary = z.infer<typeof agentSchema>;
export type LocalTranscriptTailInput = z.infer<typeof transcriptTailInputSchema>;
export type LocalTranscriptTail = z.infer<typeof transcriptTailSchema>;
export type LocalAsyncTask = z.infer<typeof asyncTaskSchema>;
export type LocalSubagent = z.infer<typeof subagentSchema>;
export type LocalSendPromptInput = {
  agentId: string;
  prompt: string;
  clientNonce: string;
};

export type LocalGatewayErrorCode =
  | "AUTH_FAILED"
  | "CONFIG_INVALID"
  | "GATEWAY_REJECTED"
  | "INVALID_RESPONSE"
  | "OUTPUT_LIMIT"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE";

type ResolvedGateway = LocalGatewayDiscovery & {
  baseUrl: string;
  connectHost: string;
  startedAt: number;
  token?: string;
};

type ClientOptions = {
  env?: NodeJS.ProcessEnv;
  discoveryPath?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  verifyServer?: (pid: number, port: number, host: string, startedAt: number) => boolean;
};

export class LocalGatewayError extends Error {
  readonly code: LocalGatewayErrorCode;
  readonly status: number;
  readonly requestId: string;

  constructor(code: LocalGatewayErrorCode, status: number, requestId: string) {
    super("Grok Bot gateway request failed.");
    this.name = "LocalGatewayError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

function readPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function sandRoot(env: NodeJS.ProcessEnv): string {
  if (env.SAND_DATA_ROOT !== undefined && isAbsolute(env.SAND_DATA_ROOT)) {
    return env.SAND_DATA_ROOT;
  }
  if (env.SAND_USER_DATA_DIR !== undefined && env.SAND_USER_DATA_DIR.trim() !== "") {
    const root = isAbsolute(env.SAND_USER_DATA_DIR)
      ? env.SAND_USER_DATA_DIR
      : resolve(env.SAND_USER_DATA_DIR);
    return join(root, "sand-data");
  }
  return DEFAULT_SAND_ROOT;
}

function readDiscovery(path: string): z.infer<typeof discoveryFileSchema> | undefined {
  try {
    const details = lstatSync(path);
    const parent = lstatSync(dirname(path));
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.size > 64 * 1024 ||
      (details.mode & 0o077) !== 0 ||
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      (parent.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        (details.uid !== process.getuid() || parent.uid !== process.getuid()))
    ) {
      return undefined;
    }
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) return undefined;
    return discoveryFileSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function expectedLinuxAddress(host: string): { table: string; values: Set<string> } | undefined {
  if (host === "::1") {
    return {
      table: "/proc/net/tcp6",
      values: new Set(["00000000000000000000000001000000", "00000000000000000000000000000000"]),
    };
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return undefined;
  return {
    table: "/proc/net/tcp",
    values: new Set([
      octets
        .reverse()
        .map((octet) => octet.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase(),
      "00000000",
    ]),
  };
}

let cachedLinuxTiming: { bootTime: number; clockTicks: number } | undefined;

function linuxTiming(): { bootTime: number; clockTicks: number } | undefined {
  if (cachedLinuxTiming !== undefined) return cachedLinuxTiming;
  try {
    const bootTime = Number(
      /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1],
    );
    const clockTicks = Number(
      execFileSync("/usr/bin/getconf", ["CLK_TCK"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim(),
    );
    if (!Number.isFinite(bootTime) || !Number.isFinite(clockTicks) || clockTicks <= 0) {
      return undefined;
    }
    cachedLinuxTiming = { bootTime, clockTicks };
    return cachedLinuxTiming;
  } catch {
    return undefined;
  }
}

function linuxProcessStartEpochMs(pid: number): number | undefined {
  try {
    const timing = linuxTiming();
    if (timing === undefined) return undefined;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return undefined;
    return timing.bootTime * 1_000 + (startTicks / timing.clockTicks) * 1_000;
  } catch {
    return undefined;
  }
}

function linuxPidOwnsListeningPort(
  pid: number,
  port: number,
  host: string,
  descriptorStartedAt: number,
): boolean {
  if (process.platform !== "linux") return false;
  try {
    const processStartedAt = linuxProcessStartEpochMs(pid);
    if (
      processStartedAt === undefined ||
      descriptorStartedAt > Date.now() + 5_000 ||
      processStartedAt > descriptorStartedAt + 5_000
    ) {
      return false;
    }
    const expected = expectedLinuxAddress(host);
    if (expected === undefined) return false;
    const socketInodes = new Set<string>();
    for (const descriptor of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match?.[1] !== undefined) socketInodes.add(match[1]);
      } catch {
        // Descriptors may close while the directory is read.
      }
    }
    if (socketInodes.size === 0) return false;

    const lines = readFileSync(expected.table, "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1];
      const state = fields[3];
      const inode = fields[9];
      const [addressHex, portHex] = localAddress?.split(":") ?? [];
      if (
        state === "0A" &&
        inode !== undefined &&
        addressHex !== undefined &&
        expected.values.has(addressHex) &&
        portHex !== undefined &&
        Number.parseInt(portHex, 16) === port &&
        socketInodes.has(inode)
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function parseLoopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalGatewayError("CONFIG_INVALID", 0, "");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopback(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new LocalGatewayError("CONFIG_INVALID", 0, "");
  }
  return url;
}

function resolveGateway(options: ClientOptions): ResolvedGateway {
  const env = options.env ?? process.env;
  const file = readDiscovery(options.discoveryPath ?? join(sandRoot(env), "gateway.json"));
  const override = env.GROKBOT_GATEWAY_URL?.trim() || env.SAND_GATEWAY_URL?.trim();
  const url = override === undefined || override === "" ? undefined : parseLoopbackUrl(override);
  const hostValue =
    url?.hostname ?? env.SAND_GATEWAY_BIND_HOST?.trim() ?? file?.host?.trim() ?? "127.0.0.1";
  const host =
    hostValue.toLowerCase() === "localhost" || ["0.0.0.0", "::", "[::]"].includes(hostValue)
      ? "127.0.0.1"
      : hostValue;
  if (!isLoopback(host)) throw new LocalGatewayError("CONFIG_INVALID", 0, "");
  const scheme = url !== undefined ? url.protocol.slice(0, -1) : (file?.scheme ?? "http");
  const port =
    (url === undefined
      ? readPort(env.SAND_HOST_PORT) ?? file?.port
      : readPort(url.port) ?? (url.protocol === "https:" ? 443 : 80));
  if (port === undefined) throw new LocalGatewayError("CONFIG_INVALID", 0, "");
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const token = env.SAND_GATEWAY_TOKEN?.trim() || file?.token;
  if (token !== undefined && (token.length > 4_096 || /[\u0000-\u0020\u007f]/.test(token))) {
    throw new LocalGatewayError("CONFIG_INVALID", 0, "");
  }
  return {
    baseUrl: `${scheme}://${authority}:${port}`,
    connectHost: host,
    startedAt: file?.startedAt ?? 0,
    port,
    pid: file?.pid ?? 0,
    hasToken: token !== undefined && token !== "",
    ...(token === undefined || token === "" ? {} : { token }),
  };
}

export class LocalGrokBotClient {
  readonly #fetch: typeof fetch;
  readonly #gateway: ResolvedGateway;
  readonly #timeoutMs: number;
  readonly #verifyServer: (
    pid: number,
    port: number,
    host: string,
    startedAt: number,
  ) => boolean;

  constructor(options: ClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#gateway = resolveGateway(options);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#verifyServer = options.verifyServer ?? linuxPidOwnsListeningPort;
    if (
      !this.#verifyServer(
        this.#gateway.pid,
        this.#gateway.port,
        this.#gateway.connectHost,
        this.#gateway.startedAt,
      )
    ) {
      throw new LocalGatewayError("CONFIG_INVALID", 0, "");
    }
  }

  discovery(): LocalGatewayDiscovery {
    return {
      port: this.#gateway.port,
      pid: this.#gateway.pid,
      hasToken: this.#gateway.hasToken,
    };
  }

  async health(): Promise<LocalGatewayHealth> {
    return await this.#request("GET", "/health", undefined, false, healthSchema);
  }

  async listAgents(): Promise<LocalAgentSummary[]> {
    return await this.#request(
      "POST",
      "/api/listAgents",
      {},
      true,
      z.array(agentSchema).max(500),
    );
  }

  async sendPrompt(input: LocalSendPromptInput): Promise<{ accepted: true }> {
    return await this.#request(
      "POST",
      "/api/sendPrompt",
      {
        agentId: input.agentId,
        prompt: input.prompt,
        clientNonce: input.clientNonce,
      },
      true,
      sendResultSchema,
    );
  }

  async getAgentTranscriptTail(input: LocalTranscriptTailInput): Promise<LocalTranscriptTail> {
    const body = transcriptTailInputSchema.safeParse(input);
    if (!body.success) throw new LocalGatewayError("CONFIG_INVALID", 0, "");
    return await this.#request(
      "POST",
      "/api/getAgentTranscriptTail",
      body.data,
      true,
      transcriptTailSchema,
    );
  }

  async getAsyncTasks(input: { id: string }): Promise<LocalAsyncTask[]> {
    const body = agentIdInputSchema.safeParse(input);
    if (!body.success) throw new LocalGatewayError("CONFIG_INVALID", 0, "");
    return await this.#request(
      "POST",
      "/api/getAsyncTasks",
      body.data,
      true,
      z.array(asyncTaskSchema).max(MAX_STATUS_ROWS),
    );
  }

  async getSubagents(input: { id: string }): Promise<LocalSubagent[]> {
    const body = agentIdInputSchema.safeParse(input);
    if (!body.success) throw new LocalGatewayError("CONFIG_INVALID", 0, "");
    return await this.#request(
      "POST",
      "/api/getSubagents",
      body.data,
      true,
      z.array(subagentSchema).max(MAX_STATUS_ROWS),
    );
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    authenticated: boolean,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const requestId = randomUUID();
    if (
      !this.#verifyServer(
        this.#gateway.pid,
        this.#gateway.port,
        this.#gateway.connectHost,
        this.#gateway.startedAt,
      )
    ) {
      throw new LocalGatewayError("CONFIG_INVALID", 0, requestId);
    }
    if (authenticated && this.#gateway.token === undefined) {
      throw new LocalGatewayError("AUTH_FAILED", 401, requestId);
    }
    const headers = new Headers({
      "x-sand-request-id": requestId,
      "x-sand-slim-avatars": "1",
    });
    if (authenticated) headers.set("authorization", `Bearer ${this.#gateway.token}`);
    let encodedBody: string | undefined;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      encodedBody = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    try {
      const response = await this.#fetch(`${this.#gateway.baseUrl}${path}`, {
        method,
        headers,
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        redirect: "error",
        signal: controller.signal,
      });
      if (
        !this.#verifyServer(
          this.#gateway.pid,
          this.#gateway.port,
          this.#gateway.connectHost,
          this.#gateway.startedAt,
        )
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalGatewayError("CONFIG_INVALID", 0, requestId);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const code =
          response.status === 401 || response.status === 403
            ? "AUTH_FAILED"
            : response.status === 429
              ? "RATE_LIMITED"
              : "GATEWAY_REJECTED";
        throw new LocalGatewayError(code, response.status, requestId);
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalGatewayError("OUTPUT_LIMIT", 0, requestId);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new LocalGatewayError("OUTPUT_LIMIT", 0, requestId);
          }
          chunks.push(value);
        }
      }
      const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      let parsed: unknown;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        throw new LocalGatewayError("INVALID_RESPONSE", 0, requestId);
      }
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new LocalGatewayError("INVALID_RESPONSE", 0, requestId);
      }
      return validated.data;
    } catch (caught) {
      if (caught instanceof LocalGatewayError) throw caught;
      throw new LocalGatewayError(
        controller.signal.aborted ? "TIMEOUT" : "UNAVAILABLE",
        0,
        requestId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
