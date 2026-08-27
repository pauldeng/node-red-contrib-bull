# Reference Map

## Runtime

- `bull-queue.js`: Node-RED registration and runtime glue.
- `lib/connections.js`: Redis deployment normalization and ioredis descriptors.
- `lib/scheduler.js`: BullMQ v6 Job Scheduler id handling and serialization.
- `lib/commands.js`: `bullmq cmd` dispatch.
- `lib/serialization.js`: message-safe BullMQ serialization.
- `lib/acknowledgements.js`: manual-acknowledgement registry for `bullmq run`/`bullmq job`. Entries self-remove on settle.

## Editor

- `bull-queue.html`: Node-RED edit dialogs and help text.
- `icons/bull_icon.png`: palette icon.

## Tests

- `test/package-contract.test.js`: dependency and runtime import contract.
- `test/connections.test.js`: Redis topology option normalization.
- `test/scheduler.test.js`: native Job Scheduler id and serialization contracts.
- `test/commands.test.js`: command dispatch behavior.
- `test/acknowledgements.test.js`: manual-acknowledgement registry lifecycle and leak prevention.
- `test/shutdown.test.js`: BullMQ/ioredis resource ownership, partial redeploy cleanup, and concurrent shutdown.
- `test/async-style.test.js`: bounded-close async implementation constraints.
- `test/node-red-registration.test.js`: Node-RED node type registration.
- `test/editor-contract.test.js`: static editor surface.
- `test/docs-contract.test.js`: required docs and examples.
- `test/serialization.test.js`: message-safe job serialization, including that no lock token escapes.
- `test/telemetry.test.js`: opt-in telemetry wiring, including the QueueEvents exclusion.
- `test/docker-matrix-contract.test.js`: Docker deployment fixture and runner contract.
- `test/integration-standalone.test.js`: opt-in local Redis/PostgreSQL Node-RED runtime flows, standing command/action coverage, schedulers, delayed jobs, events, and flow producer jobs.
- `test/integration-deployment.test.js`: opt-in external Redis/PostgreSQL deployment flow test used by Docker and MemoryDB.
- `test/helpers/stores.js`: local Redis/PostgreSQL integration fixtures and backend adapters.

## Deployment Test Fixtures

- `scripts/run-deployment-tests.js`: Docker and optional MemoryDB deployment runner.
- `test/deployments/single-noauth/`: standalone Redis without auth.
- `test/deployments/single-auth/`: standalone Redis with ACL auth.
- `test/deployments/single-tls/`: standalone Redis with TLS.
- `test/deployments/cluster-auth/`: Redis Cluster with ACL auth.
- `test/deployments/cluster-tls/`: Redis Cluster with TLS.
- `test/deployments/sentinel-auth/`: Redis Sentinel with data-node ACL auth.
- `test/deployments/sentinel-tls/`: Redis Sentinel with TLS for data-node and Sentinel connections.
- `test/deployments/postgres-plain/`: PostgreSQL without TLS.
- `test/deployments/postgres-tls/`: PostgreSQL with TLS.
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
- `docs/MIGRATION.md`: breaking upgrade from older package versions.
- `docs/TESTING.md`: verification plan.
- `docs/TROUBLESHOOTING.md`: operational issues.
