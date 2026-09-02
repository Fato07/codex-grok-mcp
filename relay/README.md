# codex-grok-mcp relay

This Worker forwards end-to-end encrypted WebSocket frames between the Codex client and Grok Bot companion. It accepts native clients only: browser requests carrying an `Origin` header are rejected.

## Configure

Create one deployment-scoped token containing exactly 32 random bytes in base64url form, keep it in your password manager, and set it as a Cloudflare secret:

```sh
RELAY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'RELAY_ACCESS_TOKEN=%s\n' "$RELAY_TOKEN" | npx wrangler deploy --secrets-file /dev/stdin
```

Use that same value as `CODEX_GROK_RELAY_TOKEN` for `codex-grok-mcp pair`. Pairing derives an HMAC-SHA-256 bearer for the random channel; the pair code configures both native clients with that scoped bearer and never includes the deployment master. Do not put either value in `wrangler.jsonc`, logs, URLs, issues, or prompts. This master is for one operator's self-hosted relay, not a multi-tenant public service.

Cloudflare invocation logs and traces are explicitly disabled because the channel is part of the request path. The Worker itself emits no logs.

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`, fill the same secret, and keep that file untracked.

## Verify and deploy

```sh
npm test
npm run check
npx wrangler deploy --dry-run
```
