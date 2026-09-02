import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_PROMPT_BYTES } from "./schema.js";

const MAX_PING_BOTS = 50;
const MAX_ROSTER_BOTS = 500;
const PING_MESSAGE = "PING";
const PING_APPROVAL_KEY = "approve_ping_all";
const COMPLETION_BOUNDARY = "gateway_accepted_not_bot_reply" as const;

// ponytail: 50 sequential 10-second sends fit the plugin timeout; add chunked approvals if larger rosters appear.

export type GrokBotGatewayErrorCode =
  | "AUTH_FAILED"
  | "BOT_NOT_FOUND"
  | "CANCELLED"
  | "CONFIG_INVALID"
  | "GATEWAY_REJECTED"
  | "INVALID_RESPONSE"
  | "OUTPUT_LIMIT"
  | "RATE_LIMITED"
  | "ROSTER_CHANGED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class GrokBotGatewayError extends Error {
  readonly code: GrokBotGatewayErrorCode;
  readonly deliveryMayHaveOccurred: boolean;
  readonly requestId: string | undefined;

  constructor(
    code: GrokBotGatewayErrorCode,
    message: string,
    options: { deliveryMayHaveOccurred?: boolean; requestId?: string } = {},
  ) {
    super(message);
    this.name = "GrokBotGatewayError";
    this.code = code;
    this.deliveryMayHaveOccurred = options.deliveryMayHaveOccurred ?? false;
    this.requestId = options.requestId;
  }
}

export type GrokBotSummary = {
  id: string;
  name: string;
  is_running: boolean | null;
};

export type GrokBotRoster = {
  bot_count: number;
  bots: GrokBotSummary[];
  roster_fingerprint: string;
};

export type GrokBotSendReceipt = {
  accepted: true;
  requestId: string;
};

export type GrokBotTransport = {
  listBots(signal?: AbortSignal): Promise<GrokBotSummary[]>;
  sendMessage(
    botId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<GrokBotSendReceipt>;
};

type PingReceipt = {
  bot_id: string;
  bot_name: string;
  status: "accepted" | "failed" | "outcome_unknown" | "not_attempted";
  request_id?: string;
  error_code?: string;
};

const transportRosterSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(512),
        name: z.string().trim().min(1).max(512),
        is_running: z.boolean().nullable(),
      })
      .strict(),
  )
  .max(MAX_ROSTER_BOTS);

export const grokListBotsInputSchema = z.object({}).strict();

const botSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    is_running: z.boolean().nullable(),
  })
  .strict();

export const grokListBotsOutputSchema = z
  .object({
    experimental: z.literal(true),
    bot_count: z.number().int().nonnegative(),
    bots: z.array(botSummarySchema),
    roster_fingerprint: z.string(),
  })
  .strict();

const messageSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Message must not be empty")
  .refine((value) => !value.includes("\0"), "Message must not contain NUL bytes")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES,
    `Message must not exceed ${MAX_PROMPT_BYTES} UTF-8 bytes`,
  );

export const grokSendBotMessageInputSchema = z
  .object({
    bot_id: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !value.includes("\0"), "Bot ID must not contain NUL bytes")
      .describe("Exact Bot ID returned by grok_list_bots; names and 'all' are not accepted"),
    message: messageSchema.describe("Message to send once to the selected persistent Grok Bot"),
  })
  .strict();

export const grokSendBotMessageOutputSchema = z
  .object({
    experimental: z.literal(true),
    bot_id: z.string(),
    bot_name: z.string(),
    accepted: z.literal(true),
    request_id: z.string(),
    completion_boundary: z.literal(COMPLETION_BOUNDARY),
  })
  .strict();

export const grokPingAllBotsInputSchema = z
  .object({
    roster_fingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional()
      .describe("Fingerprint returned by the immediately preceding confirmation preview"),
    bot_ids: z
      .array(z.string().trim().min(1).max(512))
      .min(1)
      .max(MAX_PING_BOTS)
      .refine((ids) => new Set(ids).size === ids.length, "Bot IDs must be unique")
      .optional()
      .describe("Every exact Bot ID from the preview, in the displayed order"),
    confirmation: z
      .literal("PING_ALL")
      .optional()
      .describe("Exact confirmation phrase required for the second call"),
  })
  .strict();

const pingPreviewSchema = z
  .object({
    experimental: z.literal(true),
    requires_confirmation: z.literal(true),
    message: z.literal(PING_MESSAGE),
    bot_count: z.number().int().positive(),
    bots: z.array(botSummarySchema).min(1),
    roster_fingerprint: z.string(),
  })
  .strict();

const pingReceiptSchema = z
  .object({
    bot_id: z.string(),
    bot_name: z.string(),
    status: z.enum(["accepted", "failed", "outcome_unknown", "not_attempted"]),
    request_id: z.string().optional(),
    error_code: z.string().optional(),
  })
  .strict();

const pingResultSchema = z
  .object({
    experimental: z.literal(true),
    requires_confirmation: z.literal(false),
    message: z.literal(PING_MESSAGE),
    roster_fingerprint: z.string(),
    receipts: z.array(pingReceiptSchema),
    accepted_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    outcome_unknown_count: z.number().int().nonnegative(),
    not_attempted_count: z.number().int().nonnegative(),
    completion_boundary: z.literal(COMPLETION_BOUNDARY),
  })
  .strict();

export const grokPingAllBotsOutputSchema = z.discriminatedUnion("requires_confirmation", [
  pingPreviewSchema,
  pingResultSchema,
]);

const pingApprovalSchema = z
  .object({
    confirm: z.boolean().describe("Approve one PING send to every displayed Grok Bot"),
  })
  .strict();

const pingApprovalRequestedSchema = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Approve PING-to-all",
      description: "Send PING once to every displayed Grok Bot",
    },
  },
  required: ["confirm"],
};

function error(
  code: GrokBotGatewayErrorCode,
  message: string,
  options: { deliveryMayHaveOccurred?: boolean; requestId?: string } = {},
): GrokBotGatewayError {
  return new GrokBotGatewayError(code, message, options);
}

function compareBots(left: GrokBotSummary, right: GrokBotSummary): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function rosterFingerprint(bots: GrokBotSummary[]): string {
  const canonical = bots.map(({ id, name, is_running }) => ({ id, name, is_running }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export async function listGrokBots(
  transport: GrokBotTransport,
  signal?: AbortSignal,
): Promise<GrokBotRoster> {
  const parsed = transportRosterSchema.safeParse(await transport.listBots(signal));
  if (!parsed.success) {
    throw error("INVALID_RESPONSE", "Grok Bot transport returned an unexpected roster.");
  }
  const bots = parsed.data.slice().sort(compareBots);
  if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
    throw error("INVALID_RESPONSE", "Grok Bot gateway returned duplicate Bot IDs.");
  }
  return { bot_count: bots.length, bots, roster_fingerprint: rosterFingerprint(bots) };
}

async function sendKnownBotMessage(
  transport: GrokBotTransport,
  botId: string,
  message: string,
  signal?: AbortSignal,
): Promise<GrokBotSendReceipt> {
  return transport.sendMessage(botId, message, signal);
}

function safeFailure(caught: unknown): GrokBotGatewayError {
  return caught instanceof GrokBotGatewayError
    ? caught
    : error("UNAVAILABLE", "Grok Bot gateway request failed unexpectedly.");
}

function toolError(caught: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const failure = safeFailure(caught);
  const outcome = failure.deliveryMayHaveOccurred
    ? "The message outcome is unknown; do not retry automatically."
    : "No automatic retry was attempted.";
  const request = failure.requestId === undefined ? "" : ` Request ID: ${failure.requestId}.`;
  return {
    content: [{ type: "text", text: `[${failure.code}] ${failure.message}${request} ${outcome}` }],
    isError: true,
  };
}

function botLines(bots: GrokBotSummary[]): string {
  return bots
    .map((bot) => `- ${bot.name} (${bot.id}) — ${bot.is_running === true ? "running" : bot.is_running === false ? "stopped" : "state unknown"}`)
    .join("\n");
}

async function pingBots(
  transport: GrokBotTransport,
  bots: GrokBotSummary[],
  signal?: AbortSignal,
): Promise<PingReceipt[]> {
  const receipts: PingReceipt[] = [];
  for (let index = 0; index < bots.length; index += 1) {
    const bot = bots[index];
    if (bot === undefined) break;
    if (signal?.aborted) {
      for (const remaining of bots.slice(index)) {
        receipts.push({
          bot_id: remaining.id,
          bot_name: remaining.name,
          status: "not_attempted",
          error_code: "CANCELLED",
        });
      }
      break;
    }
    try {
      const receipt = await sendKnownBotMessage(transport, bot.id, PING_MESSAGE, signal);
      receipts.push({
        bot_id: bot.id,
        bot_name: bot.name,
        status: "accepted",
        request_id: receipt.requestId,
      });
    } catch (caught) {
      const failure = safeFailure(caught);
      receipts.push({
        bot_id: bot.id,
        bot_name: bot.name,
        status: failure.deliveryMayHaveOccurred ? "outcome_unknown" : "failed",
        ...(failure.requestId === undefined ? {} : { request_id: failure.requestId }),
        error_code: failure.code,
      });
      if (failure.code === "CANCELLED") {
        for (const remaining of bots.slice(index + 1)) {
          receipts.push({
            bot_id: remaining.id,
            bot_name: remaining.name,
            status: "not_attempted",
            error_code: "CANCELLED",
          });
        }
        break;
      }
    }
  }
  return receipts;
}

export function registerGrokBotTools(
  server: McpServer,
  transport: GrokBotTransport,
): void {
  server.registerTool(
    "grok_list_bots",
    {
      title: "List Persistent Grok Bots",
      description:
        "List persistent named Grok Bots from an operator-configured unofficial gateway. Returns exact Bot IDs, running state, and a roster fingerprint. This is experimental and read-only.",
      inputSchema: grokListBotsInputSchema,
      outputSchema: grokListBotsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_input, context) => {
      try {
        const roster = await listGrokBots(transport, context.mcpReq.signal);
        const output = { experimental: true as const, ...roster };
        return {
          content: [
            {
              type: "text" as const,
              text: roster.bot_count === 0 ? "No persistent Grok Bots found." : botLines(roster.bots),
            },
          ],
          structuredContent: output,
        };
      } catch (caught) {
        return toolError(caught);
      }
    },
  );

  server.registerTool(
    "grok_send_bot_message",
    {
      title: "Send Persistent Grok Bot Message",
      description:
        "Send one message to one exact persistent Grok Bot ID. The ID is verified against a fresh roster. The gateway's accepted receipt does not prove the Bot replied or completed work. No automatic retry.",
      inputSchema: grokSendBotMessageInputSchema,
      outputSchema: grokSendBotMessageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ bot_id, message }, context) => {
      try {
        const roster = await listGrokBots(transport, context.mcpReq.signal);
        const bot = roster.bots.find((candidate) => candidate.id === bot_id);
        if (bot === undefined) {
          throw error("BOT_NOT_FOUND", "Bot ID is not present in the current roster. List Bots again.");
        }
        const receipt = await sendKnownBotMessage(
          transport,
          bot.id,
          message,
          context.mcpReq.signal,
        );
        const output = {
          experimental: true as const,
          bot_id: bot.id,
          bot_name: bot.name,
          accepted: true as const,
          request_id: receipt.requestId,
          completion_boundary: COMPLETION_BOUNDARY,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Gateway accepted the message for ${bot.name} (${bot.id}); this does not prove a reply or completion.`,
            },
          ],
          structuredContent: output,
        };
      } catch (caught) {
        return toolError(caught);
      }
    },
  );

  server.registerTool(
    "grok_ping_all_bots",
    {
      title: "Ping All Persistent Grok Bots",
      description:
        "Two-step experimental PING-to-all workflow. First call with no arguments to preview the exact roster. Then pass that fingerprint, every displayed Bot ID, and confirmation PING_ALL. The roster is rechecked; sends are sequential, once per Bot, never retried, with per-Bot receipts.",
      inputSchema: grokPingAllBotsInputSchema,
      outputSchema: grokPingAllBotsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ roster_fingerprint, bot_ids, confirmation }, context) => {
      try {
        const roster = await listGrokBots(transport, context.mcpReq.signal);
        if (roster.bot_count === 0) {
          throw error("BOT_NOT_FOUND", "No persistent Grok Bots are available to ping.");
        }
        if (roster.bot_count > MAX_PING_BOTS) {
          throw error(
            "CONFIG_INVALID",
            `PING-to-all is limited to ${MAX_PING_BOTS} Bots per confirmed call.`,
          );
        }

        const supplied = [roster_fingerprint, bot_ids, confirmation].filter(
          (value) => value !== undefined,
        ).length;
        if (supplied === 0) {
          const output = {
            experimental: true as const,
            requires_confirmation: true as const,
            message: PING_MESSAGE,
            ...roster,
          };
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No messages sent. Review these ${roster.bot_count} Bots, then call again with the fingerprint, exact Bot IDs, and confirmation PING_ALL:\n${botLines(roster.bots)}`,
              },
            ],
            structuredContent: output,
          };
        }
        if (supplied !== 3) {
          throw error(
            "CONFIG_INVALID",
            "Confirmation requires roster_fingerprint, every previewed bot_id, and confirmation PING_ALL.",
          );
        }

        const expectedIds = roster.bots.map((bot) => bot.id);
        if (
          roster_fingerprint !== roster.roster_fingerprint ||
          bot_ids === undefined ||
          bot_ids.length !== expectedIds.length ||
          bot_ids.some((id, index) => id !== expectedIds[index])
        ) {
          throw error(
            "ROSTER_CHANGED",
            "The Grok Bot roster does not match the confirmation preview. Preview and confirm again.",
          );
        }

        const approvalResponse = inputResponse(
          context.mcpReq.inputResponses,
          PING_APPROVAL_KEY,
        );
        if (approvalResponse.kind === "missing") {
          return inputRequired({
            inputRequests: {
              [PING_APPROVAL_KEY]: inputRequired.elicit({
                message:
                  `Approve one ${PING_MESSAGE} send to each of these ${roster.bot_count} Grok Bots? No automatic retries.\n${botLines(roster.bots)}`,
                requestedSchema: pingApprovalRequestedSchema,
              }),
            },
          });
        }
        const approval = acceptedContent(
          context.mcpReq.inputResponses,
          PING_APPROVAL_KEY,
          pingApprovalSchema,
        );
        if (
          approvalResponse.kind !== "elicit" ||
          approvalResponse.action !== "accept" ||
          approval?.confirm !== true
        ) {
          throw error("CANCELLED", "PING-to-all was not approved. No messages were sent.");
        }

        const receipts = await pingBots(transport, roster.bots, context.mcpReq.signal);
        const count = (status: PingReceipt["status"]): number =>
          receipts.filter((receipt) => receipt.status === status).length;
        const output = {
          experimental: true as const,
          requires_confirmation: false as const,
          message: PING_MESSAGE,
          roster_fingerprint: roster.roster_fingerprint,
          receipts,
          accepted_count: count("accepted"),
          failed_count: count("failed"),
          outcome_unknown_count: count("outcome_unknown"),
          not_attempted_count: count("not_attempted"),
          completion_boundary: COMPLETION_BOUNDARY,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `PING receipts: ${output.accepted_count} accepted, ${output.failed_count} failed, ${output.outcome_unknown_count} unknown, ${output.not_attempted_count} not attempted. Accepted does not prove a reply.`,
            },
          ],
          structuredContent: output,
        };
      } catch (caught) {
        return toolError(caught);
      }
    },
  );
}
