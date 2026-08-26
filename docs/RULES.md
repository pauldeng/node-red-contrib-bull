# Rules

Hard constraints. Each one exists because breaking it breaks a released contract, loses jobs, or leaks a secret. Everything not listed here is a normal judgment call.

## Public Surface

- Register only the BullMQ v6 node types: `bullmq-queue-server`, `bullmq cmd`, `bullmq run`, `bullmq job`, `bullmq events`, and `bullmq flow`.
- Accept only `msg.cmd` for command dispatch and only the native Job Scheduler command names and fields.
- `msg.cmd` dispatch maps to explicit BullMQ calls only. Never expose arbitrary method names through it.
- Record unsupported BullMQ behavior with a reason instead of silently omitting it.

## Dependencies

- BullMQ is pinned to an exact version. Do not widen the range; `package.json` holds the value and `test/package-contract.test.js` enforces it.
- Changing the BullMQ pin means re-verifying the connection-readiness and shutdown paths against BullMQ's own source, not just running the suite. Three separate defects in the v5 to v6 upgrade came from behavior invisible at the public API: `close()` and `disconnect()` both await a connection-ready promise that never settles while Redis is unreachable, `Worker.close()` clears its lock-renewal and stalled-check timers only after the step that hangs, and `increaseMaxListeners` computes `getMaxListeners() + n`, which turns an unlimited emitter into a cap of 3. The code that works around these is in `bull-queue.js` (`forceDisconnect`, `closeBudgetFor`, `PRODUCER_MAX_LISTENERS`) and `lib/connections.js` (`skipWaitingForReady`); each carries a comment naming the measured behavior it depends on. Read those, then confirm they still hold.
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
