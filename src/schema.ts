import { Buffer } from "node:buffer";
import { z } from "zod";

export const MAX_PROMPT_BYTES = 65_536;

export const grokAskInputSchema = z
  .object({
    prompt: z
      .string()
      .refine((value) => value.trim().length > 0, "Prompt must not be empty")
      .refine((value) => !value.includes("\0"), "Prompt must not contain NUL bytes")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES,
        `Prompt must not exceed ${MAX_PROMPT_BYTES} UTF-8 bytes`,
      )
      .describe("Question or task for a single, isolated Grok response"),
  })
  .strict();

export const grokAskOutputSchema = z
  .object({
    text: z.string(),
    model: z.enum(["grok-4.6", "grok-4.5"]),
    elapsed_ms: z.number().int().nonnegative(),
    usage_boundary: z.literal("grok_account_allowance"),
  })
  .strict();

export type GrokAskInput = z.infer<typeof grokAskInputSchema>;
export type GrokAskOutput = z.infer<typeof grokAskOutputSchema>;
