import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_MARKERS = 1_024;

export class BridgeReplayError extends Error {
  constructor() {
    super("replay_guard_failed");
    this.name = "BridgeReplayError";
  }
}

function isNodeError(caught: unknown): caught is NodeJS.ErrnoException {
  return caught instanceof Error && "code" in caught;
}

export function defaultReplayRoot(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const xdgStateHome = environment.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, ".local", "state");
  if (!isAbsolute(stateHome)) throw new BridgeReplayError();
  return join(stateHome, "codex-grok-mcp", "replay");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory() || (details.mode & 0o777) !== 0o700) {
    throw new BridgeReplayError();
  }
}

export class PersistentReplayGuard {
  readonly #directory: string;
  readonly #retentionMs: number;

  private constructor(directory: string, retentionMs: number) {
    this.#directory = directory;
    this.#retentionMs = retentionMs;
  }

  static async open(
    channel: string,
    retentionMs: number,
    root = defaultReplayRoot(),
  ): Promise<PersistentReplayGuard> {
    await ensurePrivateDirectory(root);
    const directory = join(root, `channel-${channel}`);
    await ensurePrivateDirectory(directory);
    const guard = new PersistentReplayGuard(directory, retentionMs);
    await guard.#prune(Date.now());
    return guard;
  }

  async claim(id: string, now: number): Promise<"claimed" | "replay"> {
    await this.#prune(now);
    const marker = join(this.#directory, id);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await open(
        marker,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          noFollow,
        0o600,
      );
    } catch (caught) {
      if (isNodeError(caught) && caught.code === "EEXIST") return "replay";
      throw new BridgeReplayError();
    }
    try {
      await handle.writeFile(`${now}\n`, "utf8");
      await handle.sync();
    } catch {
      await handle.close().catch(() => undefined);
      await unlink(marker).catch(() => undefined);
      throw new BridgeReplayError();
    }
    await handle.close();
    return "claimed";
  }

  async #prune(now: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      throw new BridgeReplayError();
    }
    for (const entry of entries) {
      const path = join(this.#directory, entry);
      try {
        const details = await lstat(path);
        if (
          details.isSymbolicLink() ||
          !details.isFile() ||
          (details.mode & 0o777) !== 0o600
        ) {
          throw new BridgeReplayError();
        }
        if (now - details.mtimeMs > this.#retentionMs) await unlink(path);
      } catch (caught) {
        if (isNodeError(caught) && caught.code === "ENOENT") continue;
        if (caught instanceof BridgeReplayError) throw caught;
        throw new BridgeReplayError();
      }
    }
    if ((await readdir(this.#directory)).length >= MAX_MARKERS) {
      throw new BridgeReplayError();
    }
  }
}
