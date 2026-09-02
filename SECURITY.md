# Security policy

## Supported versions

`0.1.0-alpha.1` is an unreleased alpha. Until a public release exists, only the current source revision is considered for security fixes.

## Trust boundary

```text
Codex -> local MCP server -> isolated Grok CLI -> xAI
```

Calling `grok_ask` sends the supplied prompt to xAI and consumes Grok account allowance. Treat that transmission as an external write even though the tool returns analysis rather than modifying files or public state.

The connector is designed to:

- invoke Grok without a shell;
- pass prompts through a private temporary file rather than process arguments;
- run Grok with a private temporary home;
- link only the existing Grok authentication file into that home;
- avoid inheriting arbitrary environment variables;
- remove temporary material after the child exits;
- cap input, output, runtime, and concurrency;
- pin an allowed Grok model instead of trusting the user's CLI default.

The authentication link lets Grok use and refresh the user's existing login. By default, it points from the temporary `GROK_HOME/auth.json` to `~/.grok/auth.json`; `GROK_MCP_AUTH_PATH` can select a different operator-owned file. The connector checks that file but does not read or copy it. The link is still a sensitive capability, and the connector must never print, return, upload, or persist its contents.

The isolation boundary deliberately excludes normal Grok sessions, memory, configuration, plugins, logs, internal Grok Bot state, Keychain material, and undocumented gateway credentials. It narrows Grok CLI discovery; it is not a general sandbox for Codex or the Node.js MCP process.

Only `PATH`, locale, and TLS certificate discovery values are inherited into the Grok child where present. Connector options are restricted to `GROK_MCP_BIN`, `GROK_MCP_MODEL`, `GROK_MCP_TIMEOUT_MS`, and `GROK_MCP_AUTH_PATH`.

## Logging and diagnostics

Logs and errors must not contain:

- prompt or response content;
- child command arguments;
- stdout or stderr bodies;
- environment values;
- credentials or authentication files;
- temporary file or directory paths;
- Grok sessions, transcripts, memory, or Bot data.

Allowed operational fields are limited to a request identifier, connector version, elapsed milliseconds, prompt byte count, and a coarse exit category.

Doctor must be read-only and must not submit a model request.

## User responsibilities

- Do not send data to Grok unless you are authorized to share it with xAI.
- Keep `~/.grok/auth.json` private and never attach it to an issue.
- Review xAI account, privacy, and allowance terms before use.
- Verify uncertain failures through the direct Grok CLI before retrying; a request may already have consumed allowance.
- Install only source and packages from a maintainer-controlled release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or credential exposure. Use GitHub's private **Report a vulnerability** flow once the repository is published. Before publication, contact the maintainer privately through the source distribution channel.

Include a minimal reproduction, affected revision/version, OS and architecture, Node/Codex/Grok CLI versions, and impact. Redact prompts, outputs, paths, tokens, environment values, and account information.

The maintainer will acknowledge a valid report as soon as practical, coordinate remediation privately, and publish a security advisory when users need to act. There is no paid bug bounty or response-time SLA.

## Out of scope

- Vulnerabilities in Codex, Grok CLI, xAI, Node.js, or the operating system that do not arise from this connector.
- Reports requiring access to another person's account or credentials.
- Social engineering, denial-of-service testing, or testing against xAI infrastructure.
- Unsupported persistent Grok Bot or undocumented gateway integrations.
