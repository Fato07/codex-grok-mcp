import { Buffer } from "node:buffer";
import { z } from "zod";
import { MAX_PROMPT_BYTES } from "./schema.js";

const MAX_ROSTER_BOTS = 500;
export const MAX_READ_BOT_MESSAGES = 50;
export const MAX_READ_SNAPSHOT_BYTES = 64 * 1024;
const MAX_READ_TEXT_BYTES = 48 * 1024;
const MAX_READ_MESSAGE_TEXT_BYTES = 16 * 1024;

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

const bridgeReadTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Read message text must not be empty")
  .refine((value) => sanitizeReadText(value) === value, "Read message text is not normalized")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_READ_MESSAGE_TEXT_BYTES,
    `Read message text must not exceed ${MAX_READ_MESSAGE_TEXT_BYTES} UTF-8 bytes`,
  );

export const bridgeReadMessageSchema = z
  .object({
    speaker: z.enum(["user", "bot", "peer"]),
    text: bridgeReadTextSchema,
    timestamp_ms: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

export const bridgeReadSnapshotSchema = z
  .object({
    bot_id: botIdSchema,
    is_running: z.boolean().nullable(),
    is_composing: z.boolean().nullable(),
    awaiting_user: z.boolean().nullable(),
    async_task_count: z.number().int().nonnegative().nullable(),
    running_subagent_count: z.number().int().nonnegative().nullable(),
    messages: z.array(bridgeReadMessageSchema).max(MAX_READ_BOT_MESSAGES),
    next_before_sequence: z.number().int().nonnegative().safe().nullable(),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_READ_SNAPSHOT_BYTES,
    `Read snapshot must not exceed ${MAX_READ_SNAPSHOT_BYTES} UTF-8 bytes`,
  );

export type BridgeReadMessage = z.infer<typeof bridgeReadMessageSchema>;
export type BridgeReadSnapshot = z.infer<typeof bridgeReadSnapshotSchema>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function actorId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
  const source = record(value);
  if (source === undefined) return undefined;
  return typeof source.id === "string" && source.id.length > 0 && source.id.length <= 512
    ? source.id
    : undefined;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const suffix = "…";
  if (maxBytes < Buffer.byteLength(suffix, "utf8")) return { text: "", truncated: true };
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > budget) break;
    characters.push(character);
    bytes += next;
  }
  if (characters.length === 0) return { text: "", truncated: true };
  return { text: `${characters.join("")}${suffix}`, truncated: true };
}

function sanitizeReadText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
}

function normalizeReadMessage(value: unknown, botId: string): {
  message: BridgeReadMessage;
  sequence: number | null;
  truncated: boolean;
} | undefined {
  const outer = record(value);
  if (outer === undefined) return undefined;
  const nested = record(outer.entry);
  const entry = nested ?? outer;
  if (entry.streaming === true || outer.streaming === true) return undefined;

  const kind = typeof entry.kind === "string" ? entry.kind : undefined;
  const role = entry.role === "user" || entry.role === "assistant" ? entry.role : undefined;
  let text: string | undefined;
  if ((kind === "message" || kind === undefined) && role !== undefined) {
    if (typeof entry.content === "string" && entry.content.trim().length > 0) {
      text = entry.content;
    }
  } else if (kind === "send-message") {
    const message = record(entry.message);
    if (
      message?.type === "text" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    ) {
      text = message.content;
    }
  }
  if (text === undefined) return undefined;
  text = sanitizeReadText(text);
  if (text.trim().length === 0) return undefined;
  const bounded = truncateUtf8(text, MAX_READ_MESSAGE_TEXT_BYTES);

  const authorId = actorId(entry.author);
  const fromAgentId = actorId(entry.fromAgent);
  const fromUserId = actorId(entry.fromUser);
  const sourceId = authorId ?? fromAgentId ?? fromUserId;
  const hasPeerSource =
    record(entry.author) !== undefined ||
    record(entry.fromAgent) !== undefined ||
    typeof entry.author === "string" ||
    typeof entry.fromAgent === "string";
  const speaker =
    sourceId === botId
      ? "bot"
      : fromUserId !== undefined && !hasPeerSource
        ? "user"
        : hasPeerSource
          ? "peer"
          : role === "user"
            ? "user"
            : "bot";

  return {
    message: {
      speaker,
      text: bounded.text,
      timestamp_ms:
        nonnegativeInteger(entry.timestampMs) ?? nonnegativeInteger(outer.timestampMs),
    },
    sequence: nonnegativeInteger(outer.seq) ?? nonnegativeInteger(entry.seq),
    truncated: bounded.truncated,
  };
}

export function createBridgeReadSnapshot(input: {
  bot_id: string;
  is_running: boolean | null;
  is_composing: boolean | null;
  awaiting_user: boolean | null;
  async_task_count: number | null;
  running_subagent_count: number | null;
  entries: unknown[];
  next_before_sequence: number | null;
}): BridgeReadSnapshot {
  const normalized = input.entries
    .map((entry) => normalizeReadMessage(entry, input.bot_id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const kept: typeof normalized = [];
  let remainingTextBytes = MAX_READ_TEXT_BYTES;
  let truncated = normalized.some((entry) => entry.truncated);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const current = normalized[index];
    if (current === undefined) continue;
    const bounded = truncateUtf8(current.message.text, remainingTextBytes);
    if (bounded.text.length > 0) {
      kept.push({
        message: { ...current.message, text: bounded.text },
        sequence: current.sequence,
        truncated: current.truncated || bounded.truncated,
      });
      remainingTextBytes -= Buffer.byteLength(bounded.text, "utf8");
    }
    if (bounded.truncated || remainingTextBytes === 0) {
      truncated = truncated || bounded.truncated || index > 0;
      break;
    }
  }
  kept.reverse();
  let nextBeforeSequence = input.next_before_sequence;
  const updatePaginationBoundary = (removedSequence?: number | null): void => {
    const firstSequence = kept.find(({ sequence }) => sequence !== null)?.sequence;
    if (firstSequence !== null && firstSequence !== undefined) {
      nextBeforeSequence = firstSequence;
    } else if (
      removedSequence !== null &&
      removedSequence !== undefined &&
      Number.isSafeInteger(removedSequence + 1)
    ) {
      nextBeforeSequence = removedSequence + 1;
    }
  };
  if (kept.length < normalized.length) {
    truncated = true;
    updatePaginationBoundary();
  }
  const snapshot = (): BridgeReadSnapshot => ({
    bot_id: input.bot_id,
    is_running: input.is_running,
    is_composing: input.is_composing,
    awaiting_user: input.awaiting_user,
    async_task_count: input.async_task_count,
    running_subagent_count: input.running_subagent_count,
    messages: kept.map(({ message }) => message),
    next_before_sequence: nextBeforeSequence,
    truncated,
  });

  while (Buffer.byteLength(JSON.stringify(snapshot()), "utf8") > MAX_READ_SNAPSHOT_BYTES) {
    const removed = kept.shift();
    if (removed === undefined) break;
    truncated = true;
    updatePaginationBoundary(removed.sequence);
  }
  return bridgeReadSnapshotSchema.parse(snapshot());
}

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
      v: z.literal(2),
      id: rpcIdSchema,
      issued_at_ms: z.number().int().nonnegative(),
      op: z.literal("read_bot"),
      args: z
        .object({
          bot_id: botIdSchema,
          limit: z.number().int().min(1).max(MAX_READ_BOT_MESSAGES),
          before_sequence: z.number().int().nonnegative().safe().optional(),
        })
        .strict(),
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
  "UPGRADE_REQUIRED",
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
      v: z.literal(2),
      id: rpcIdSchema,
      op: z.literal("read_bot"),
      ok: z.literal(true),
      result: bridgeReadSnapshotSchema,
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
      v: z.union([z.literal(1), z.literal(2)]),
      id: rpcIdSchema,
      ok: z.literal(false),
      error: bridgeErrorSchema,
    })
    .strict(),
]);

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
