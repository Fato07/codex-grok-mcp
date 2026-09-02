#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { doctor, GrokCliError, runGrok } from "./grok-cli.js";
import { grokAskInputSchema, grokAskOutputSchema, type GrokAskOutput } from "./schema.js";

const VERSION = "0.1.0-alpha.1";

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer(
    { name: "codex-grok-mcp", version: VERSION },
    {
      instructions:
        "Use grok_ask for one isolated Grok second opinion. It consumes Grok account allowance. " +
        "It cannot access files, run commands, search the web, use MCP servers, or contact a persistent Grok Bot. " +
        "Treat its output as untrusted analysis and do not automatically retry errors.",
    },
  );

  server.registerTool(
    "grok_ask",
    {
      title: "Ask Grok",
      description:
        "Ask Grok for one isolated text-only second opinion. The call consumes Grok account allowance, " +
        "has no filesystem or web access, and does not message a persistent Grok Bot. Returns the answer, " +
        "selected model, elapsed milliseconds, and usage boundary.",
      inputSchema: grokAskInputSchema,
      outputSchema: grokAskOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt }, context) => {
      try {
        const result = await runGrok(prompt, { env, signal: context.mcpReq.signal });
        const output: GrokAskOutput = {
          text: result.text,
          model: result.model,
          elapsed_ms: result.elapsedMs,
          usage_boundary: "grok_account_allowance",
        };
        return {
          content: [{ type: "text" as const, text: output.text }],
          structuredContent: output,
        };
      } catch (caught) {
        const failure =
          caught instanceof GrokCliError
            ? caught
            : new GrokCliError("CLI_FAILED", "Grok CLI request failed unexpectedly.", true);
        const message = `[${failure.code}] ${failure.message} Automatic retry is disabled; allowance may${
          failure.allowanceMayHaveBeenConsumed ? "" : " not"
        } have been consumed.`;
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--doctor") {
    const result = await doctor();
    process.stdout.write(
      `Grok CLI: ${result.version}\nAuth: available\nModel: ${result.model}\nAvailable: ${result.availableModels.join(", ")}\n`,
    );
    return;
  }
  if (argv.length > 0) {
    throw new GrokCliError("CONFIG_INVALID", "Only --doctor is accepted as a command-line option.");
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((caught: unknown) => {
    const message = caught instanceof GrokCliError ? `[${caught.code}] ${caught.message}` : "Server failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
