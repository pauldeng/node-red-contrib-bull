# Reference Map

## Runtime

- `bull-queue.js`: Node-RED registration and runtime glue.
- `lib/connections.js`: Redis deployment normalization and ioredis descriptors.
- `lib/scheduler.js`: legacy repeat-cron to BullMQ Job Scheduler normalization.
- `lib/commands.js`: `bull cmd` dispatch.
- `lib/serialization.js`: message-safe BullMQ serialization.
- `lib/acknowledgements.js`: manual-acknowledgement registry for `bull run`/`bull job`. Entries self-remove on settle.

## Editor

- `bull-queue.html`: Node-RED edit dialogs and help text.
- `icons/bull_icon.png`: palette icon.

## Tests

- `test/package-contract.test.js`: dependency and runtime import contract.
- `test/connections.test.js`: Redis topology option normalization.
- `test/scheduler.test.js`: repeat scheduler compatibility.
- `test/commands.test.js`: command dispatch behavior.
- `test/acknowledgements.test.js`: manual-acknowledgement registry lifecycle and leak prevention.
- `test/shutdown.test.js`: BullMQ/ioredis resource ownership, partial redeploy cleanup, and concurrent shutdown.
- `test/async-style.test.js`: bounded-close async implementation constraints.
- `test/node-red-registration.test.js`: Node-RED node type registration.
- `test/editor-contract.test.js`: static editor surface.
- `test/docs-contract.test.js`: required docs and examples.
- `test/telemetry.test.js`: opt-in telemetry wiring, including the QueueEvents exclusion.
- `test/docker-matrix-contract.test.js`: Docker deployment fixture and runner contract.
- `test/integration-standalone.test.js`: opt-in local Redis Node-RED runtime flow tests for add/run, manual acknowledgement, repeat schedulers, delayed jobs, priorities, rate limits, deduplication events, and flow producer jobs.
- `test/integration-deployment.test.js`: opt-in external Redis deployment flow test used by Docker and MemoryDB.

## Deployment Test Fixtures

- `scripts/run-deployment-tests.js`: Docker and optional MemoryDB deployment runner.
- `test/deployments/single-noauth/`: standalone Redis without auth.
- `test/deployments/single-auth/`: standalone Redis with ACL auth.
- `test/deployments/single-tls/`: standalone Redis with TLS.
- `test/deployments/cluster-auth/`: Redis Cluster with ACL auth.
- `test/deployments/cluster-tls/`: Redis Cluster with TLS.
- `test/deployments/sentinel-auth/`: Redis Sentinel with data-node ACL auth.
- `test/deployments/sentinel-tls/`: Redis Sentinel with TLS for data-node and Sentinel connections.
- `test/deployments/tls-certs/`: local self-signed certificates for Docker TLS fixtures.

## Agent Docs

- `AGENTS.md`: entry point; `CLAUDE.md` imports it.
- `docs/RULES.md`: hard constraints.
- `docs/CHANGE_WORKFLOW.md`: change procedure.

## User Docs

- `README.md`: overview and installation.
- `docs/NODE_GUIDE.md`: node behavior.
- `docs/COMMANDS.md`: command reference.
- `docs/CONNECTIONS.md`: Redis deployments.
- `docs/TELEMETRY.md`: opt-in OpenTelemetry tracing and metrics.
- `docs/MIGRATION.md`: Bull v4 migration.
- `docs/TESTING.md`: verification plan.
- `docs/TROUBLESHOOTING.md`: operational issues.
