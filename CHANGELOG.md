# Changelog

All notable changes will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0-beta.1] - Unreleased

### Added

- Opt-in paired Grok Bot bridge: outbound VM companion, channel-scoped bearer-protected opaque hibernating relay, AES-256-GCM frames, and private mode-`0600` pairing files.
- `codex-grok-mcp pair` / `unpair` and `codex-grok-bridge probe` / `connect` / `run` / `unpair` commands.
- A metadata-only live VM probe verified local gateway discovery, authentication, and a full non-group roster on Node.js 20.19.2.
- A legacy direct URL/token transport retained outside the default plugin wrapper for power users.
- `grok_list_bots` for exact IDs, names, running state, and a roster fingerprint.
- `grok_send_bot_message` for one exact-ID send with a gateway-acceptance receipt.
- `grok_ping_all_bots`: no-write preview, fingerprint-bound second call, native MCP user confirmation, then sequential `PING` sends with per-Bot receipts and no automatic retries.
- Honest uncertain-write receipts: interrupted sends are `outcome_unknown`; cancellation leaves remaining Bots `not_attempted`.
- Node-20-compatible loopback gateway client with bounded responses and no Node-22 SDK runtime dependency.
- Persistent replay prevention, cached replay receipts, and a process-wide send guard that survives relay reconnects.
- Loopback gateway process verification and explicit relay observability disablement.

### Known limitations

- Persistent named Grok Bot access still uses an unofficial upstream gateway and may break when Grok Bot changes.
- The VM companion is foreground-only until survival across idle periods and computer updates is verified.
- No hosted relay is deployed by this source change; users must deploy the included relay or supply a compatible one.
- Gateway acceptance does not prove a Bot replied, completed work, or persisted a message.
- No live paired-message validation is claimed.

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
