# Security policy

## Supported versions

`0.2.0-beta.1` is an unreleased beta. Until a public release exists, only the current source revision is considered for security fixes.

## Trust boundary

```text
Codex -> local MCP server -> isolated Grok CLI -> xAI
```

With an experimental paired bridge, there is a second, separate boundary:

```text
Codex -> local MCP server -> opaque relay <- companion in Grok Bot VM
                                              -> loopback gateway -> named Bots
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

## Experimental paired Grok Bot bridge

The persistent Bot adapter is registered only after a pairing file passes strict validation. Pairing generates a random 128-bit channel identifier and 256-bit AES key. It derives a 256-bit channel bearer with HMAC-SHA-256 from the operator's relay master; the master stays on the Mac and in the Cloudflare secret and is not copied into the pair code or VM. Both client copies are stored in a mode-`0600` file under a mode-`0700` directory. Pair codes and files are credentials: never paste them into Codex/Bot prompts, issues, logs, or process arguments. The Mac command emits a code only to an interactive terminal; the VM companion reads it with terminal echo disabled.

Codex and the VM companion make outbound WebSocket connections. Before allocating a Durable Object, the included relay derives and checks the bearer for that exact channel and rejects browser-originated connections. Application frames use AES-256-GCM with random nonces and authenticated data binding the protocol version, channel, and sender role. The relay routes opaque frames between one `codex` and one `bridge` socket per channel, caps frames at 128 KiB, stores no payloads or credentials, and contains no payload logging. Default Cloudflare invocation logs and traces are explicitly disabled because the channel appears in the request path. The relay can still observe live connection timing, IP metadata, the random channel, and roles; it can drop, replay, or delay traffic, but it cannot decrypt or forge valid frames without the pairing key. The included deployment master is intended for one operator's self-hosted relay, not a shared public service.

Each request also carries an authenticated timestamp and UUID. The companion rejects requests older than 60 seconds before invoking the gateway, persists send UUIDs to a private bounded ledger before delivery, and caches authenticated responses in memory. A same-process duplicate receives the original receipt; a replay after restart is blocked and reported as `outcome_unknown`. One process-wide in-flight guard remains active across relay reconnects. The same UUID is also sent as the gateway `clientNonce`, but callers do not rely on undocumented host deduplication.

The companion uses a Node-20-compatible local client for four loopback-only operations: discovery, health, `listAgents`, and exact-ID `sendPrompt`. The contract was cross-checked against the MIT-licensed `grokbot-sdk`; the full SDK is not installed because it declares Node.js 22 while the verified VM provides Node.js 20. The local client bounds response bytes and duration, rejects redirects and non-loopback URLs, validates descriptor ownership and permissions, verifies on Linux that the descriptor PID owns the listening socket, validates response shapes, and sanitizes errors. The gateway token stays in VM memory and is never returned to Codex or the relay. The companion does not expose raw gateway commands, transcripts, files, shell, delete/reset, or credential APIs. It refreshes the roster before every send.

The legacy direct adapter remains available for manual power users only when both `GROKBOT_GATEWAY_URL` and `SAND_GATEWAY_TOKEN` are explicitly configured outside the plugin wrapper. The connector must not discover them by scraping Grok Bot app state, decrypting local descriptors, reading Keychain, or inspecting another process. Remote direct URLs require HTTPS; plaintext HTTP is accepted only on loopback for operator-managed SSH or VPN forwarding.

Bot sends are external writes. `grok_send_bot_message` requires an exact Bot ID from `grok_list_bots`. An empty `grok_ping_all_bots` call is a no-write preview; the write requires the current `roster_fingerprint`, every exact listed `bot_id`, and `confirmation: "PING_ALL"`, followed by an accepted native MCP user-confirmation request containing the recipients. It rechecks the roster, sends the fixed message `PING` sequentially, records a per-Bot receipt, and never retries automatically. It does not use a native broadcast endpoint. A roster change or declined confirmation fails closed without sending.

A timeout, cancellation, malformed response, ambiguous HTTP status, or network break after a send starts is reported as `outcome_unknown`, not failed, because the write may have reached the gateway. Relay close codes are untrusted and cannot turn a post-send outcome into a definite failure. Cancellation stops the sequence and marks remaining targets `not_attempted`.

The completion boundary `gateway_accepted_not_bot_reply` is not proof of a Bot reply, task completion, or message persistence. The gateway protocol is unofficial and unsupported by xAI; compatibility and security behavior may change without notice. A metadata-only live VM probe verified discovery, authentication, and full-roster access. No live paired-message or background-lifecycle validation is claimed for this beta.

## Logging and diagnostics

Logs and errors must not contain:

- prompt or response content;
- child command arguments;
- stdout or stderr bodies;
- environment values;
- credentials or authentication files;
- gateway URLs or tokens;
- relay URLs, pairing codes, channels, or encryption keys;
- temporary file or directory paths;
- Grok sessions, transcripts, memory, or Bot data.

Allowed operational fields are limited to a request identifier, connector version, elapsed milliseconds, prompt byte count, and a coarse exit category.

Doctor must be read-only and must not submit a model request.

## User responsibilities

- Do not send data to Grok unless you are authorized to share it with xAI.
- Keep `~/.grok/auth.json` private and never attach it to an issue.
- Review xAI account, privacy, and allowance terms before use.
- Verify uncertain failures through the direct Grok CLI before retrying; a request may already have consumed allowance.
- For Bot sends, inspect per-Bot receipts before any new attempt; an accepted or timed-out request may already have reached a Bot.
- Enter pairing codes only in Grok Bot's Computer terminal, never in a Bot/Codex prompt. Rotate with `pair --force` if a code may have been exposed.
- Keep the VM companion in the foreground until a supported lifecycle mechanism is verified. A stopped companion means Bot tools are unavailable, not safe to retry after an uncertain send.
- For the legacy fallback, provide only a gateway URL and token you are authorized to use. Never paste the token into prompts or issue reports.
- Install only audited source or an exact immutable maintainer-controlled release. Never execute a mutable GitHub default branch inside the Grok Bot VM.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or credential exposure. Use the repository's private GitHub **Report a vulnerability** flow when available; otherwise contact the maintainer privately through the source distribution channel.

Include a minimal reproduction, affected revision/version, OS and architecture, Node/Codex/Grok CLI versions, and impact. Redact prompts, outputs, paths, tokens, environment values, and account information.

The maintainer will acknowledge a valid report as soon as practical, coordinate remediation privately, and publish a security advisory when users need to act. There is no paid bug bounty or response-time SLA.

## Out of scope

- Vulnerabilities in Codex, Grok CLI, xAI, Node.js, or the operating system that do not arise from this connector.
- Reports requiring access to another person's account or credentials.
- Social engineering, denial-of-service testing, or testing against xAI infrastructure.
- The behavior, availability, or security of the unofficial Grok Bot gateway itself.
- Denial of service by a relay operator; end-to-end encryption provides confidentiality and integrity, not availability.
