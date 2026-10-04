# Changelog

All notable changes will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0-beta.10] - 2026-10-04

Prerelease. Stable `0.2.0` is not published; this beta carries every change since `0.2.0-beta.9`.

### Added

- Bounded inbound Bot attachments (#12): `grok_read_bot` can return metadata-only attachment rows, and `grok_fetch_bot_attachment` serves one transcript entry as an untrusted MCP resource or image after a fresh roster and path lookup.
- Bounded outbound Bot attachments (#13): `grok_send_bot_attachment` validates one local file, binds a native confirmation to that exact Bot and file identity, then stages, commits, and sends it once.

### Security

- Inbound fetch takes the path only from a fresh transcript entry, opens once with `O_NOFOLLOW`, requires a regular file with `nlink === 1`, and pins the opened fd. Hardlinks, dangling symlinks, other Bots' directories, and missing `/proc/self/fd` fail closed.
- Outbound send denies credential, pairing, CLI home, and Sand `gateway.json`/`config/` trees by resolved path, file identity, and ancestor identity. Every `$SAND_USER_DATA_DIR/{sand-data,agent-data}` root is denied whenever that variable is set, including when `SAND_DATA_ROOT` is also set.
- Attachment capabilities are advertised only for a pinned host version. Host-committed files persist with the Bot; this connector cannot delete them. Live Bot attachment delivery is unverified.

### Fixed

- The installed-package candidate check no longer runs the build under npm 9/10, and npx's `npm_execpath` pointing at `npx-cli.js` is resolved to a sibling `npm-cli.js` when present.
- A whitespace-padded `SAND_USER_DATA_DIR` is trimmed before it is resolved (`sandUserDataDir` in `src/grok-bot-client.ts`, used by `managedChildEnvironment`). Previously `'  /srv/u  '` was resolved relative to cwd.
- A failed `update` or `rollback` target start restores the prior run state: the retained release is restarted only if the companion was running before the switch. A stopped companion stays stopped (`update_failed_restored`); `state.json` is unchanged and staging leftovers are removed.
- `install` without a valid pairing now fails with `PAIRING_REQUIRED` before staging a release, writing bindings, or taking a lease, and leaves nothing on disk.

### Verified boundaries

- macOS is the supported host path. Automated coverage also runs on Ubuntu with Node.js 20.19.2, 22, and 24, but Linux live support remains unverified.
- Gateway acceptance, transcript observation, Bot activity, and task completion remain separate proof levels.
- Persistent Bot access relies on an unofficial Grok Bot gateway and remains explicitly experimental.
- Live verification of outbound attachment acceptance, Bot-visible receipt, Temporal inbound shape, and HTTP error shapes has not been run.

## [0.2.0-beta.9] - 2026-10-04

Prerelease. Stable `0.2.0` is not published; this beta carries every change since `0.2.0-beta.8`.

### Added

- Local MCP access for isolated Grok calls and opt-in collaboration with named Bots already running inside Grok Bot.
- Exact-version managed companion install, status, start, stop, ensure, restart, update, retry-safe rollback, and pairing-preserving uninstall.
- Exact-artifact lifecycle staging from the currently invoked package, avoiding a second package-version resolution during install or update.
- Published npm shrinkwrap enforcement for the complete production dependency closure.

### Security

- End-to-end encrypted paired transport with bounded reads, exact-ID sends, replay protection, strict local gateway validation, and no automatic retry after an uncertain write.
- Pairing-preserving lifecycle cutovers with candidate preflight, private state, exact process identity, and fail-closed stale recovery.
- Paired config/root ownership records, persisted protected data roots, maintenance-lease uninstall exclusion, and hard-link lease claims that prevent stale cleanup from displacing a new owner.
- `update` and `rollback` to a different release preflight only the target and publish bindings only after start, unchanged pairing, and an explicit ownership check on every cutover; release-tree migration is limited to the exact legacy `0755` shape and rejects mixed trees without chmod; tests never resolve the real Grok Bot data root.

### Fixed

- Recover a stale managed companion that predates lifecycle ownership bindings: only an exact retained release is recovered, only its proven-stale lease is cleared, and bindings are written only after the restarted process and its working directory are verified.
- Migrate a release tree restored with legacy `0755` directories to `0700` instead of failing every start with `candidate_invalid`; any other unsafe shape fails closed with a named `RELEASE_TREE_*` reason and no mode change.
- Accept the genuine local gateway after the VM is paused and resumed: gateway verification no longer compares the descriptor start time against a process start time that drifts across pauses, and still requires the descriptor PID to own the listening socket (`GATEWAY_VERIFICATION_FAILED` otherwise).
- Report `SAND_HOST_PORT` / `SAND_GATEWAY_BIND_HOST` disagreement with the gateway descriptor as an explicit `GATEWAY_ENV_MISMATCH` (`candidate_invalid` with that reason in managed preflight).
- The installed-package candidate check no longer runs the build under npm 9/10, and npx's `npm_execpath` pointing at `npx-cli.js` is resolved to a sibling `npm-cli.js` when present.

### Changed

- A failed target stage or other failure before the switch during `update` or `rollback` from stale makes no state change except the existing lifecycle-root `0700` tightening. The stale lease, bindings, and release tree stay as they were; no child is started; the original staging or preflight error is returned unchanged. Earlier builds restarted the retained release when staging failed.
- Update relay development tooling (wrangler, Cloudflare vitest plugin, sharp override) to clear dependency-audit advisories; runtime dependencies are unchanged.

### Verified boundaries

- macOS is the supported host path. Automated coverage also runs on Ubuntu with Node.js 20.19.2, 22, and 24, but Linux live support remains unverified.
- Gateway acceptance, transcript observation, Bot activity, and task completion remain separate proof levels.
- Persistent Bot access relies on an unofficial Grok Bot gateway and remains explicitly experimental.

## [0.2.0-beta.8] - 2026-09-05

### Fixed

- Let the first managed `install` reclaim only a strictly revalidated dead foreground lease, while preserving pairing and refusing active, unknown, malformed, or managed-mismatch leases.

### Changed

- Clarify that `install` bootstraps managed lifecycle and `ensure` only repairs an existing installation.

## [0.2.0-beta.7] - 2026-09-04

### Changed

- Separate deterministic pull-request and `main` CI from explicitly dispatched or tagged dependency audits, which remain bounded and fail closed.

## [0.2.0-beta.6] - 2026-09-04

### Added

- Managed VM companion commands for exact-version install, start, status, stop, ensure, restart, update, and retry-safe rollback.
- A private current/previous release store with candidate preflight, detached-process readiness, exact process identity, and bounded stale-lease recovery.

### Changed

- Drain an in-flight Bot request before a companion shutdown can release its lease.
- Revalidate the pairing file identity across lifecycle cutover without rewriting or printing it.

### Fixed

- Prevent a clean managed shutdown from being misreported as an invalid lease when the lease disappears between filesystem checks.

## [0.2.0-beta.5] - 2026-09-03

### Added

- An interactive architecture explorer and a structured bug report template.

### Changed

- Focus the README and website on collaboration with named Bots already running in Grok Bot.
- Type-check the relay in CI and release verification, and omit the duplicate plugin icon from the npm package.

### Fixed

- Reject control and bidirectional formatting characters in Bot IDs and names before they can appear in recipient previews.
- Keep request-start logs to the documented event and request identifier allowlist.

## [0.2.0-beta.4] - 2026-09-03

### Fixed

- Preserve the safe `DATA_ROOT_SYMLINK` reason when `codex-grok-bridge probe` rejects a symlinked Grok Bot data root, without exposing the path or weakening descriptor validation.

## [0.2.0-beta.3] - 2026-09-03

### Fixed

- Accept the managed Grok Bot gateway's wildcard URL advertisement while still connecting only through `127.0.0.1`; non-loopback gateway targets remain rejected.

### Changed

- Document an opt-in `@beta` companion command for automatic updates on restart while retaining immutable exact-version pins as the default.

## [0.2.0-beta.2] - 2026-09-03

### Fixed

- The VM companion now reports existing allowlisted gateway error codes from `probe` and `run`, while arbitrary exception details remain redacted.

## [0.2.0-beta.1] - 2026-09-03

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
