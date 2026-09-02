import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultReplayRoot,
  PersistentReplayGuard,
} from "../dist/bridge-replay.js";

test("default replay root follows absolute XDG state paths only", () => {
  assert.equal(
    defaultReplayRoot({ XDG_STATE_HOME: "/private/state" }, "/home/operator"),
    "/private/state/codex-grok-mcp/replay",
  );
  assert.equal(
    defaultReplayRoot({ XDG_STATE_HOME: "relative/state" }, "/home/operator"),
    "/home/operator/.local/state/codex-grok-mcp/replay",
  );
  assert.equal(
    defaultReplayRoot({}, "/home/operator"),
    "/home/operator/.local/state/codex-grok-mcp/replay",
  );
});

test("replay claims persist across guard reopen", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-grok-replay-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const first = await PersistentReplayGuard.open("test-channel", 60_000, root);
  assert.equal(await first.claim("test-request", Date.now()), "claimed");

  const reopened = await PersistentReplayGuard.open("test-channel", 60_000, root);
  assert.equal(await reopened.claim("test-request", Date.now()), "replay");
});
