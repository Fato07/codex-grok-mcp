# Contributing

Thanks for helping keep this bridge small, safe, and dependable.

## Before opening a change

- Use an issue or discussion before adding tools, adapters, dependencies, authentication paths, or new supported platforms.
- Keep the v1 boundary: one local Grok CLI tool, no persistent Grok Bot access, no credential extraction, and no silent API fallback.
- Never include credentials, `~/.grok/auth.json`, private prompts, responses, transcripts, or unredacted logs.

## Local setup

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run doctor
```

Use a real live call only with your own Grok account and data you are authorized to send. Unit tests must not require network access or real authentication.

## Pull requests

Keep pull requests focused. Include:

- the user-visible problem and why the existing behavior is insufficient;
- the smallest implementation that fixes it;
- one focused regression test for non-trivial behavior;
- compatibility and security-boundary impact;
- documentation changes when commands or behavior change;
- upstream source and license attribution for adapted code.

Before requesting review, run:

```bash
npm run typecheck
npm test
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/codex-grok-mcp
```

Do not update generated package versions in feature pull requests unless the maintainer asks. Do not add postinstall scripts or telemetry.

## Compatibility claims

Mocks and unit tests are not platform proof. To add a supported compatibility row, provide a redacted live smoke-test result showing the OS/architecture, Node version, Codex version, Grok CLI version, selected model, and successful response. Do not include response content.

## New adapters and tools

The core stays on the single `grok_ask` tool and documented interfaces. A new adapter needs:

- a documented, authorized upstream API;
- an identified maintenance owner;
- a separate explicit configuration path;
- tests and threat-boundary documentation;
- no scraping, Keychain extraction, internal gateway credentials, or silent fallback.

Persistent Grok Bot integration is not accepted until an official inbound API exists or it is maintained as a clearly separate experimental project.

## Governance and license

Fato07 is the initial maintainer. Maintainer approval and passing checks are required to merge. There is no CLA or DCO at this stage.

By contributing, you agree that your contribution is licensed under the repository's MIT License and that you have the right to submit it.
