# Transport boundaries for issue #14

Research snapshot: 2026-09-04. This note answers [issue #14](https://github.com/Fato07/codex-grok-mcp/issues/14) without changing the transport, write ordering, or protocol.

## Revision pins and confidence

- Connector research tree: [`de254162ecc844b5589853535939bf13bd26c98d`](https://github.com/Fato07/codex-grok-mcp/commit/de254162ecc844b5589853535939bf13bd26c98d).
- Published connector runtime: [`v0.2.0-beta.5` at `8b2fa705a91b0ae9c2a2b5ccd28c5a5ffacd5407`](https://github.com/Fato07/codex-grok-mcp/releases/tag/v0.2.0-beta.5). The files changed between this tag and the research tree are documentation and issue intake only, so the measured runtime is the published runtime.
- Upstream contract inspected: [`@adam91holt/grokbot-sdk@0.2.0` at `c14347fa82d167b9a5984ec1baff56b2f074485a`](https://github.com/Adam91holt/grokbot-sdk/tree/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk). It is a reference, not a connector dependency.
- That SDK records [extracted host snapshot `0e82340`](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/gateway/host-manifest.generated.ts#L1-L10). This is a private-host snapshot label, not an independently verifiable public commit. Current live host compatibility remains unknown.

Confidence is 98% for these bounded research conclusions, 47% for a safe production multiplexer, and 20% for true token streaming.

## Measured current behavior

Reproduce the measurements from the repository root:

```sh
npm run build && node scripts/measure-transport-boundaries.mjs
```

The repository-only [operator script](../scripts/measure-transport-boundaries.mjs) drives the current compiled connector through an in-process direct fixture, explicit local MCP fixtures, and a loopback encrypted relay. It is not a CI performance test or published package interface. It never reads live gateway configuration or Bot data and has no latency pass/fail thresholds. Direct and paired requests receive a fixed synthetic 75 ms delay; polling uses the immediate in-memory fixture and the connector's real 3000 ms interval.

The fixed run order is one unreported direct warm-up, five sequential direct samples, one unreported paired warm-up, five sequential paired batches of two simultaneous reads, one unreported working-to-idle polling warm-up, then three sequential polling samples. This run used Darwin arm64 with Node 22.19.0. Reruns reproduce workload, order, and overlap, not exact milliseconds; runtime and scheduler noise is expected. Timings are not live relay, VM, or Bot performance.

| Path | Samples, ms | Median | Observed boundary |
|---|---:|---:|---|
| One direct `grok_read_bot` | 240.9, 232.4, 233.4, 246.1, 235.2 | 235.2 ms | Five gateway requests per call; maximum three active together |
| Two simultaneous paired `grok_read_bot` calls | 349.6, 346.4, 332.6, 524.8, 401.7 | 349.6 ms | Four serialized bridge turns; all five samples observed `list, list, read, read`; maximum one active |
| Working then idle polling test | 3001.6, 3002.2, 3007.2 | 3002.2 ms | One requested 3000 ms sleep between two successful snapshots |

The direct tool first validates the roster. Its transport then validates the roster again and runs transcript tail, async-task, and subagent reads concurrently. Within one direct read, those three independent subreads are the bounded fan-out, and the two roster checks remain ordered before the data they authorize. The direct transport has no queue or global concurrency cap, so simultaneous tool calls can overlap beyond three; that was not load-tested and is not a production concurrency contract. See [`grok-bot-gateway.ts`](../src/grok-bot-gateway.ts#L695-L715) and [`direct-gateway-transport.ts`](../src/direct-gateway-transport.ts#L248-L300).

The paired transport serializes every status, list, read, and send turn in one per-instance queue. A high-level read uses separate list and read turns, so two tool calls can interleave at that boundary even though no bridge turn overlaps. The companion has a second process-wide busy guard and rejects overlap. This proves serialization in one transport and companion process, not a global limit across processes. See [`relay-transport.ts`](../src/relay-transport.ts#L227-L330) and [`bridge-companion.ts`](../src/bridge-companion.ts#L336-L417).

After one initial roster lookup, polling takes its first snapshot without a polling delay, then requests a 3000 ms sleep after each nonterminal snapshot. The deadline or cancellation may cut that sleep short. Its 1 to 120 second deadline includes roster lookup, relay queueing, reads, and sleep. It stops on the first `idle` or `awaiting_user` observation, the first failed read, cancellation, or timeout. A timeout after a successful observation returns only the latest bounded snapshot. See [`grok-bot-gateway.ts`](../src/grok-bot-gateway.ts#L724-L810) and its [polling tests](../test/gateway.test.mjs#L477-L650).

Focused existing tests passed 40/40:

```sh
npm run build
node --test test/gateway.test.mjs test/relay-transport.test.mjs \
  test/bridge-companion.test.mjs test/grok-bot-client.test.mjs
```

They cover bounded reads, conservative activity, polling timing, cancellation, queueing, duplicate-send protection, descriptor rotation, and no write retry. They are mock evidence, not platform or production evidence.

## Identifier and correlation boundaries

| Value | What it proves | What it does not prove |
|---|---|---|
| Pairing channel | By itself, only which opaque relay route is selected and cryptographically bound. Bearer authentication plus a valid frame proves credential possession | Bot identity, request identity, message identity, or correlation |
| Bridge request `id` | A fresh UUID identifies one paired operation; every response must echo the ID, and a successful response must echo the operation | Gateway persistence, Bot execution, a transcript entry, a reply, or completion |
| Gateway HTTP request ID | One downstream HTTP attempt, useful for bounded error diagnosis | The same identity as the bridge request, a stored prompt, or a reply |
| `clientNonce` | On paired sends, the bridge request UUID is forwarded to the host input and can potentially address its acceptance ledger | Host deduplication, message durability, assistant reply identity, or task completion |
| `echoEntryId` | If the unofficial acceptance ledger returns a non-null value, it may identify the accepted user-side echo entry | A stable contract, an assistant response, a parent/reply edge, or completion |
| Bot ID | Exact selection from the current non-group roster | Continuity after delete/recreate or association of later text with a send |

The connector uses `issued_at_ms` for freshness and bridge IDs for response matching, in-process duplicate handling, and persistent send replay protection. A successful paired send returns the bridge ID as `request_id` and also passes it as `clientNonce`. A paired gateway error may instead carry the downstream HTTP request ID, while a direct success returns its HTTP request ID. Direct mode does not pass `clientNonce`. Treat every `request_id` as transport receipt and diagnostic metadata, not a stable message ID. See [`bridge-companion.ts`](../src/bridge-companion.ts#L276-L293) and [`direct-gateway-transport.ts`](../src/direct-gateway-transport.ts#L302-L310).

The pinned SDK defines `promptAcceptanceStatus` records with `clientNonce`, acceptance status, `agentId`, and nullable `echoEntryId`, but the connector neither calls nor exposes that command. Its [fixture reaches idle with `echoEntryId: null`](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/test/oneshot.test.ts#L216-L246). Therefore no stable send-to-reply correlation identifier is established. See the pinned SDK's [`types.ts`](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/types.ts#L140-L202).

## Activity is a snapshot, not completion

`activity_state` applies conservative precedence:

1. `working` if any running, composing, async-task, or running-subagent signal is positive.
2. `awaiting_user` only when no working signal is positive and the awaiting signal is true.
3. `idle` only when every signal is explicitly false or zero.
4. `unknown` when the available signals cannot prove another state.

A read is a composite of roster state followed by three concurrent queries. Those observations have no shared upstream revision or timestamp. `observed_working` only says at least one working snapshot occurred during this wait. Neither later `idle`, transcript order, nor the newest bounded text proves that a task completed or answered a particular send. The public output correctly retains `correlation: "not_claimed"` and `completion_boundary: "activity_snapshot_not_task_completion"`.

## SSE can wake a snapshot, not stream an answer

The connector has no event-stream capability. The pinned upstream SDK exposes authenticated `GET /events?channels=` and parses arbitrary `{ channel, payload }` frames. Its coverage is synthetic only. There is no documented event schema version, cursor, `Last-Event-ID`, replay, ordering, loss, or reconnect contract. See the pinned SDK's [`client.ts`](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/src/gateway/client.ts#L236-L277) and [fixture test](https://github.com/Adam91holt/grokbot-sdk/blob/c14347fa82d167b9a5984ec1baff56b2f074485a/sdk/test/gateway-http.test.ts#L283-L325).

If later authorized and verified, authenticated SSE may only be an unversioned wake-up hint:

1. Accept a recognized channel notification within strict byte and time bounds.
2. Discard its payload as authority and coalesce duplicate wake-ups.
3. For a preselected Bot ID validated against a fresh roster, run the existing exact-ID bounded snapshot and use only that result.

SSE does not establish token deltas, complete messages, delivery, reply correlation, or task completion. Wrapping polling or snapshots in an event stream is not token streaming.

## CI portability is not live platform support

The exact connector revision passed all six jobs in the [Ubuntu and macOS Node 20.19.2, 22, and 24 CI matrix](https://github.com/Fato07/codex-grok-mcp/actions/runs/33809538491). Those jobs build and run mocks. The repository explicitly requires a redacted live result before claiming a supported platform.

| Environment | Current evidence | Decision |
|---|---|---|
| macOS | Existing live isolated CLI evidence plus CI | Supported public-beta path |
| Linux | Ubuntu CI passes; official [Grok Build installation](https://docs.x.ai/build/overview#install) lists Linux | Live connector support remains unverified |
| WSL | Upstream installation lists WSL; no connector CI or live result | Unsupported or unverified |
| Native Windows | Upstream installation lists PowerShell; no Windows CI. Current isolation uses POSIX permissions, symlinks, and signals | Unsupported |
| Codex cloud | [Cloud containers](https://developers.openai.com/codex/cloud/environments) can install tools, but agent internet is off by default and setup secrets are removed before the agent phase | Unsupported; current auth-file and network path is unproven |

Upstream availability never upgrades connector support. Linux needs a real installed CLI, login, selected model, and one redacted successful response. Windows and WSL need separate evidence. Codex cloud additionally needs an explicit authentication and network design; build success alone is insufficient.

## Decisions

| Decision | Result | Confidence | Reason |
|---|---|---:|---|
| Keep the existing three-way internal read fan-out | **GO** | 98% | It is bounded, read-only, and measured; no write behavior changes |
| Keep fixed polling and paired serialization | **GO** | 98% | Failure, cancellation, and write-uncertainty boundaries are already explicit |
| Claim Linux, WSL, Windows, or Codex cloud support | **NO-GO** | 98% | CI and upstream availability are not live connector proof |
| Remove serialization or add production multiplexing | **NO-GO** | 47% feasibility | Current request/response and replay boundaries are not designed or tested for it |
| Claim stable send-to-reply correlation | **NO-GO** | 47% feasibility | `clientNonce` can anchor acceptance, but no assistant reply edge is proven |
| Implement or market true token streaming | **NO-GO** | 20% feasibility | The only source-inspected, synthetically tested event surface is unversioned SSE with opaque payloads |

## Smallest missing live probes

Each probe needs separate authorization because it uses an account, credentials, private platform metadata, an external write, or allowance.

1. **Linux isolated CLI:** on an operator-owned Linux host, record OS/architecture and Node, Codex, and Grok versions; run the no-send doctor; then send one fixed non-sensitive prompt once. Record only success/error category, selected model, and elapsed time. Never record response content or retry an uncertain result.
2. **WSL and native Windows:** repeat the same probe separately. Before the one send, verify auth-file permissions/link behavior, child environment, cancellation, and cleanup on that platform. Do not treat WSL as native Windows evidence.
3. **Codex cloud:** first run a no-send capability probe for plugin execution, CLI presence, readable non-exported authentication, and permitted xAI egress during the agent phase. Do not send until a dedicated auth design satisfies the cloud secret boundary.
4. **Paired compatibility:** on a dedicated non-private test VM, read only live host version and capability names and compare them with snapshot `0e82340`. Return no Bot identities or content.
5. **SSE and correlation:** use an isolated VM and account containing only disposable data because SSE filters channels, not Bot IDs. With one disposable test Bot and one explicitly approved synthetic marker, baseline a five-entry test-only tail, open authenticated `agents,transcript` SSE for at most 20 seconds and 20 frames, coalesce wake-ups, send once with a fresh nonce, never retry, and run the bounded snapshot after each wake-up. Separately authorize `promptAcceptanceStatus` and raw test-only `getAgentTranscriptTail` metadata outside the connector allowlist because connector snapshots strip entry IDs. One run where a non-null `echoEntryId` maps to the accepted user entry and an assistant entry exposes an explicit parent/reply edge only establishes a candidate; stable correlation requires repeated results under a pinned live host version.

Do not attempt overlapping writes, reconnect-loss tests, production multiplexing, or token-payload inspection until these smaller probes establish a usable versioned contract and receive their own authorization.
