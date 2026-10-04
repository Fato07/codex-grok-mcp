# Security policy

## Supported versions

`0.2.0` is the supported release. Security fixes target the current source revision and the next compatible release.

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

Each request also carries an authenticated timestamp and UUID. The companion rejects requests older than 60 seconds before invoking the gateway, persists send UUIDs to a private bounded ledger before delivery, and caches authenticated responses in memory. The ledger uses a mode-`0700` persistent XDG state directory and mode-`0600` markers; unpairing does not remove fresh markers. A same-process duplicate receives the original receipt; a replay after restart is blocked and reported as `outcome_unknown`. One process-wide in-flight guard remains active across relay reconnects. An exclusive config-path lease prevents concurrent companions, forced re-pairing, or unpairing from racing a live process. Every lease removal first creates a fixed hard-link claim, and every new owner checks that claim before and after exclusive creation. This prevents a stale clearer from moving or deleting a replacement lease. A claim orphaned by an interruption is never reclaimed automatically; inspect, wait, cleanup, and acquisition fail as `companion_lease_recovery_required` until an operator proves that no companion or lifecycle command is running and removes only that claim. Generic lease acquisition fails closed on stale state. An explicit first `install` may reclaim only a valid version-1 foreground lease after candidate and pairing preflight, private same-user directory and file validation, and two identity checks prove its recorded process is gone. Managed stale recovery remains bound to the exact release: `start`, `ensure`, `restart`, same-release `update`, and `rollback` with no previous release preflight and restart that retained release before writing bindings. An `update` or `rollback` to a different release preflights only the target, then clears a proven-dead or not-ours stale lease and starts the target; bindings are published only after that start, unchanged pairing, and an explicit ownership check. A failure before the switch, including target staging, is a no-op: the stale lease, bindings, and release tree stay as they were, no child is started, and the original error is returned. A failed target start may restore the retained release without preflight and never publishes bindings. Maintenance recovery stays bound to the exact lifecycle binding, and failed-candidate cleanup to the exact launch token. Active or unknown identities are never cleared. The same UUID is also sent as the gateway `clientNonce`, but callers do not rely on undocumented host deduplication.

The managed lifecycle uses a detached Node child because the verified Grok Bot VM exposes no systemd, supervisord, or PM2 service manager. Install and update repack the currently invoked package with lifecycle scripts disabled, stage those exact bytes under a private XDG data directory, bind them to their npm SHA-512 integrity, and validate pairing identity plus the local gateway before cutover. The published `npm-shrinkwrap.json` fixes every production dependency version and integrity; staging compares the complete installed production closure with it before executing the candidate. The connector package is not resolved a second time. Package, lifecycle, config, and lease paths reject non-sticky group- or world-writable ancestor chains.

One random private binding ID appears in both a config-side and root-side ownership record. The pair binds one canonical config to one canonical lifecycle root and persists every replay and Grok data root observed before lifecycle mutations. One-sided root-first publication is repaired; config-only state, mismatched identities, and cross-root or cross-config adoption fail closed. Restart, ensure, and rollback use retained exact releases and do not resolve a mutable channel. Uninstall stops only an exact managed process, acquires an exact-binding maintenance lease on the real companion config, removes revalidated lifecycle state and release storage, releases the maintenance lease, then removes config-side and root-side bindings in that order. Pairing, Grok data, and replay state require their own explicit cleanup. The long-lived child receives only home and XDG paths, required Grok gateway discovery values, and its managed launch fields. It inherits no npm, provider, cloud, or unrelated application environment variables. Pairing is read before and after cutover but never copied, rewritten, or printed.

The companion uses a Node-20-compatible local client for a bounded loopback-only command set: discovery, health, `listAgents`, `getHostStatus`, transcript-tail and activity-status reads, exact-ID `sendPrompt`, and the attachment RPCs `uploadAttachment` and `readAttachmentChunk`. Attachment capabilities are advertised only after `getHostStatus.hostVersion` matches a pinned allowlist (`f5c783a`). `CODEX_GROK_ATTACHMENT_HOST_ALLOWLIST_EXTRA` can add tester pins; it is never default-on and is logged as an unverified host. Attachment ops fail closed with `UPGRADE_REQUIRED` when the host is unknown; text tools are unaffected. The contract was cross-checked against the MIT-licensed `grokbot-sdk`; the full SDK is not installed because it declares Node.js 22 while the verified VM provides Node.js 20. Each whole bridge operation pins one verified descriptor/token snapshot, including its roster check and subsequent reads or send. Every subrequest verifies that snapshot before dispatch and again after the complete bounded body passes schema validation; rotation fails closed without retry. For a send, any failure after send dispatch remains delivery-uncertain. Standalone client calls outside a bridge operation resolve a fresh snapshot per request. The client also bounds response bytes and duration, rejects redirects and non-loopback URLs, normalizes an upstream wildcard bind advertisement to `127.0.0.1` instead of connecting to the wildcard address, validates descriptor ownership and permissions, verifies on Linux that the descriptor PID owns the listening socket, validates response shapes, and sanitizes errors. Descriptor uid is checked on the file; listener uid is implicit through `/proc/<pid>/fd` readability. If `SAND_HOST_PORT` or `SAND_GATEWAY_BIND_HOST` are set, they are read after those descriptor checks and must agree with `gateway.json`. A mismatch never bypasses descriptor or ownership checks. Direct client and companion probe or run calls fail closed with an explicit named mismatch error. During managed `install`, `update`, or `rollback` the same check runs in the preflight child and is reported as `candidate_invalid` with reason `GATEWAY_ENV_MISMATCH`. Verification still requires the descriptor pid to own the listener. A same-uid process can forge a descriptor (same-uid is the same trust domain). There is a narrow residual case if a reused pid also owns the listening port, and a TOCTOU gap between verification and the request (per-request re-resolve catches descriptor swaps only). The gateway token stays in VM memory and is never returned to Codex or the relay. The companion does not expose arbitrary gateway commands, raw transcript rows, files, shell, delete/reset, or credential APIs. It refreshes the roster before every read or send.

`grok_bridge_status` is always registered. Without pairing it returns only connector mode and version; with the legacy direct adapter it does not probe the gateway. In paired mode, its authenticated protocol-v3 request returns only the companion version, bounded protocol versions and capability names, gateway health/busy booleans, and non-group Bot count. The MCP side requires every protocol and capability used by its current Bot tools while tolerating additional bounded future capabilities. Bot identities, relay details, credentials, paths, transcripts, and prompts are excluded by a strict response schema.

`grok_read_bot` is read-only and requires an exact ID from the current non-group roster. It accepts at most 50 recent source entries, returns only recognized plain-text message shapes, removes raw identities and metadata, normalizes line endings, strips control and bidirectional-override characters, and bounds each message to 16 KiB, aggregate text to 48 KiB, and the normalized snapshot to 64 KiB. Streaming, tool, widget, event, unknown, and malformed entries are omitted. Protocol v4 adds metadata-only `attachments[]` (`entry_id`, seq, speaker, sanitized name, kind, optional size, timestamp). Paths and URLs never leave the companion. https URLs are reported as not fetchable. Returned text and fetched bytes remain sensitive, untrusted external content and must not be treated as instructions, executed, extracted, or auto-opened.

`grok_fetch_bot_attachment` re-reads a fresh transcript tail, locates the entry by id, and takes the path from that entry only. The realpath must stay under `agents/<bot_id>/{attachments,assets}`. Box paths (`/workspace`, `/home`, `/tmp`, `/root`) and other Bots' directories are always rejected. Codex- or Bot-supplied paths are never forwarded to `readAttachment*`. Caps are 2 MiB generic and 5 MiB for images.

`grok_send_bot_attachment` accepts exactly one regular file: lstat with no symlink, `O_NOFOLLOW` open, fstat dev/ino recheck, non-empty, at most 2 MiB, and an extension plus magic-byte allowlist (`txt`, `md`, `json`, `csv`, `diff`/`patch`, `pdf`, `png`, `jpeg`). HTML, SVG, archives, and executables are rejected. The preview binds identity, size, MIME, sha256, exact Bot ID, roster fingerprint, and sanitized display name. Native confirmation is required. Relay chunks are 64 KiB, replay-checked per `(upload_id, seq)`, and staged in a private 0700 companion directory with 0600 `O_EXCL` files and a 15-minute TTL. Commit rechecks the roster, uploads once, and accepts the host path only when its basename is `<sha256><ext>` directly under that Bot's attachments directory. The opaque `attachment_ref` never includes a VM path. Host-committed attachments persist with the Bot; this connector cannot delete them. Live verification is pending.

`grok_wait_for_bot` is an MCP-side bounded loop over the same exact-ID read path, not a new bridge operation or event stream. It retains only the latest bounded snapshot, applies an end-to-end deadline of at most 120 seconds across roster lookup, relay queueing, reads, and waits, stops only on observed `idle` or `awaiting_user` activity or timeout, and propagates cancellation or the first failed read without retry. Its `observed_working` field distinguishes later idle activity from an initially idle Bot, and its result preserves the same untrusted-content, no-correlation, and no-completion-claim boundaries.

Read pagination wraps the upstream sequence boundary in a canonical, Bot-bound API cursor. The cursor is opaque by contract, not secret or tamper-proof; callers must pass it back unchanged. Read output states `content_boundary: "sanitized_text_only"`, `correlation: "not_claimed"`, and `completion_boundary: "activity_snapshot_not_task_completion"`: status is a point-in-time activity signal, not proof of task completion, and transcript order does not prove that a message replies to a particular send. Status uses bridge protocol v3 and advertises v4 when the companion supports attachments. Reads remain v2-compatible; v4 adds attachment metadata. v1 roster and text send operations remain compatible. An older companion that rejects status, a read, or an attachment op is surfaced as `UPGRADE_REQUIRED` and must be updated and restarted. Attachment-specific errors are `ATTACHMENT_REJECTED`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_STALE`, and `ATTACHMENT_INTEGRITY`. `delivery_may_have_occurred` applies only to the send step; there is no automatic retry after an ambiguous send.

The legacy direct adapter remains available for manual power users only when both `GROKBOT_GATEWAY_URL` and `SAND_GATEWAY_TOKEN` are explicitly configured outside the plugin wrapper. The connector must not discover them by scraping Grok Bot app state, decrypting local descriptors, reading Keychain, or inspecting another process. Remote direct URLs require HTTPS; plaintext HTTP is accepted only on loopback for operator-managed SSH or VPN forwarding.

Bot sends are external writes. `grok_send_bot_message` requires an exact Bot ID from `grok_list_bots`. An empty `grok_ping_all_bots` call is a no-write preview; the write requires the current `roster_fingerprint`, every exact listed `bot_id`, and `confirmation: "PING_ALL"`, followed by an accepted native MCP user-confirmation request containing the recipients. It rechecks the roster, sends the fixed message `PING` sequentially, records a per-Bot receipt, and never retries automatically. It does not use a native broadcast endpoint. A roster change or declined confirmation fails closed without sending.

A timeout, cancellation, malformed response, ambiguous HTTP status, or network break after a send starts is reported as `outcome_unknown`, not failed, because the write may have reached the gateway. Relay close codes are untrusted and cannot turn a post-send outcome into a definite failure. Cancellation stops the sequence and marks remaining targets `not_attempted`.

The send completion boundary `gateway_accepted_not_bot_reply` is not proof of a Bot reply, task completion, or message persistence. The gateway protocol is unofficial and unsupported by xAI; compatibility and security behavior may change without notice. A live paired operator smoke test verified roster listing, unique exact-ID gateway acceptance receipts, and later bounded transcript observation without connector errors or retries. A separate live managed-lifecycle matrix verified install idempotence, pre-cutover failure preservation, exact update, restart, rollback, and candidate restoration while pairing bytes and permissions remained unchanged. Neither result proves reply correlation or task completion.

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
- Enter pairing codes only in Grok Bot's Computer terminal, never in a Bot/Codex prompt. `pair --force` changes the saved channel for future processes but does not revoke the old stateless relay channel. If pairing material may have been exposed, stop both sides, end old Codex tasks, rotate the relay master, and pair again.
- Use the exact-version managed lifecycle for unattended companion persistence. A stopped companion means Bot tools are unavailable, not safe to retry after an uncertain send.
- Never run lifecycle mutations from different connector versions concurrently. If `companion_lease_recovery_required` appears, stop every related process and follow the narrow claim-only recovery rule in the README; never delete pairing or the canonical lease to bypass it.
- For the legacy fallback, provide only a gateway URL and token you are authorized to use. Never paste the token into prompts or issue reports.
- Prefer audited source or an exact immutable maintainer-controlled release. The optional npm `@beta` command accepts mutable-channel risk to update on restart; do not use it where unattended beta code is unacceptable. Never execute a mutable GitHub default branch inside the Grok Bot VM.

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
