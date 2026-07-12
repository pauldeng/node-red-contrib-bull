# BullMQ Update And Command Coverage Design

## Goal

Update the production BullMQ dependency to the current release, exactly `5.80.2`, and raise `lib/commands.js` line coverage to at least 90% with focused tests of the public command-dispatch contract.

The user's explicit version-update request supersedes the repository's previous `5.78.0` pin. BullMQ remains exactly pinned rather than using a version range.

## Dependency Update

- Change `bullmq` from `5.78.0` to `5.80.2` in `package.json` and `package-lock.json`.
- Update package-contract assertions, runtime comments, README text, and maintained documentation that names `5.78.0`.
- Preserve the existing public Node-RED node types, message contracts, Redis connection behavior, scheduler IDs, and lock-token isolation.
- Do not copy the stale Dependabot PR's `5.79.2` lockfile. Generate the lockfile from the current exact pin.

## Command Coverage

Extend `test/commands.test.js` using small queue and job fakes that record calls and return representative values. Prefer table-driven cases where commands share the same dispatch shape; keep dedicated tests for branches with distinct behavior.

Coverage includes:

- job creation, lookup, state, removal, and retry commands;
- delayed-job and priority commands;
- deduplication commands;
- native and legacy Job Scheduler commands;
- queue administration and cleanup;
- global concurrency and rate-limit commands;
- logs and Prometheus metrics;
- required job IDs, missing jobs, defaults, serialization, and unsupported commands.

Tests assert both the BullMQ method arguments and the message-safe return value. They test `dispatchCommand` directly without adding a new mocking library or changing production structure solely for coverage.

## Compatibility And Error Handling

The update must keep BullMQ APIs used by `bull-queue.js`, `lib/commands.js`, and `lib/scheduler.js` compatible. If the updated dependency exposes a real incompatibility, add the smallest failing regression test before changing runtime code.

Cluster and MemoryDB prefixes must continue to contain a Redis hash tag. Legacy repeat commands must continue using exact scheduler IDs. Manual acknowledgement messages must remain token-free.

## Verification

Completion requires:

- `lib/commands.js` line coverage of at least 90%;
- `npm test`;
- tests under Node.js 18, 22, and 24;
- `npm run format:check`;
- `npm run test:playwright`;
- `npm audit --omit=dev --audit-level=moderate`;
- standalone Redis integration tests;
- `npm pack --dry-run`;
- `git diff --check`.

The Docker topology suite remains required when Docker daemon access is available. If the host still denies Docker access, report that external limitation without weakening the other gates.
