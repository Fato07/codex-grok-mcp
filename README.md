# Codex Grok MCP

<p align="center">
  <img src="plugins/codex-grok-mcp/assets/icon.png" alt="Codex Grok MCP icon" width="180" />
</p>

An unofficial, local-first MCP bridge that lets Codex ask the authenticated Grok CLI for a bounded second opinion.

> [!IMPORTANT]
> Each call sends the supplied prompt to xAI/Grok and consumes allowance from the signed-in Grok account. This project is not affiliated with or endorsed by OpenAI or xAI.

This alpha is source-only. No npm or GitHub release is claimed yet.

## What it is

```text
Codex -> local MCP server -> isolated Grok CLI -> xAI
```

The connector exposes one tool, `grok_ask`. It pins a Grok model, runs one turn without subagents, and always disables Grok web search.

This talks to **Grok CLI**, not a persistent named **Grok Bot**. It cannot enter a Bot conversation, use Bot memory, read Bot transcripts, or control the Grok Bot desktop app.

## Five-minute local install

Prerequisites:

- macOS; this is the only platform verified for the alpha.
- Node.js 22 or newer.
- Codex CLI/desktop.
- Grok CLI installed and signed in. Confirm with `grok --version` and `grok models`.

From a local checkout or extracted source directory:

```bash
cd /absolute/path/to/codex-grok-mcp
npm ci
npm run build
npm install --global .
codex-grok-mcp --doctor
codex plugin marketplace add /absolute/path/to/codex-grok-mcp
```

Then open the Plugins Directory in the Codex desktop app, install **Codex Grok MCP** from the **Codex Grok** local source, and start a new task. Try:

```text
Ask Grok to challenge this architecture and return the three strongest objections.
```

The source alpha plugin runs the globally installed `codex-grok-mcp` executable. It does not download an unpublished package or modify Grok authentication. A published plugin release will instead pin an exact npm package version.

## Direct Codex MCP setup

If you do not want the plugin wrapper:

```bash
codex mcp add grok -- codex-grok-mcp
```

Start a new Codex task after adding the server, then ask Codex to use `grok_ask`.

## Doctor

Run after the local package installation:

```bash
codex-grok-mcp --doctor
```

Doctor checks local prerequisites and configuration without sending a prompt to Grok. It must not print authentication material.

## Configuration

Configuration is operator-owned and optional:

| Variable | Default | Constraint |
|---|---|---|
| `GROK_MCP_BIN` | `grok` | Absolute Grok CLI path when overridden |
| `GROK_MCP_MODEL` | `grok-4.6` | `grok-4.6` or `grok-4.5` |
| `GROK_MCP_TIMEOUT_MS` | `180000` | Integer from `5000` to `600000` |
| `GROK_MCP_AUTH_PATH` | `~/.grok/auth.json` | Absolute or working-directory-relative auth file path |

The plugin passes only these connector-specific overrides through its MCP configuration. The connector itself supplies a narrow child environment for Grok CLI.

## Privacy and isolation boundary

Every `grok_ask` call deliberately crosses an external data boundary: the prompt goes from Codex to xAI through Grok CLI. Do not send secrets, credentials, private source, personal data, or regulated data unless you are authorized to share it with xAI.

The Grok child process runs with private temporary `HOME` and `GROK_HOME` directories. Only the existing authentication file—`~/.grok/auth.json` by default—is symlinked into the isolated `GROK_HOME`; the connector checks the file but does not read it. The rest of the user's `~/.grok` state—sessions, memory, plugins, logs, configuration, and Bot data—is not mounted into the child home. The connector removes its prompt file and temporary home after each call.

This boundary limits what the Grok child discovers by default. It is not a general sandbox for the Codex process or this Node.js MCP server.

The connector does not intentionally log prompt or response content, child arguments, stdout/stderr, environment values, authentication data, or temporary paths. Safe operational fields may include the connector version, elapsed time, prompt byte count, a request identifier, and a coarse exit category.

## Compatibility

| Environment | Status |
|---|---|
| macOS, current local Codex and Grok CLI | Verified target for `0.1.0-alpha.1` |
| Linux | Planned; unverified |
| Windows / WSL | Unverified |
| Codex cloud | Unsupported; the connector needs a local Grok executable and login |
| Persistent named Grok Bot | Unsupported by design |

Passing unit tests is not compatibility proof. A platform becomes supported only after a live model-identity smoke test.

## Troubleshooting

### `codex-grok-mcp` is not found

Confirm the global npm bin directory is on `PATH`, then rerun:

```bash
npm ci
npm run build
npm run doctor
```

### Grok CLI is missing or not signed in

Run:

```bash
grok --version
grok models
```

Complete Grok's normal login flow outside Codex, then rerun doctor. This connector never asks Codex for tokens or passwords.

### The requested Grok model is unavailable

Use `grok models` to inspect what the signed-in account can access. The connector fails closed instead of silently using the Grok CLI default, because that default may not be a Grok model.

### The request times out or allowance is exhausted

Retry only after checking the Grok account and direct CLI behavior. A retry consumes another request if the first one reached xAI.

### Codex does not show the tool

Run `codex plugin marketplace list`, confirm the local marketplace path, install the plugin in the desktop app, and start a new task. For direct setup, inspect `codex mcp list`.

### Direct CLI works but the connector fails

Run `codex-grok-mcp --doctor`, record the connector, Node, Codex, Grok CLI, OS, and architecture versions, and report a bug with redacted output. Never attach `~/.grok/auth.json`, prompts, responses, or transcripts.

## Uninstall

If installed as a plugin, uninstall **Codex Grok MCP** in the Codex desktop app, then remove the local marketplace:

```bash
codex plugin marketplace remove codex-grok
npm uninstall --global codex-grok-mcp
```

If configured directly, remove that MCP entry too:

```bash
codex mcp remove grok
```

Uninstalling does not change or delete Grok CLI authentication or account data.

## Development

```bash
npm ci
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a change.

## License and attribution

MIT. The process-runner design was informed by the MIT-licensed [`libraz/grok-mcp`](https://github.com/libraz/grok-mcp); see repository history and any accompanying notices for exact reused code if applicable.
