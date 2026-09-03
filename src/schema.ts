import { Buffer } from "node:buffer";
import { z } from "zod";

export const MAX_PROMPT_BYTES = 65_536;
export const GROK_MODELS = ["grok-4.6", "grok-4.5"] as const;

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
    model: z.enum(GROK_MODELS).optional().describe("Exact Grok model for this call"),
  })
  .strict();

export const grokAskOutputSchema = z
  .object({
    text: z.string(),
    model: z.enum(GROK_MODELS),
    elapsed_ms: z.number().int().nonnegative(),
    usage_boundary: z.literal("grok_account_allowance"),
  })
  .strict();

export type GrokAskInput = z.infer<typeof grokAskInputSchema>;
export type GrokAskOutput = z.infer<typeof grokAskOutputSchema>;
