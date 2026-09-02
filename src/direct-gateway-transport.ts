import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GrokBotGatewayError,
  type GrokBotGatewayErrorCode,
  type GrokBotSummary,
  type GrokBotTransport,
} from "./grok-bot-gateway.js";
import { createBridgeReadSnapshot, MAX_READ_BOT_MESSAGES } from "./bridge-protocol.js";

const GATEWAY_TIMEOUT_MS = 10_000;
const MAX_GATEWAY_RESPONSE_BYTES = 1024 * 1024;
const MAX_ROSTER_BOTS = 500;

export type DirectGatewayConfig = {
  baseUrl: string;
  token: string;
};

const rawBotSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(512),
    isRunning: z.boolean().optional(),
    isComposingMessage: z.boolean().optional(),
    awaitingUserResponse: z.unknown().optional(),
    isGroup: z.boolean().optional(),
  })
  .passthrough();

const rawRosterSchema = z.array(rawBotSchema).max(MAX_ROSTER_BOTS);
const sendPromptResponseSchema = z.object({ accepted: z.literal(true) }).passthrough();
const transcriptTailSchema = z
  .object({
    entries: z.array(z.unknown()).max(MAX_READ_BOT_MESSAGES),
    nextBeforeSeq: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();
const asyncTasksSchema = z
  .array(z.object({ status: z.literal("running") }).passthrough())
  .max(MAX_ROSTER_BOTS);
const subagentsSchema = z
  .array(z.object({ status: z.string() }).passthrough())
  .max(MAX_ROSTER_BOTS);

type GatewayCommand =
  | "getAgentTranscriptTail"
  | "getAsyncTasks"
  | "getSubagents"
  | "listAgents"
  | "sendPrompt";

function error(
  code: GrokBotGatewayErrorCode,
  message: string,
  options: { deliveryMayHaveOccurred?: boolean; requestId?: string } = {},
): GrokBotGatewayError {
  return new GrokBotGatewayError(code, message, options);
}

export function loadDirectGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): DirectGatewayConfig | undefined {
  const urlText = env.GROKBOT_GATEWAY_URL?.trim();
  const token = env.SAND_GATEWAY_TOKEN?.trim();
  if (!urlText && !token) return undefined;
  if (!urlText || !token) {
    throw error(
      "CONFIG_INVALID",
      "Persistent Grok Bot tools require both GROKBOT_GATEWAY_URL and SAND_GATEWAY_TOKEN.",
    );
  }
  if (token.length > 4096 || /[\0\r\n]/.test(token)) {
    throw error("CONFIG_INVALID", "SAND_GATEWAY_TOKEN is invalid.");
  }

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw error("CONFIG_INVALID", "GROKBOT_GATEWAY_URL must be an absolute HTTP(S) URL.");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw error("CONFIG_INVALID", "GROKBOT_GATEWAY_URL must use HTTP or HTTPS.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !isLoopback) {
    throw error(
      "CONFIG_INVALID",
      "GROKBOT_GATEWAY_URL must use HTTPS unless it points to loopback. Use an SSH or VPN local forward for remote plaintext gateways.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw error(
      "CONFIG_INVALID",
      "GROKBOT_GATEWAY_URL must not contain credentials, a query string, or a fragment.",
    );
  }

  return { baseUrl: url.toString().replace(/\/+$/, ""), token };
}

function endpoint(config: DirectGatewayConfig, command: GatewayCommand): string {
  return `${config.baseUrl}/api/${command}`;
}

async function readResponse(
  response: Response,
  requestId: string,
  deliveryMayHaveOccurred: boolean,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_GATEWAY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw error("OUTPUT_LIMIT", "Grok Bot gateway response exceeded the 1 MiB safety limit.", {
      deliveryMayHaveOccurred,
      requestId,
    });
  }
  if (response.body === null) return "";

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_GATEWAY_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw error("OUTPUT_LIMIT", "Grok Bot gateway response exceeded the 1 MiB safety limit.", {
        deliveryMayHaveOccurred,
        requestId,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function httpError(
  status: number,
  requestId: string,
  command: GatewayCommand,
): GrokBotGatewayError {
  const deliveryMayHaveOccurred = command === "sendPrompt";
  if (status === 401 || status === 403) {
    return error("AUTH_FAILED", "Grok Bot gateway authentication failed.", {
      deliveryMayHaveOccurred,
      requestId,
    });
  }
  if (status === 429) {
    return error("RATE_LIMITED", "Grok Bot gateway rate limit was reached.", {
      deliveryMayHaveOccurred,
      requestId,
    });
  }
  return error("GATEWAY_REJECTED", `Grok Bot gateway rejected the request with HTTP ${status}.`, {
    deliveryMayHaveOccurred,
    requestId,
  });
}

async function postGateway<T>(
  config: DirectGatewayConfig,
  command: GatewayCommand,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ data: T; requestId: string }> {
  if (signal?.aborted) throw error("CANCELLED", "Grok Bot gateway request was cancelled.");

  const requestId = randomUUID();
  const timeoutSignal = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetch(endpoint(config, command), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "x-sand-request-id": requestId,
        "x-sand-slim-avatars": "1",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestSignal,
    });
  } catch {
    if (signal?.aborted) {
      throw error("CANCELLED", "Grok Bot gateway request was cancelled.", {
        deliveryMayHaveOccurred: command === "sendPrompt",
        requestId,
      });
    }
    if (timeoutSignal.aborted) {
      throw error("TIMEOUT", "Grok Bot gateway request timed out.", {
        deliveryMayHaveOccurred: command === "sendPrompt",
        requestId,
      });
    }
    throw error("UNAVAILABLE", "Grok Bot gateway could not be reached.", {
      deliveryMayHaveOccurred: command === "sendPrompt",
      requestId,
    });
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw httpError(response.status, requestId, command);
  }

  let text: string;
  try {
    text = await readResponse(response, requestId, command === "sendPrompt");
  } catch (caught) {
    if (caught instanceof GrokBotGatewayError) throw caught;
    throw error("UNAVAILABLE", "Grok Bot gateway response ended unexpectedly.", {
      deliveryMayHaveOccurred: command === "sendPrompt",
      requestId,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw error("INVALID_RESPONSE", "Grok Bot gateway returned malformed JSON.", {
      deliveryMayHaveOccurred: command === "sendPrompt",
      requestId,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw error("INVALID_RESPONSE", "Grok Bot gateway returned an unexpected response.", {
      deliveryMayHaveOccurred: command === "sendPrompt",
      requestId,
    });
  }
  return { data: parsed.data, requestId };
}

export function createDirectGatewayTransport(config: DirectGatewayConfig): GrokBotTransport {
  return {
    async listBots(signal?: AbortSignal): Promise<GrokBotSummary[]> {
      const { data } = await postGateway(config, "listAgents", {}, rawRosterSchema, signal);
      return data
        .filter((bot) => bot.isGroup === false)
        .map((bot) => ({ id: bot.id, name: bot.name, is_running: bot.isRunning ?? null }));
    },
    async readBot(botId, options, signal) {
      const { data: agents } = await postGateway(
        config,
        "listAgents",
        {},
        rawRosterSchema,
        signal,
      );
      const bot = agents.find((candidate) => candidate.id === botId);
      if (bot === undefined || bot.isGroup !== false) {
        throw error("BOT_NOT_FOUND", "Bot ID is not present in the current non-group roster.");
      }
      const [tail, tasks, subagents] = await Promise.all([
        postGateway(
          config,
          "getAgentTranscriptTail",
          {
            id: botId,
            limit: options.limit,
            ...(options.beforeSequence === undefined
              ? {}
              : { beforeSeq: options.beforeSequence }),
          },
          transcriptTailSchema,
          signal,
        ),
        postGateway(config, "getAsyncTasks", { id: botId }, asyncTasksSchema, signal),
        postGateway(config, "getSubagents", { id: botId }, subagentsSchema, signal),
      ]);
      if (tail.data.entries.length > options.limit) {
        throw error("INVALID_RESPONSE", "Grok Bot gateway returned too many transcript entries.");
      }
      return createBridgeReadSnapshot({
        bot_id: botId,
        is_running: bot.isRunning ?? null,
        is_composing: bot.isComposingMessage ?? null,
        awaiting_user:
          bot.awaitingUserResponse === undefined
            ? null
            : bot.awaitingUserResponse !== null && bot.awaitingUserResponse !== false,
        async_task_count: tasks.data.length,
        running_subagent_count: subagents.data.filter(({ status }) => status === "running").length,
        entries: tail.data.entries,
        next_before_sequence: tail.data.nextBeforeSeq ?? null,
      });
    },
    async sendMessage(botId: string, message: string, signal?: AbortSignal) {
      const { requestId } = await postGateway(
        config,
        "sendPrompt",
        { agentId: botId, prompt: message },
        sendPromptResponseSchema,
        signal,
      );
      return { accepted: true as const, requestId };
    },
  };
}
