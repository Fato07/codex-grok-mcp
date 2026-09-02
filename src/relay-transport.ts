import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { bridgeResponseSchema, type BridgeErrorCode, type BridgeRequest } from "./bridge-protocol.js";
import {
  GrokBotGatewayError,
  type GrokBotGatewayErrorCode,
  type GrokBotTransport,
} from "./grok-bot-gateway.js";
import { decryptFrame, encryptFrame, type PairingConfig } from "./bridge-pairing.js";

export const RELAY_TIMEOUT_MS = 15_000;
const MAX_RELAY_FRAME_BYTES = 128 * 1024;
const PEER_UNAVAILABLE_CLOSE_CODE = 4404;
const INVALID_FRAME_CLOSE_CODE = 4400;

const remoteErrorMessages: Record<BridgeErrorCode, string> = {
  AUTH_FAILED: "Grok Bot companion authentication failed.",
  BOT_NOT_FOUND: "Bot ID is not present in the current roster. List Bots again.",
  CANCELLED: "Grok Bot companion request was cancelled.",
  CONFIG_INVALID: "Grok Bot companion configuration is invalid.",
  GATEWAY_REJECTED: "Grok Bot gateway rejected the companion request.",
  INVALID_RESPONSE: "Grok Bot companion returned an invalid response.",
  OUTPUT_LIMIT: "Grok Bot companion response exceeded its safety limit.",
  RATE_LIMITED: "Grok Bot gateway rate limit was reached.",
  ROSTER_CHANGED: "The Grok Bot roster changed. List Bots again.",
  TIMEOUT: "Grok Bot companion request timed out.",
  UNAVAILABLE: "Grok Bot companion is unavailable.",
  UPGRADE_REQUIRED: "Grok Bot companion must be updated and restarted to read Bots.",
};

function error(
  code: GrokBotGatewayErrorCode,
  message: string,
  options: { deliveryMayHaveOccurred?: boolean; requestId?: string } = {},
): GrokBotGatewayError {
  return new GrokBotGatewayError(code, message, options);
}

function relaySocketUrl(config: PairingConfig, role: "codex" | "bridge"): string {
  const url = new URL(config.relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${config.channel}`;
  url.searchParams.set("role", role);
  return url.toString();
}

function textFrame(data: RawData, isBinary: boolean): string {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));
  if (isBinary || buffer.byteLength > MAX_RELAY_FRAME_BYTES) {
    throw error("INVALID_RESPONSE", "Grok Bot relay returned an invalid frame.");
  }
  return buffer.toString("utf8");
}

async function requestRelay(
  config: PairingConfig,
  request: BridgeRequest,
  signal?: AbortSignal,
): Promise<ReturnType<typeof bridgeResponseSchema.parse>> {
  if (signal?.aborted) throw error("CANCELLED", "Grok Bot relay request was cancelled.");

  const isSend = request.op === "send_message";
  let frameSent = false;

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(relaySocketUrl(config, "codex"), {
      followRedirects: false,
      handshakeTimeout: RELAY_TIMEOUT_MS,
      headers: { authorization: `Bearer ${config.relayToken}` },
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
    });
    let settled = false;

    const finish = (
      outcome:
        | { kind: "resolve"; value: ReturnType<typeof bridgeResponseSchema.parse> }
        | { kind: "reject"; value: GrokBotGatewayError },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.terminate();
      if (outcome.kind === "resolve") resolve(outcome.value);
      else reject(outcome.value);
    };

    const uncertain = (): boolean => isSend && frameSent;
    const onAbort = (): void => {
      finish({
        kind: "reject",
        value: error("CANCELLED", "Grok Bot relay request was cancelled.", {
          deliveryMayHaveOccurred: uncertain(),
          requestId: request.id,
        }),
      });
    };
    const timer = setTimeout(() => {
      finish({
        kind: "reject",
        value: error("TIMEOUT", "Grok Bot relay request timed out.", {
          deliveryMayHaveOccurred: uncertain(),
          requestId: request.id,
        }),
      });
    }, RELAY_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.once("open", () => {
      let frame: string;
      try {
        frame = encryptFrame(config, "codex", JSON.stringify(request));
        frameSent = true;
        socket.send(frame, { binary: false, compress: false });
      } catch {
        finish({
          kind: "reject",
          value: error("CONFIG_INVALID", "Grok Bot relay request could not be encrypted.", {
            deliveryMayHaveOccurred: uncertain(),
            requestId: request.id,
          }),
        });
      }
    });

    socket.once("message", (data, isBinary) => {
      try {
        const plaintext = decryptFrame(config, "bridge", textFrame(data, isBinary));
        const response = bridgeResponseSchema.parse(JSON.parse(plaintext.toString("utf8")));
        if (response.id !== request.id || (response.ok && response.op !== request.op)) {
          throw new Error("mismatched response");
        }
        finish({ kind: "resolve", value: response });
      } catch {
        finish({
          kind: "reject",
          value: error("INVALID_RESPONSE", "Grok Bot relay returned an invalid response.", {
            deliveryMayHaveOccurred: uncertain(),
            requestId: request.id,
          }),
        });
      }
    });

    socket.once("close", (code) => {
      const peerUnavailable = code === PEER_UNAVAILABLE_CLOSE_CODE;
      const upgradeRequired = request.op === "read_bot" && code === INVALID_FRAME_CLOSE_CODE;
      finish({
        kind: "reject",
        value: error(
          upgradeRequired ? "UPGRADE_REQUIRED" : "UNAVAILABLE",
          upgradeRequired
            ? "Grok Bot companion rejected the read protocol. Update and restart the companion."
            : peerUnavailable
              ? "Grok Bot companion is offline."
              : "Grok Bot relay connection closed.",
          {
            deliveryMayHaveOccurred: uncertain(),
            requestId: request.id,
          },
        ),
      });
    });

    socket.once("error", () => {
      finish({
        kind: "reject",
        value: error("UNAVAILABLE", "Grok Bot relay could not be reached.", {
          deliveryMayHaveOccurred: uncertain(),
          requestId: request.id,
        }),
      });
    });
  });
}

function remoteError(response: Extract<ReturnType<typeof bridgeResponseSchema.parse>, { ok: false }>): GrokBotGatewayError {
  return error(response.error.code, remoteErrorMessages[response.error.code], {
    deliveryMayHaveOccurred: response.error.delivery_may_have_occurred,
    ...(response.error.request_id === undefined ? {} : { requestId: response.error.request_id }),
  });
}

export function createRelayTransport(config: PairingConfig): GrokBotTransport {
  let queue: Promise<void> = Promise.resolve();
  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = queue;
    let release: () => void = () => undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    async listBots(signal?: AbortSignal) {
      return runExclusive(async () => {
        const response = await requestRelay(
          config,
          { v: 1, id: randomUUID(), issued_at_ms: Date.now(), op: "list_bots", args: {} },
          signal,
        );
        if (!response.ok) throw remoteError(response);
        if (response.op !== "list_bots") {
          throw error("INVALID_RESPONSE", "Grok Bot relay returned the wrong response type.");
        }
        return response.result.bots;
      });
    },
    async readBot(botId, options, signal) {
      return runExclusive(async () => {
        const response = await requestRelay(
          config,
          {
            v: 2,
            id: randomUUID(),
            issued_at_ms: Date.now(),
            op: "read_bot",
            args: {
              bot_id: botId,
              limit: options.limit,
              ...(options.beforeSequence === undefined
                ? {}
                : { before_sequence: options.beforeSequence }),
            },
          },
          signal,
        );
        if (!response.ok) throw remoteError(response);
        if (response.op !== "read_bot") {
          throw error("INVALID_RESPONSE", "Grok Bot relay returned the wrong response type.");
        }
        return response.result;
      });
    },
    async sendMessage(botId: string, message: string, signal?: AbortSignal) {
      return runExclusive(async () => {
        const response = await requestRelay(
          config,
          {
            v: 1,
            id: randomUUID(),
            issued_at_ms: Date.now(),
            op: "send_message",
            args: { bot_id: botId, message },
          },
          signal,
        );
        if (!response.ok) throw remoteError(response);
        if (response.op !== "send_message") {
          throw error("INVALID_RESPONSE", "Grok Bot relay returned the wrong response type.");
        }
        return { accepted: true, requestId: response.result.request_id };
      });
    },
  };
}
