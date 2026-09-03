import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { constants } from "node:fs";
import { MAX_PROMPT_BYTES } from "./schema.js";

const ALLOWED_MODELS = ["grok-4.6", "grok-4.5"] as const;
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;

const ISOLATED_CONFIG = `[cli]
auto_update = false
`;

export type GrokModel = (typeof ALLOWED_MODELS)[number];
export type GrokErrorCode =
  | "AUTH_REQUIRED"
  | "BUSY"
  | "CANCELLED"
  | "CLI_FAILED"
  | "CLI_NOT_FOUND"
  | "CONFIG_INVALID"
  | "INVALID_OUTPUT"
  | "MODEL_UNAVAILABLE"
  | "OUTPUT_LIMIT"
  | "TIMEOUT";

export class GrokCliError extends Error {
  readonly code: GrokErrorCode;
  readonly allowanceMayHaveBeenConsumed: boolean;

  constructor(code: GrokErrorCode, message: string, allowanceMayHaveBeenConsumed = false) {
    super(message);
    this.name = "GrokCliError";
    this.code = code;
    this.allowanceMayHaveBeenConsumed = allowanceMayHaveBeenConsumed;
  }
}

export type GrokCliConfig = {
  authPath: string;
  bin: string;
  model: GrokModel;
  timeoutMs: number;
};

export type GrokRunResult = {
  text: string;
  model: GrokModel;
  elapsedMs: number;
};

export type DoctorResult = {
  version: string;
  model: GrokModel;
  availableModels: string[];
};

type Sandbox = {
  root: string;
  cwd: string;
  home: string;
  grokHome: string;
  promptPath: string;
};

type ProcessResult = {
  stdout: string;
};

type RunProcessOptions = {
  args: string[];
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
};

// ponytail: one active process avoids allowance spikes; add a bounded queue only if demand is measured.
let active = false;

const error = (
  code: GrokErrorCode,
  message: string,
  allowanceMayHaveBeenConsumed = false,
): GrokCliError => new GrokCliError(code, message, allowanceMayHaveBeenConsumed);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrokCliConfig {
  const model = env.GROK_MCP_MODEL ?? "grok-4.6";
  if (!ALLOWED_MODELS.includes(model as GrokModel)) {
    throw error("CONFIG_INVALID", "GROK_MCP_MODEL must be grok-4.6 or grok-4.5.");
  }

  const timeoutText = env.GROK_MCP_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^\d+$/.test(timeoutText)) {
    throw error("CONFIG_INVALID", "GROK_MCP_TIMEOUT_MS must be an integer from 5000 to 600000.");
  }
  const timeoutMs = Number(timeoutText);
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw error("CONFIG_INVALID", "GROK_MCP_TIMEOUT_MS must be an integer from 5000 to 600000.");
  }

  const configuredBin = env.GROK_MCP_BIN?.trim();
  const bin = configuredBin || "grok";
  if (bin.includes("\0")) {
    throw error("CONFIG_INVALID", "GROK_MCP_BIN must not contain NUL bytes.");
  }
  if (configuredBin !== undefined && configuredBin !== "" && !isAbsolute(configuredBin)) {
    throw error("CONFIG_INVALID", "GROK_MCP_BIN must be an absolute path when set.");
  }

  const configuredAuthPath = env.GROK_MCP_AUTH_PATH?.trim();
  const authPath = configuredAuthPath
    ? isAbsolute(configuredAuthPath)
      ? configuredAuthPath
      : resolve(configuredAuthPath)
    : join(homedir(), ".grok", "auth.json");

  return { authPath, bin, model: model as GrokModel, timeoutMs };
}

function filteredEnv(source: NodeJS.ProcessEnv, sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GROK_HOME: sandbox.grokHome,
    HOME: sandbox.home,
    RUST_LOG: "off",
    TMPDIR: sandbox.root,
    XDG_CACHE_HOME: join(sandbox.home, ".cache"),
    XDG_CONFIG_HOME: join(sandbox.home, ".config"),
    XDG_DATA_HOME: join(sandbox.home, ".local", "share"),
  };
  for (const key of ["PATH", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

async function prepareSandbox(authPath: string, prompt?: string): Promise<Sandbox> {
  let authStat;
  try {
    authStat = await stat(authPath);
    await access(authPath, constants.R_OK);
  } catch {
    throw error("AUTH_REQUIRED", "Grok authentication was not found. Run `grok login` first.");
  }
  if (!authStat.isFile()) {
    throw error("AUTH_REQUIRED", "Grok authentication was not found. Run `grok login` first.");
  }
  if ((authStat.mode & 0o077) !== 0) {
    throw error("CONFIG_INVALID", "Grok auth file must not be readable by group or other users.");
  }

  const root = await mkdtemp(join(tmpdir(), "codex-grok-mcp-"));
  const home = join(root, "home");
  const grokHome = join(root, "grok-home");
  const cwd = join(root, "work");
  const promptPath = join(root, "prompt.txt");

  try {
    await chmod(root, 0o700);
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(grokHome, { mode: 0o700 }),
      mkdir(cwd, { mode: 0o700 }),
    ]);
    await symlink(authPath, join(grokHome, "auth.json"));
    await writeFile(join(grokHome, "config.toml"), ISOLATED_CONFIG, { mode: 0o600 });
    if (prompt !== undefined) {
      await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    try {
      await rm(root, { force: true, recursive: true });
    } catch {
      // Keep setup failures bounded; the OS temporary directory remains private.
    }
    throw error("CLI_FAILED", "Could not create the isolated Grok workspace.");
  }
  return { root, cwd, home, grokHome, promptPath };
}

async function cleanupSandbox(sandbox: Sandbox | undefined): Promise<void> {
  if (sandbox === undefined) return;
  await rm(sandbox.root, { force: true, recursive: true });
}

function classifyFailure(stderr: string): GrokCliError {
  if (/unauthorized|not authenticated|authentication|\b401\b|log(?:ged)? in/i.test(stderr)) {
    return error("AUTH_REQUIRED", "Grok authentication failed. Run `grok login` and try again.", true);
  }
  if (/model.{0,40}(?:not found|unavailable|unknown|invalid)|unknown.{0,20}model/i.test(stderr)) {
    return error("MODEL_UNAVAILABLE", "The configured Grok model is unavailable. Run the doctor command.", true);
  }
  return error("CLI_FAILED", "Grok CLI failed. Run `codex-grok-mcp --doctor` for setup checks.", true);
}

async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw error("CANCELLED", "Grok request was cancelled.");

  return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: GrokCliError | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    let timeoutTimer: NodeJS.Timeout | undefined;

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const terminate = (failure: GrokCliError): void => {
      if (terminalError !== undefined) return;
      terminalError = failure;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = (): void => terminate(error("CANCELLED", "Grok request was cancelled.", true));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(error("OUTPUT_LIMIT", "Grok CLI output exceeded the 4 MiB safety limit.", true));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate(error("OUTPUT_LIMIT", "Grok CLI diagnostic output exceeded the 64 KiB safety limit.", true));
        return;
      }
      stderr.push(chunk);
    });

    child.once("error", (spawnError: NodeJS.ErrnoException) => {
      const failure =
        spawnError.code === "ENOENT"
          ? error("CLI_NOT_FOUND", "Grok CLI was not found. Install it, then run `grok login`.")
          : error("CLI_FAILED", "Grok CLI could not be started.");
      settle(() => rejectPromise(failure));
    });

    child.once("close", (code) => {
      settle(() => {
        if (terminalError !== undefined) {
          rejectPromise(terminalError);
          return;
        }
        if (code !== 0) {
          rejectPromise(classifyFailure(Buffer.concat(stderr).toString("utf8")));
          return;
        }
        resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8") });
      });
    });

    timeoutTimer = setTimeout(
      () => terminate(error("TIMEOUT", "Grok request exceeded its configured timeout.", true)),
      options.timeoutMs,
    );
    timeoutTimer.unref();
  });
}

function parseGrokJson(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw error("INVALID_OUTPUT", "Grok CLI returned malformed JSON.", true);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0
  ) {
    throw error("INVALID_OUTPUT", "Grok CLI returned JSON without a non-empty text response.", true);
  }
  return value.text;
}

function askArgs(sandbox: Sandbox, model: GrokModel): string[] {
  return [
    `--prompt-file=${sandbox.promptPath}`,
    "--verbatim",
    "--output-format=json",
    `--model=${model}`,
    "--no-subagents",
    "--no-plan",
    "--max-turns=1",
    "--permission-mode=dontAsk",
    "--disable-web-search",
    "--deny=Bash",
    "--deny=Edit",
    "--deny=Read",
    "--deny=Grep",
    "--deny=MCPTool",
    "--deny=WebFetch",
    "--deny=WebSearch",
    `--cwd=${sandbox.cwd}`,
  ];
}

export async function runGrok(
  prompt: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<GrokRunResult> {
  if (active) throw error("BUSY", "Another Grok request is already running. Wait for it to finish.");
  if (
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES
  ) {
    throw error("CONFIG_INVALID", "Prompt is empty, contains NUL, or exceeds 65536 UTF-8 bytes.");
  }

  active = true;
  const requestId = randomUUID();
  const startedAt = Date.now();
  let sandbox: Sandbox | undefined;
  try {
    const sourceEnv = options.env ?? process.env;
    const config = loadConfig(sourceEnv);
    sandbox = await prepareSandbox(config.authPath, prompt);
    process.stderr.write(
      `${JSON.stringify({ event: "grok_request_started", request_id: requestId })}\n`,
    );
    const result = await runProcess({
      args: askArgs(sandbox, config.model),
      bin: config.bin,
      cwd: sandbox.cwd,
      env: filteredEnv(sourceEnv, sandbox),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeoutMs: config.timeoutMs,
    });
    const response = {
      text: parseGrokJson(result.stdout),
      model: config.model,
      elapsedMs: Date.now() - startedAt,
    };
    process.stderr.write(
      `${JSON.stringify({ event: "grok_request_finished", request_id: requestId, elapsed_ms: response.elapsedMs })}\n`,
    );
    return response;
  } catch (caught) {
    const failure =
      caught instanceof GrokCliError
        ? caught
        : error("CLI_FAILED", "Grok CLI request failed unexpectedly.", true);
    process.stderr.write(
      `${JSON.stringify({ event: "grok_request_failed", request_id: requestId, code: failure.code })}\n`,
    );
    throw failure;
  } finally {
    try {
      await cleanupSandbox(sandbox);
    } finally {
      active = false;
    }
  }
}

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorResult> {
  const config = loadConfig(env);
  const baseRoot = await mkdtemp(join(tmpdir(), "codex-grok-doctor-"));
  try {
    const version = await runProcess({
      args: ["--version"],
      bin: config.bin,
      cwd: baseRoot,
      env: { PATH: env.PATH, HOME: baseRoot, RUST_LOG: "off" },
      timeoutMs: 10_000,
    });
    const sandbox = await prepareSandbox(config.authPath);
    try {
      const models = await runProcess({
        args: ["models"],
        bin: config.bin,
        cwd: sandbox.cwd,
        env: filteredEnv(env, sandbox),
        timeoutMs: Math.min(config.timeoutMs, 30_000),
      });
      const availableModels = models.stdout
        .split("\n")
        .map((line) => line.match(/^\s*[*-]\s+(\S+)/)?.[1])
        .filter((model): model is string => model !== undefined)
        .sort();
      if (!availableModels.includes(config.model)) {
        throw error("MODEL_UNAVAILABLE", `Configured model ${config.model} is not available.`);
      }
      return { version: version.stdout.trim(), model: config.model, availableModels };
    } finally {
      await cleanupSandbox(sandbox);
    }
  } finally {
    await rm(baseRoot, { force: true, recursive: true });
  }
}
