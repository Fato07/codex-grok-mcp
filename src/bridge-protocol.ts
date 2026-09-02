import { Buffer } from "node:buffer";
import { z } from "zod";
import { MAX_PROMPT_BYTES } from "./schema.js";

const MAX_ROSTER_BOTS = 500;

const rpcIdSchema = z.string().uuid();
const botIdSchema = z.string().trim().min(1).max(512).refine(
  (value) => !value.includes("\0"),
  "Bot ID must not contain NUL bytes",
);
const messageSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Message must not be empty")
  .refine((value) => !value.includes("\0"), "Message must not contain NUL bytes")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES,
    `Message must not exceed ${MAX_PROMPT_BYTES} UTF-8 bytes`,
  );

export const bridgeBotSchema = z
  .object({
    id: botIdSchema,
    name: z.string().trim().min(1).max(512),
    is_running: z.boolean().nullable(),
  })
  .strict();

export const bridgeRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      v: z.literal(1),
      id: rpcIdSchema,
      issued_at_ms: z.number().int().nonnegative(),
      op: z.literal("list_bots"),
      args: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      id: rpcIdSchema,
      issued_at_ms: z.number().int().nonnegative(),
      op: z.literal("send_message"),
      args: z
        .object({
          bot_id: botIdSchema,
          message: messageSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const bridgeErrorCodeSchema = z.enum([
  "AUTH_FAILED",
  "BOT_NOT_FOUND",
  "CANCELLED",
  "CONFIG_INVALID",
  "GATEWAY_REJECTED",
  "INVALID_RESPONSE",
  "OUTPUT_LIMIT",
  "RATE_LIMITED",
  "ROSTER_CHANGED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

const bridgeErrorSchema = z
  .object({
    code: bridgeErrorCodeSchema,
    delivery_may_have_occurred: z.boolean(),
    request_id: z.string().min(1).max(512).optional(),
  })
  .strict();

export const bridgeResponseSchema = z.union([
  z
    .object({
      v: z.literal(1),
      id: rpcIdSchema,
      op: z.literal("list_bots"),
      ok: z.literal(true),
      result: z.object({ bots: z.array(bridgeBotSchema).max(MAX_ROSTER_BOTS) }).strict(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      id: rpcIdSchema,
      op: z.literal("send_message"),
      ok: z.literal(true),
      result: z
        .object({
          accepted: z.literal(true),
          request_id: z.string().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      id: rpcIdSchema,
      ok: z.literal(false),
      error: bridgeErrorSchema,
    })
    .strict(),
]);

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
