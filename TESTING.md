# Testing

Automated tests are hermetic. `npm test` and `npm run test:all` load `test/hermetic-setup.mjs` before any test file. That setup deletes every `SAND_*` and `GROKBOT_*` variable, creates a mode-`0700` fixture base, and sets `SAND_DATA_ROOT` and `TMPDIR` inside it. The fixture base is removed at process exit (best effort). Cleanup never follows a symlink: if the base path has been replaced by a link, only that link is removed.

The real-root guard arms only when `CODEX_GROK_TEST_HERMETIC` is set. With it unset, `grokBotDataRoot` matches production for every `SAND_DATA_ROOT` value. `managedChildEnvironment` forwards that one test flag only when the parent has it. A managed child that inherits the flag then enforces the same realpath guard and fails before any read or connect if discovery would resolve to the real default Grok Bot data root.

Do not point tests at a live Grok Bot gateway. If a proof run inherits host gateway environment variables, keep the fixture data root and give the process no network path to a real gateway.

## Offline staging

`stageLifecycleRelease` of the currently invoked package may call `npm install` for the production closure. A real install with no registry access waits about 120 seconds, then fails with `install_failed`.

The published-closure staging test makes a live `HEAD` request to `registry.npmjs.org` only when `CI` is `true` or `1` (case-insensitive) or `CODEX_GROK_TEST_REGISTRY=1`. `CI=false` and `CI=0` are off. Without those, the test skips with that reason and makes no outbound request. In CI, an unreachable registry is a failure.

A failed target stage before the switch during `update` or `rollback` from stale makes no state change except the existing lifecycle-root `0700` tightening. The stale lease, bindings, and release tree stay as they were; no child is started.

## macOS skips

Linux-only tests skip on macOS. The Linux total must equal macOS pass + skip. Current Linux-only names:

- Linux kills a candidate that acquires its lease then emits malformed readiness
- Linux lifecycle recovers a stale pre-binding process and completes upgrade and removal
- Linux lifecycle update from stale never preflights the retained release
- managed stop verifies Linux process identity and waits for owner release
- gateway verification accepts genuine gateway with clock skew (VM pause)
- gateway verification fails for reused PID without listening socket
- gateway verification rejects descriptor startedAt in the future

## Sandbox caveat

A sandbox that maps the test process to an overflow uid (65534) is not this suite's environment. That mapping was involved in an earlier hang. Proof runs use a normal uid and are not inside that sandbox.

## Release-tree modes

`migrateReleaseTreePermissions` walks `releases/`, the version directory, and the integrity directory. It validates every level (mode, owner, symlink, special bits) before changing any of them. Missing levels are skipped.

- Exact `0755` is migrated to `0700`.
- `0700` is left alone.
- `0775` is rejected as `GROUP_WRITABLE`.
- `0757` and `0777` are rejected as `WORLD_WRITABLE`.
- `0750`, `0711`, and `0705` are rejected as `UNEXPECTED_MODE`.
- A non-directory at any walked level is rejected as `UNEXPECTED_MODE`.
- A symlink at any walked level is rejected as `RELEASE_TREE_SYMLINK`.
- setuid, setgid, and sticky are rejected as `SPECIAL_BITS`.
- A foreign owner is rejected as `FOREIGN_OWNED`.

Modes are never changed on rejection. The suite can inject `{ uid, lstat }` so a foreign-owned directory can be asserted without changing a real uid.

## TMPDIR

A world-writable `TMPDIR` (mode `0777`) fails pairing with `insecure_config_directory`. Tests keep the hermetic mode-`0700` base.
