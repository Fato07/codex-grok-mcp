# v0.2.0 stable release gate

This is the sole maintainer checklist for promoting `codex-grok-mcp` from beta to stable. The default decision is **NO-SHIP** until every required item passes.

Run the checklist from a clean checkout of the final candidate commit. Every proof must name and come from that same 40-character commit SHA. Any source, test, lockfile, metadata, workflow, or documentation change creates a new candidate and invalidates earlier proof. Earlier beta results are context, not acceptance evidence.

Copy this file outside the candidate checkout to record results and evidence links. Never edit the candidate checkout while testing, because that would create a different candidate.

## Candidate identity

Record one immutable identity before testing:

| Field | Required value |
|---|---|
| Package | `codex-grok-mcp@0.2.0` |
| Intended Git tag | `v0.2.0` |
| Final candidate commit | `<40-character SHA>` |
| Packed artifact | `codex-grok-mcp-0.2.0.tgz` |
| Artifact integrity | `<integrity from npm pack --json>` |
| Rollback package | `codex-grok-mcp@<previous verified exact version>` |
| Evidence record | `<durable URL>` |

- [ ] The checkout is clean and `HEAD` equals the recorded candidate commit.
- [ ] Package metadata, both identical root lockfiles, source version, plugin metadata, launcher pin, public documentation, packed manifest, and intended tag all identify `0.2.0`.
- [ ] The packed artifact was built from the recorded commit outside the checkout and matches the recorded SHA-512.
- [ ] Every live candidate install verifies that artifact's SHA-512 first, then invokes the local tarball directly. The managed lifecycle must report the same package version after staging the currently invoked bytes. No command uses `@beta`, `@latest`, or an unpinned branch.

## Required dependencies

Each dependency must be complete, included where applicable in the final candidate, and linked from the evidence record.

- [ ] [#4, one-command companion lifecycle and safe upgrade](https://github.com/Fato07/codex-grok-mcp/issues/4): exact-version install, status, update, restart, and rollback preserve pairing and recover the prior version after failure.
- [ ] [#5, clean install, upgrade, rollback, and uninstall](https://github.com/Fato07/codex-grok-mcp/issues/5): a clean Codex host and Grok Bot VM pass the full lifecycle with redacted receipts.
- [ ] [#6, reconnect, restart, and gateway-rotation soak](https://github.com/Fato07/codex-grok-mcp/issues/6): recovery is bounded, post-dispatch ambiguity remains `outcome_unknown`, and sends are not retried.
- [ ] [#7, invalid-pairing diagnostics](https://github.com/Fato07/codex-grok-mcp/issues/7): wrong-key failures are distinct from `UPGRADE_REQUIRED`, sanitized, and covered by the full suites.
- [ ] [#8, protected main and required CI](https://github.com/Fato07/codex-grok-mcp/issues/8): a test pull request proves the ruleset requires green CI for the candidate while retaining explicit maintainer recovery.
- [ ] [#9, release-metadata alignment check](https://github.com/Fato07/codex-grok-mcp/issues/9): the dependency-free check passes and reports exact file and field mismatches when deliberately tested.

## Supported environment

The stable claim is limited to the rows proven below. For `v0.2.0`, the host scope is macOS, Node support starts at `20.19.2`, and automated coverage is Node `20.19.2`, `22`, and `24` on macOS and Ubuntu. Linux is CI evidence only, not live isolated-CLI support. Windows, WSL, and Codex cloud remain unsupported or unverified unless the final candidate adds their own live evidence and updates the public support claim.

| Path | Exact evidence required |
|---|---|
| Isolated `grok_ask` | macOS version and architecture; Node, Codex, Grok CLI, connector, and selected Grok model versions; successful doctor and one bounded response |
| Paired persistent Bots | macOS version and architecture; Grok Bot VM OS or image and architecture; host and VM Node versions; Codex, connector, companion, protocol, and Grok Bot app or host versions; successful lifecycle below |

- [ ] The evidence record contains every version and architecture named in each supported row, using `n/a` only when a component is not part of that path.
- [ ] Public support text matches only the live-proven rows and does not turn CI, mocks, or an earlier beta run into platform support.

## Automated candidate checks

Run from the clean candidate checkout and link the candidate-specific CI run or redacted log.

Ordinary pull-request and `main` CI stays deterministic and does not call npm's network-dependent audit service. Before tagging, manually dispatch the CI workflow against the exact candidate ref; audits run fail-closed on its Node 24 Ubuntu job. `v*` tag runs execute the same audit gate again.

- [ ] `npm ci` and `npm ci --prefix relay` complete from the committed lockfiles.
- [ ] `cmp package-lock.json npm-shrinkwrap.json` passes, and the packed file list contains `npm-shrinkwrap.json`.
- [ ] `npm run test:all` passes. This includes the root build and core tests plus relay type checks and tests.
- [ ] `npm audit --omit=dev` passes.
- [ ] `npm audit --prefix relay` passes.
- [ ] `npm pack --dry-run` passes and its file list contains only intended publish content.
- [ ] `npm pack --json --pack-destination /path/outside/candidate-checkout` creates the one recorded artifact and integrity value without changing the checkout.
- [ ] A real `stageLifecycleRelease` run reports `0.2.0`, and its installed non-development package versions and SHA-512 values exactly match `npm-shrinkwrap.json`.
- [ ] The release-metadata alignment check from #9 passes.
- [ ] Required GitHub CI passes for Node `20.19.2`, `22`, and `24` on both macOS and Ubuntu at the candidate SHA.

## Live candidate checks

Use accounts and data the maintainer is authorized to use. Store only redacted receipts. Use separate clean environments for the two flows.

### Prepublication plugin gate

This gate proves the unchanged local marketplace, plugin manifest, exact tarball, MCP startup, and fresh-task discovery before the npm version is burned. It does not prove public registry availability.

- [ ] Create a new mode-`0700` npm cache outside the checkout and verify it starts empty.
- [ ] From the candidate checkout, run `node scripts/seed-offline-candidate-cache.mjs --artifact /absolute/path/to/codex-grok-mcp-0.2.0.tgz --cache /absolute/path/to/empty-cache`. The script serves only the exact candidate on an ephemeral loopback registry, caches its name/version metadata, downloads every non-development dependency by the exact immutable `resolved` URL in `npm-shrinkwrap.json`, then stops the registry. Record the returned public integrity and exact `registry_url`. Do not seed a mutable connector version or reuse a normal user cache.
- [ ] Set `NPM_CONFIG_CACHE` to that cache, `NPM_CONFIG_OFFLINE=true`, `NPM_CONFIG_REGISTRY` to the exact returned loopback URL, and `NPM_CONFIG_REPLACE_REGISTRY_HOST=never` in the environment that launches Codex. The committed plugin manifest passes only those values through when they are set. The stopped loopback URL is intentional: offline resolution must use only the isolated cache, while `replace-registry-host=never` keeps shrinkwrapped dependency URLs bound to their original cache keys.
- [ ] Add the final candidate checkout as a local marketplace, install `codex-grok-mcp@codex-grok`, and start a fresh Codex task. Fresh-task discovery is required because an existing task does not hot-load a newly installed plugin.
- [ ] From an unrelated empty working directory, run one read-only connector status or doctor operation through the plugin. Verify a new isolated `_npx` tree was created and its lock contains candidate integrity equal to the recorded tarball plus every non-development dependency path, version, and integrity from `npm-shrinkwrap.json`. An invocation from the candidate checkout does not count because npm can reuse the local package.
- [ ] Remove the local test plugin and marketplace, then discard the isolated cache. Record only redacted pass/fail evidence and public integrity values.

### Clean candidate flow

- [ ] Copy the recorded tarball to each authorized test environment without renaming or rebuilding it, verify its SHA-512 locally, and invoke it with `npx --yes --package=/absolute/path/to/codex-grok-mcp-0.2.0.tgz -- <command>`.
- [ ] On a clean host, install the exact candidate, start a fresh Codex task, discover the tools, run doctor, and complete one isolated `grok_ask` call.
- [ ] On a clean host and VM, create a new pairing without exposing it, then probe and start the exact candidate companion.
- [ ] From a fresh Codex task, verify status, list, bounded read, bounded wait, and one send to one exact non-group Bot ID with no retry.
- [ ] Stop and restart the exact candidate, then repeat status plus one read-only operation without pairing again.
- [ ] Run the exact candidate's managed `uninstall` last and verify that it removes the managed release store and lifecycle state while preserving pairing. Then unpair both endpoints and remove the Codex plugin. Grok authentication, Bot data, replay protection, and unrelated files remain unchanged.

### Upgrade and rollback flow

- [ ] Starting without lifecycle state, abruptly stop a valid foreground companion so its private lease is stale. Verify exact-version `install` reclaims only that proven-dead foreground lease, starts the managed candidate, preserves pairing, and becomes idempotent on repeated `install` and `ensure`.
- [ ] Starting from the recorded rollback version and a new pairing, exercise one controlled failed update and verify that version remains healthy and recoverable.
- [ ] Upgrade to the recorded candidate artifact, restart it, and repeat status plus one read-only operation without pairing again.
- [ ] Complete the #6 soak scenarios for relay reconnect, companion restart, VM idle and resume, gateway descriptor/process/token rotation, read and wait recovery, and one no-retry exact-ID send.
- [ ] Exercise the #7 wrong-key and valid-legacy cases and observe their distinct sanitized results.
- [ ] Roll back as specified below.

## Pairing-preserving rollback

1. Pair once on the recorded previous verified exact version.
2. Verify pairing-file byte identity and private permissions locally on both sides, recording only pass or fail, never the digest, file contents, or private path.
3. Attempt one controlled failed update before replacement becomes active. Verify the previous version remains healthy and recoverable.
4. Upgrade using the recorded candidate artifact, verify its SHA-512 and the active connector, companion, and protocol versions, then stop and restart it.
5. Roll back both sides to the recorded previous exact version. Do not run `pair`, `pair --force`, or `unpair`, and do not delete, replace, or regenerate pairing files.
6. Verify the previous versions, bridge status, and one read-only operation through the original pairing. Repeat the local byte-identity and permission check.

- [ ] The candidate passed this sequence, the original pairing remained byte-identical and usable, and a failed update left the previous version recoverable.

## Proof levels

Record these separately. Passing one never implies a later level.

| Proof | What it establishes | What it does not establish |
|---|---|---|
| Gateway acceptance | The exact-ID send received an accepted gateway receipt | Persistence, a reply, correlation, or completion |
| Transcript response observed | A later bounded Bot-authored transcript entry was observed | That the entry answers this send |
| Bot activity observed | A point-in-time activity state was read | Reply correlation or task completion |
| Task completion verified | A maintainer separately checked explicit task acceptance criteria or an artifact | A claim the bridge derives from acceptance, transcript order, or idle state |

- [ ] The live evidence uses all applicable proof labels and makes no stronger claim than the evidence supports.

## Evidence and redaction

Evidence may contain the candidate SHA, public software versions, OS and architecture, protocol numbers, timestamps, coarse results, CI URLs, and sanitized request identifiers.

- [ ] Before upload, inspect every receipt and remove prompts, responses, transcripts, Bot IDs or names, roster fingerprints, credentials, authentication data, pairing codes or files, channels, keys, tokens, gateway or relay URLs, environment values, private paths, and raw stdout or stderr bodies.
- [ ] Evidence links are durable, access-appropriate, and identify the candidate SHA and exact check without exposing private data.

## Decision

Select exactly one in the evidence record. A decision records the gate result; tagging, publishing, and changing a dist-tag are separate actions.

- [ ] **SHIP**: every required item above passed for the recorded candidate, all #4 through #9 dependencies are resolved, and no stable-release blocker remains.
- [ ] **NO-SHIP**: one or more items are unproved, stale, failed, unsafe to disclose, or tied to a different commit. Record the blocker and leave beta and release state unchanged.

- Maintainer: `<name>`
- Decision time (UTC): `<timestamp>`
- Candidate commit: `<40-character SHA>`
- Decision: `<SHIP or NO-SHIP>`

## Publication and promotion

Run this only after the signed decision is **SHIP**. Publication, registry smoke testing, tag promotion, GitHub release creation, and board updates remain separate proof states.

1. Publish the recorded tarball as `codex-grok-mcp@0.2.0` under a non-default `stable-candidate` npm dist-tag. This permanently consumes the version.
2. With a new empty npm cache and no offline overrides, install the unchanged public GitHub marketplace ref in a fresh Codex task. Verify tool discovery, MCP startup, doctor, and the exact registry package integrity.
3. If that smoke test passes, move npm `latest` to `0.2.0`. Keep `beta` on its last verified beta unless a separate decision changes it.
4. Create the immutable `v0.2.0` Git tag and GitHub release from the recorded candidate commit, attach or link the recorded integrity, and verify public installation once more.
5. Close only the issues proven by the evidence and update the project board. If the registry smoke fails, leave `latest`, the Git tag, the GitHub release, and issue states unchanged while the candidate version remains published under `stable-candidate`.
