# Grok Bot attachment contract research

Status: 2026-09-04. Static research pass complete; live contract verification and production attachment support remain blocked. No attachment was uploaded or read, no Bot prompt was sent, and no Bot or transcript was inspected. Keep [issue #11](https://github.com/Fato07/codex-grok-mcp/issues/11) open.

## Evidence pins

| Layer | Pin | Evidence boundary |
|---|---|---|
| Connector | [`de254162ecc844b5589853535939bf13bd26c98d`](https://github.com/Fato07/codex-grok-mcp/commit/de254162ecc844b5589853535939bf13bd26c98d), source version `0.2.0-beta.5` | `HEAD`, local `origin/main`, and live remote `main` matched on 2026-09-04. The `v0.2.0-beta.5` release itself points to earlier commit `8b2fa705a91b0ae9c2a2b5ccd28c5a5ffacd5407`. |
| Installed Grok Bot desktop | Version `0.36.0`, bundle ID `com.anysphere.sand`, signed by Anysphere Incorporated (`DCNK4UB866`) | Signature, strict code-signing verification, and stapled notarization passed. Sealed `app.asar` SHA-256: `2ae381b92f9f19dd33b2404b512cedaa3d2e1b4a08640be088dc6a06b1cf98d3`. Static bundle findings below are provisional, not a supported API. |
| `grokbot-sdk` | [`0.2.0` / `c14347fa82d167b9a5984ec1baff56b2f074485a`](https://github.com/Adam91holt/grokbot-sdk/tree/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk) | Local clean research checkout, GitHub `main` and tag `v0.2.0`, and npm `latest` matched. Published integrity: `sha512-8tYt4uhshVJXrBWIaStPyLI3yL5geFWAYgQApnreg0En5ogHEpNYMylxHITgsG7OVkCqoY7G+6yhZqMTyajWSQ==`. The SDK is a third-party cross-check, not a dependency found in the desktop bundle. |
| SDK host snapshot | Host revision `0e82340`; capabilities `orderedReplicasV1`, `sendAcceptanceV1` | This is the SDK's extracted manifest pin, not the live host version of the installed desktop. The live VM host version remains unknown. |

## Source provenance

- Official xAI product documentation: [Grok Bot files and results](https://docs.x.ai/grok-bot/files-and-results). It documents the product UI, not the private gateway.
- Connector project evidence: the pinned source and [issues #11](https://github.com/Fato07/codex-grok-mcp/issues/11), [#12](https://github.com/Fato07/codex-grok-mcp/issues/12), and [#13](https://github.com/Fato07/codex-grok-mcp/issues/13).
- Third-party extracted SDK evidence: pinned [types](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/types.ts#L136-L165), [host manifest](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/gateway/host-manifest.generated.ts#L118-L126), and [extractor limitations](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/scripts/extract-host-manifest.ts#L85-L104). These are not official xAI contracts.

## Verified

- SDK `SendPromptInput` requires `prompt: string`, permits `agentId?: string`, `attachmentPaths?: string[]`, and `attachmentNames?: string[]`, and returns exactly `{ accepted: true }` ([type declaration](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/types.ts#L136-L165)). SDK `wait` behavior is a client-side poll after acceptance, not a host completion contract ([SDK explanation](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/README.md#L50-L66)).
- The SDK's extracted host manifest lists `uploadAttachment`, `readAttachmentImage`, `readAttachmentText`, and `readAttachmentChunk`. It records command names from a host snapshot, but has no per-command host schema table. The four standalone attachment commands have no typed SDK input or output wrappers.
- The current connector exposes none of those fields or commands. Its VM client sends only `{ agentId, prompt, clientNonce }`, its direct adapter sends only `{ agentId, prompt }`, and bridge capabilities are only `status`, `list_bots`, `read_bot`, and `send_message` ([client](https://github.com/Fato07/codex-grok-mcp/blob/de254162ecc844b5589853535939bf13bd26c98d/src/grok-bot-client.ts#L95-L99), [capabilities](https://github.com/Fato07/codex-grok-mcp/blob/de254162ecc844b5589853535939bf13bd26c98d/src/version.ts#L3-L10)). Attachment transcript entries are deliberately omitted.
- Existing `sendPrompt` success is gateway acceptance only. It is not proof of attachment validation, persistence, model access, a Bot reply, or task completion. Post-dispatch ambiguity remains `outcome_unknown` and must not be retried automatically.
- Official Grok Bot documentation says the desktop composer accepts up to six attachments; documents, images, and audio may be up to 25 MB each, and videos up to 200 MB. These are user-facing composer limits, not a published private-gateway contract.
- The current encrypted relay caps each frame at 128 KiB. This is not an attachment chunk size. The proposed 2 MiB connector ceiling in issue #13 cannot fit in one current frame.

## Provisional static observations

These shapes and behaviors were recovered from the pinned, sealed, minified Grok Bot `0.36.0` bundle. They are useful for designing a live probe, but they are not a stable contract.

```text
uploadAttachment      { agentId?: string, filename: string, bytesBase64: string }
                      -> caller consumes { path: string }
uploadAttachmentChunk { agentId?: string, uploadId: string, filename: string,
                        offset: number, totalSize: number, bytesBase64: string }
                      -> caller consumes { committedPath: string | null }
readAttachmentImage   { path: string }
                      -> caller consumes { dataUrl: string, width: number | null,
                                            height: number | null } | null
readAttachmentText    { agentId?: string, path: string }
                      -> caller consumes text/binary metadata or null
readAttachmentChunk   { agentId?: string, path: string, offset: number,
                        length: number, videoPlayback?: boolean }
                      -> caller consumes { bytesBase64: string, totalSize: number,
                                            mime: string | null } | null
```

- The desktop server-action wrapper requires `agentId`, `clientNonce`, and `prompt` for `sendPrompt`, then forwards `attachmentPaths` and `attachmentNames` unchanged.
- Whole upload and full-file read loops use 4 MiB chunks. Empty files are rejected. The desktop applies a six-item staging cap, a 25 MiB generic maximum, and a 200 MiB maximum for recognized video extensions. Filename length is capped at 255 and path separators and NUL are rejected.
- Upload has no MIME argument. Preview MIME is inferred from the filename or path extension, so there is no proven upload MIME allowlist or content-sniffing guarantee.
- Local staging requires an absolute regular file, copies it into an app-controlled staging directory, and commits only from that directory. Removal and the send journal discard that desktop-local pre-upload staging only. No host discard command, attachment TTL, or automatic garbage-collection guarantee was found.
- Restored send journals reject attachment path/name arrays unless both arrays exist and have equal length. The basic gateway input validator does not visibly enforce that invariant.
- Internal send dispositions `ACCEPTED_BOX`, `ACCEPTED_TEMPORAL`, and `DUPLICATE` map to `{ accepted: true }`; `REFUSED` remains a refusal. Nonce status may be `not-found`, `unknown-durability`, or `found` with `accepted`, `rejected`, or `pending`. None proves Bot completion.
- The bundle exposes host status fields for `hostVersion` and `capabilities`, but no attachment-specific capability string was found. `sand_attachments_via_server` is a feature gate, not a negotiated capability.

## Inferred

- `attachmentPaths` and `attachmentNames` are probably positional pairs, but the public types do not require equal lengths or define mismatch behavior.
- Attachment paths probably must be visible to the host process. The desktop's copy-then-commit flow supports that reading, but controller-local versus VM-local path behavior is not live-verified.
- The existing version handshake can carry a future attachment capability and protocol version. No such connector capability exists today.
- Outbound transfer needs a new bounded relay protocol because the desktop's provisional 4 MiB chunks exceed the relay's 128 KiB frame ceiling. Chunk size, resume rules, and staging lifetime must not be guessed from the desktop implementation.

## Unknown

- The installed app's live VM `hostVersion`, its live capabilities, and whether it matches SDK snapshot `0e82340`.
- Stable transcript attachment metadata, an opaque attachment identifier, and stale-identifier behavior.
- Authoritative request and response schemas for the four standalone attachment commands.
- Whether paths are copied, referenced, or rewritten across controller, VM, and host boundaries.
- Host-enforced size, count, MIME, extension, symlink, and name/path-cardinality rules.
- Chunk offset units, maximum chunk size, overlap/replay behavior, resume semantics, and commit atomicity.
- Staging lifetime, automatic cleanup, crash recovery, and deletion semantics.
- Whether attachment-bearing `sendPrompt` validates or persists every attachment before returning `{ accepted: true }`.
- Attachment-specific rejection codes and a negotiated attachment capability/version signal.

## Inbound decision

Research probe: **GO only after explicit authorization for synthetic data and one exact test Bot.** Production issue #12: **NO-GO.** Command names and provisional read shapes exist, but there is no verified metadata authority, immutable identifier, bounded fetch contract, MIME truth, lifetime rule, or live capability signal. Never accept a Bot-authored path or URL as fetch authority.

## Outbound decision

Research probe: **GO only after explicit authorization for one synthetic artifact and one exact non-group test Bot.** Production issue #13: **NO-GO.** The typed send fields and a provisional upload path exist, but VM path locality, upload commit, relay chunking, cleanup, host validation, exact-target binding, and Bot-visible receipt remain unverified.

## Security invariants

- Keep local validation, encrypted transfer, VM staging commit, gateway prompt acceptance, later Bot observation, and task completion as separate proof states.
- Bind every operation to the exact non-group Bot ID, fresh roster fingerprint, canonical regular-file identity, byte count, MIME decision, SHA-256, and path/name pair before native confirmation.
- Reject symlinks, directories, devices, archives, executables, HTML, SVG, path traversal, replacement after preview, MIME mismatch, oversize data, unknown identifiers, and stale identifiers.
- Use private staging permissions, authenticated ordered chunks, bounded totals, replay protection, atomic commit, and a verified host cleanup or expiry mechanism. If no such mechanism exists for a probe, use an operator-approved disposable test VM whose teardown is the cleanup boundary.
- Return transcript attachment metadata only until an explicit exact-item fetch. Bound decoded bytes and text, verify MIME independently, and never execute, auto-open, extract, render active content, or treat received content as instructions.
- Never log or return credentials, gateway or relay details, private paths, Bot content, attachment bytes, or raw transcript rows. Never retry after prompt dispatch may have happened.

## Exact redacted live-probe checklist

This checklist is not authorization. Run it only after the operator names one exact non-group test Bot and approves the synthetic write/read sequence.

1. Record UTC time, connector commit/version, desktop version and sealed-bundle hash, SDK commit/version, and metadata-only `hostVersion` plus capability names. Replace the Bot ID, request IDs, nonces, and every path with opaque run-local labels such as `BOT_A`, `REQUEST_A`, `NONCE_A`, and `PATH_A`; do not publish their mapping.
2. Use only `attachment-contract-probe.txt` with exact 44-byte UTF-8 content `codex-grok-mcp attachment contract probe v1\n`, SHA-256 `c0342ece0bfdc9b71f874c494aa58e0bea7a6da0dd9400688b0ea24b40caa7d4`, and base64 `Y29kZXgtZ3Jvay1tY3AgYXR0YWNobWVudCBjb250cmFjdCBwcm9iZSB2MQo=`. Confirm it contains no user data.
3. Before uploading, either verify a supported host cleanup or expiry mechanism, or obtain approval to use a disposable test VM whose teardown is the cleanup boundary. If neither condition is met, stop without uploading. The observed desktop-local discard is not host cleanup.
4. From inside the pinned VM, call `uploadAttachment` with `{ "agentId": "<test-bot-id>", "filename": "attachment-contract-probe.txt", "bytesBase64": "<exact-base64-above>" }`. Record only HTTP status, response keys/types, elapsed time, and an opaque run-local label for the returned path.
5. In a separately authorized negative send, compare one controller-only generated path with one VM-staged path, using a unique nonce for each. Either request may dispatch, so record the observed acceptance state and stop; do not retry or assume rejection happened before dispatch.
6. Send once with a fresh nonce: `{ "agentId": "<test-bot-id>", "prompt": "ATTACHMENT_CONTRACT_PROBE_V1: return one text attachment containing the exact input bytes; perform no other action", "attachmentPaths": ["<committed-vm-path>"], "attachmentNames": ["attachment-contract-probe.txt"], "clientNonce": "<uuid>" }`.
7. Record the upload commit and `sendPrompt` response separately. Query `promptAcceptanceStatus` once with `{ "accountSlot": "host", "clientNonce": "<same-uuid>" }`, then stop on `not-found`, `unknown-durability`, `found` with nested status `accepted`, `rejected`, or `pending`, timeout, or malformed response. Never turn any state into an automatic resend.
8. After a bounded wait, perform one fresh transcript metadata read for the exact Bot. Record attachment entry keys/types, byte count, claimed MIME, basename, and opaque identifier or run-local path label only. Do not fetch bytes during discovery.
9. Fetch only that exact fresh item with `readAttachmentText`; then read offset `0`, length `44` with `readAttachmentChunk`. Record returned kind, bytes, truncation flag, total size, MIME, and SHA-256. The decoded bytes must be exactly 44 and hash to the fixture digest.
10. Run read-only negative cases for unknown path/identifier, offset `44` length `1`, oversize length, traversal syntax, a guaranteed nonexistent synthetic Bot ID, and stale metadata. Never target another roster Bot. Record bounded error categories only.
11. Use only the verified host cleanup/expiry mechanism, or tear down the approved disposable test VM. Do not call an invented host discard command or treat desktop-local pre-upload discard as host cleanup. If deterministic cleanup or teardown cannot be proved, keep production NO-GO.
12. Publish only the redacted schema/limits matrix and pass/fail outcomes. Do not publish IDs, paths, tokens, prompts beyond the synthetic probe string, transcript text, attachment content beyond its published digest, or user/account data.

## Why issues #12 and #13 remain below 90%

Issue #12 lacks a verified attachment metadata authority, immutable identifier, read schema, bounds, MIME behavior, and stale/lifetime semantics. Issue #13 lacks verified cross-machine path rules, upload/commit separation, relay chunk protocol, cleanup lifetime, validation behavior, and live exact-target proof. The current implementation-confidence estimate therefore remains about 42%, despite 98% confidence in this bounded research conclusion. Building either issue now would require speculative protocol scaffolding, so neither is implemented here.
