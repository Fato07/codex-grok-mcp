# Changelog

All notable changes will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0-beta.1] - Unreleased

### Added

- Opt-in paired Grok Bot bridge: outbound VM companion, channel-scoped bearer-protected opaque hibernating relay, AES-256-GCM frames, and private mode-`0600` pairing files.
- `codex-grok-mcp pair` / `unpair` and `codex-grok-bridge probe` / `connect` / `run` / `unpair` commands.
- A metadata-only live VM probe verified local gateway discovery, authentication, and a full non-group roster on Node.js 20.19.2.
- A legacy direct URL/token transport retained outside the default plugin wrapper for power users.
- `grok_list_bots` for exact IDs, names, running state, and a roster fingerprint.
- `grok_read_bot` for exact-ID, read-only activity snapshots and bounded sanitized recent text, with Bot-bound opaque pagination and explicit untrusted-content, no-correlation, and no-completion-claim boundaries.
- `grok_wait_for_bot` for bounded read-only polling until activity is idle, awaiting the user, or the timeout expires; failed reads are never retried.
- `grok_send_bot_message` for one exact-ID send with a gateway-acceptance receipt.
- `grok_ping_all_bots`: no-write preview, fingerprint-bound second call, native MCP user confirmation, then sequential `PING` sends with per-Bot receipts and no automatic retries.
- Honest uncertain-write receipts: interrupted sends are `outcome_unknown`; cancellation leaves remaining Bots `not_attempted`.
- Node-20-compatible loopback gateway client with bounded responses, protocol-v2 read support, explicit `UPGRADE_REQUIRED` for older companions, and no Node-22 SDK runtime dependency.
- Persistent replay prevention, cached replay receipts, and a process-wide send guard that survives relay reconnects.
- Persistent private replay state that survives companion restarts, plus an exclusive fail-closed companion lease that blocks concurrent `run`, forced reconnect, and unpair operations without racing to reclaim stale locks.
- Per-operation gateway descriptor/token pinning, pre/post-response verification, fail-closed rotation detection, and no automatic retry.
- Always-available `grok_bridge_status`, with safe unpaired/direct states and an authenticated paired protocol-v3 capability and health handshake.
- Abort-aware relay queueing and companion-close propagation, so cancelled waits exit promptly and older companions surface `UPGRADE_REQUIRED` instead of timing out.
- Loopback gateway process verification and explicit relay observability disablement.
- A live paired smoke test listed 20 Bots, obtained 20 unique exact-ID gateway acceptance receipts, and observed later bounded Bot transcript entries without connector errors or retries. This proves asynchronous outbound and inbound operation, not reply correlation or task completion.

### Known limitations

- Persistent named Grok Bot access still uses an unofficial upstream gateway and may break when Grok Bot changes.
- The VM companion is foreground-only until survival across idle periods and computer updates is verified.
- No hosted relay is deployed by this source change; users must deploy the included relay or supply a compatible one.
- Bot activity and sanitized transcript order do not prove task completion or send/reply correlation.
- Gateway acceptance does not prove a Bot replied, completed work, or persisted a message.
- Live testing does not yet establish background-process survival, send/reply correlation, or production resilience.

## [0.1.0-alpha.1]

### Added

- Initial local stdio MCP bridge with one `grok_ask` tool and web access disabled.
- Read-only doctor command for local prerequisite checks.
- Source-only Codex plugin and repository marketplace packaging.
- Explicit Grok CLI isolation, model pinning, limits, and cleanup boundary.

### Known limitations

- Only the current macOS environment is targeted for initial live verification.
- Linux and Windows are unverified.
- Persistent named Grok Bot conversations and memory are not supported.
- No npm package, GitHub release, or universal Plugins Directory listing exists yet.
