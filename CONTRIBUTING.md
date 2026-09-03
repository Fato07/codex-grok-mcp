# Contributing

Thanks for helping keep this bridge small, safe, and dependable.

## Before opening a change

- Open an issue or discussion before adding a tool, adapter, dependency, authentication path, or supported platform.
- Keep `grok_ask` isolated from persistent Bot support.
- Never commit credentials, authentication files, private prompts, responses, transcripts, or unredacted logs.
- Never scrape Grok Bot state, decrypt descriptors, read Keychain, or infer gateway credentials.

## Local setup

```bash
npm ci
npm ci --prefix relay
npm run test:all
```

`npm run doctor` is optional and requires a local Grok CLI login. It checks setup without sending a model request. Live tests must use your own account and data you are allowed to share; automated tests must use mocks.

## Pull requests

Keep pull requests focused. Include:

- the user-visible problem;
- the smallest complete fix;
- one regression test for non-trivial behavior;
- any compatibility or security-boundary change;
- documentation updates when commands or behavior change;
- attribution for adapted code.

Before requesting review, run:

```bash
npm run test:all
npm audit --omit=dev
npm audit --prefix relay
npm pack --dry-run
```

Do not add postinstall scripts or telemetry. Version changes belong in release work, not ordinary feature pull requests.

## Compatibility claims

Mocks are not platform proof. A new supported environment needs a redacted live result containing OS, architecture, Node, Codex, Grok CLI, selected model, and a successful response. Do not include response content.

## Adapters and Bot tools

New adapters need a documented upstream contract, operator-authorized credentials or pairing, a maintenance owner, tests, and a separate opt-in configuration path.

For persistent Bot changes, preserve exact-ID and non-group checks, bounded sanitized reads, explicit no-correlation and no-completion claims, and no automatic write retries. Bulk writes must keep the roster fingerprint, exact ordered IDs, and native confirmation. Ambiguous writes remain `outcome_unknown`; cancelled remaining recipients stay `not_attempted`.

Keep the legacy URL/token adapter out of the default plugin environment. Use mock gateways and relays in tests.

## Governance and license

Fato07 is the initial maintainer. Maintainer approval and passing checks are required to merge. There is no CLA or DCO at this stage.

Contributions are licensed under the repository's MIT License.
