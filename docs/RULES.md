# Rules

Hard constraints. Each one exists because breaking it breaks a released contract, loses jobs, or leaks a secret. Everything not listed here is a normal judgment call.

## Public Surface

- Keep the legacy node types registered: `bull-queue-server`, `bull cmd`, and `bull run`. Deployed flows use these names. `bull job`, `bull events`, and `bull flow` are the BullMQ-era additions.
- `msg.command` stays a working alias for `msg.cmd`.
- `msg.cmd` dispatch maps to explicit BullMQ calls only. Never expose arbitrary method names through it.
- Record unsupported BullMQ behavior with a reason instead of silently omitting it.

## Dependencies

- BullMQ is pinned to an exact version. Do not widen the range; `package.json` holds the value and `test/package-contract.test.js` enforces it.
- Do not reintroduce `bull` or `sprintf-js`.
- The runtime floor is Node.js 22.9 with Node-RED 5.x, for the published package and for local development alike.

## Secrets

- Credentials belong in Node-RED credentials or environment variables. Never in examples, docs, logs, fixtures, snapshots, or committed flows.
- Never commit real credentials, Redis passwords, MemoryDB endpoints, or production private keys. One sanctioned exception: the local self-signed certificates in `test/deployments/tls-certs/` are committed Docker-only fixtures that grant access to nothing.
- Editor credential fields must not export secrets into flow JSON.
- MemoryDB tests read credentials only from environment variables.

## Runtime Invariants

- Never put BullMQ lock tokens in a Node-RED message.
- Repeat scheduler lookup and removal use exact scheduler ids. Never substring-match scheduler keys, and never call the deprecated repeatable-job APIs.
- Cluster and MemoryDB deployments default their BullMQ prefix to `{bull}`. A custom prefix must contain a Redis hash tag; `lib/connections.js` rejects one that does not.
- Do not pass arbitrary ioredis options through messages or editor fields.
- Keep TLS certificate verification on by default. Disable it only for a controlled deployment that cannot be given a trusted CA.
