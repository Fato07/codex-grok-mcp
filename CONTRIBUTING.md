# Contributing

Thanks for helping keep this bridge small, safe, and dependable.

## Before opening a change

- Use an issue or discussion before adding tools, adapters, dependencies, authentication paths, or new supported platforms.
- Preserve the isolated `grok_ask` boundary. Experimental persistent Bot support must stay opt-in, separately paired, and unavailable without a validated private pairing file.
- Never include credentials, `~/.grok/auth.json`, private prompts, responses, transcripts, or unredacted logs.
- Never scrape Grok Bot app state, decrypt descriptors, read Keychain, or infer gateway credentials.

## Local setup

```bash
npm ci
npm run typecheck
npm run test:all
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
npm run test:all
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/codex-grok-mcp
```

Do not update generated package versions in feature pull requests unless the maintainer asks. Do not add postinstall scripts or telemetry.

## Compatibility claims

Mocks and unit tests are not platform proof. To add a supported compatibility row, provide a redacted live smoke-test result showing the OS/architecture, Node version, Codex version, Grok CLI version, selected model, and successful response. Do not include response content.

## New adapters and tools

The core `grok_ask` tool stays isolated from optional adapters. A new adapter needs:

- a documented upstream contract and operator-authorized credentials or pairing;
- an identified maintenance owner;
- a separate explicit configuration path;
- tests and threat-boundary documentation;
- no scraping, Keychain extraction, internal gateway credentials, or silent fallback.

Persistent Grok Bot integration is accepted only through an official inbound API or a clearly separated experimental adapter.

The paired bridge is the narrow exception: its bounded local client discovers the loopback gateway only inside the Grok VM; the gateway token never leaves that VM; the self-hosted relay authenticates native clients before allocation and forwards only authenticated ciphertext; the companion exposes only roster listing and exact-ID sends. Preserve fingerprint-bound plus native-user-confirmed `PING`-to-all, sequential one-shot delivery, cached replay receipts, per-Bot receipts, no automatic retries, `outcome_unknown` for ambiguous sends, and `not_attempted` after cancellation. Keep the legacy URL/token transport out of the default plugin environment. Tests must use mock gateways/relays; distinguish metadata-only live probes from live message compatibility.

## Governance and license

Fato07 is the initial maintainer. Maintainer approval and passing checks are required to merge. There is no CLA or DCO at this stage.

By contributing, you agree that your contribution is licensed under the repository's MIT License and that you have the right to submit it.
