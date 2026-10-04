# Testing

Automated tests are hermetic. `npm test` and `npm run test:all` load `test/hermetic-setup.mjs` before any test file. That setup deletes every `SAND_*` and `GROKBOT_*` variable, creates a mode-`0700` fixture base, and sets `SAND_DATA_ROOT` and `TMPDIR` inside it. Discovery and preflight paths throw if they resolve to the real default Grok Bot data root.

Do not point tests at a live Grok Bot gateway. Box-like proof runs export `SAND_HOST_PORT` and `SAND_GATEWAY_BIND_HOST` only inside a network namespace with the fixture data root.

## Offline staging

`stageLifecycleRelease` of the currently invoked package may call `npm install` for the production closure. A real install with no registry access waits about 120 seconds, then fails with `install_failed`. The published-closure staging test skips with that reason when the registry is unreachable so a cold cache inside a network namespace does not fail the suite.

## macOS skips

Linux-only tests skip on macOS. The Linux total must equal macOS pass + skip. Current Linux-only names:

- Linux kills a candidate that acquires its lease then emits malformed readiness
- Linux lifecycle recovers a stale pre-binding process and completes upgrade and removal
- Linux lifecycle update from stale never preflights the retained release
- Linux start-id recovery distinguishes a reused pid from the original companion
- gateway verification accepts genuine gateway with clock skew (VM pause)
- gateway verification fails for reused PID without listening socket
- gateway verification rejects descriptor startedAt in the future

## Sandbox caveat

A `bwrap` sandbox that remaps the process to uid `65534` (the 86/60/12 shape) is not this suite's environment. That mapping was involved in an earlier hang. Proof runs use a normal uid and are not inside that sandbox.

## Release-tree foreign ownership

`migrateReleaseTreePermissions` accepts an optional `{ uid, lstat }` seam so a foreign-owned directory can be asserted without changing a real uid. The suite injects `uid: () => process.getuid() + 1` and checks that modes stay untouched.

## TMPDIR

A world-writable `TMPDIR` (mode `0777`) fails pairing with `insecure_config_directory`. Tests keep the hermetic mode-`0700` base.
