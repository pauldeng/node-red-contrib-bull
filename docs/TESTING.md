# Testing

## Fast Local Tests

```sh
npm test
npm run format:check
```

`npm test` runs built-in `node:test` suites for package metadata, connection normalization, Job Scheduler commands, command dispatch, editor surface, registration, resource shutdown, async style, telemetry wiring, Docker fixture contracts, docs, and examples. The lifecycle checks live in `test/shutdown.test.js`; bounded-close implementation constraints live in `test/async-style.test.js`. `npm run format:check` runs Prettier. CI gates both on every pull request.

## Node-RED Runtime Tests

Use `node-red-node-test-helper` for flow-level tests. Runtime coverage should load actual Node-RED flows for:

- `bullmq cmd` success and failure paths;
- `bullmq run` immediate and manual modes;
- `bullmq job` acknowledgement actions;
- `bullmq events`;
- `bullmq flow`;
- BullMQ v6 Job Scheduler commands.

The current standalone Redis integration suite is opt-in:

```sh
npm run test:integration
```

It starts a temporary local `redis-server`, loads real Node-RED flows, and verifies:

- `bullmq cmd` add/run behavior;
- manual `bullmq run` acknowledgement through `bullmq job`;
- native Job Scheduler creation, lookup, and removal;
- delayed-job commands;
- priority listing and counts;
- global rate-limit commands;
- deduplication commands and `bullmq events` delivery;
- `bullmq flow` parent/child and bulk FlowProducer output;
- worker and producer recovery after Redis restarts;
- graceful Node-RED shutdown while a manual job is active.

## Playwright

Editor changes require Playwright coverage:

```sh
npm run test:playwright
```

Cover deployment field visibility, credential persistence, TLS fields, and edit dialogs for all node types.

## Docker Matrix

Use Docker for the topology matrix:

```sh
npm run test:deployments
```

The runner starts each fixture, waits for Redis readiness, runs `test/integration-deployment.test.js`, and removes volumes between deployments.

Current executable fixtures:

- `single-noauth`: standalone Redis without auth or TLS
- `single-auth`: standalone Redis with ACL auth
- `single-tls`: standalone Redis with TLS
- `cluster-auth`: two-node Redis Cluster with ACL auth and BullMQ `{bull}` prefix coverage
- `cluster-tls`: two-node Redis Cluster with TLS and BullMQ `{bull}` prefix coverage
- `sentinel-auth`: Redis master, two replicas, and three Sentinels with data-node ACL auth
- `sentinel-tls`: Redis master, two replicas, and three TLS-enabled Sentinels

The shared deployment test proves Node-RED load, credential-backed auth, add/run delivery, native scheduler creation/removal, absolute scheduler minute/second metadata, live cancellation retries and `cancelAllJobs`, and OpenTelemetry add/process spans plus completed/duration metrics. TLS fixtures use local self-signed test certificates and disable certificate verification for those Docker-only deployments. MemoryDB remains the certificate-verified TLS deployment path.

## AWS MemoryDB

MemoryDB tests are opt-in. Use environment variables only:

- `MEMORYDB_ENDPOINT`
- `MEMORYDB_PORT`
- `MEMORYDB_USERNAME`
- `MEMORYDB_PASSWORD`
- optional `MEMORYDB_TLS`
- explicit enable flag such as `MEMORYDB_ENABLED=1`

Run MemoryDB with the same deployment harness:

```sh
MEMORYDB_ENABLED=1 npm run test:deployments
```

Never write these values to repository files, examples, fixtures, snapshots, or logs.
