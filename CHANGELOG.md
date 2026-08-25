# Changelog

All notable changes to this package are documented here.

## 2.0.0 - 2026-08-26

- Upgraded to BullMQ 6.2.1 (from 5.80.9); ioredis stays pinned at 5.11.1. Persisted BullMQ v5 repeatable-job data is not migrated to v6 -- remove it before upgrading. See docs/MIGRATION.md.
- Raised the runtime floor to Node.js 22.9+ and Node-RED 5.x, dropping Node.js 18/20 and Node-RED 4.1.x support.
- Breaking: the `paused` job state is gone from BullMQ -- `getJobState` now reports `waiting` for a paused-queue job and `getJobCounts` no longer has a `paused` key. Use the new `isPaused` command to check the queue itself.
- Breaking: `bull flow` child jobs without an explicit `opts.jobId` now get UUIDs instead of incremental numeric ids.
- Breaking: BullMQ removed `repeat.utc` in favor of `repeat.tz`. This package still translates a legacy `repeat.utc: true` into `repeat.tz: "UTC"`, but a truthy `utc` combined with a conflicting `tz` now throws instead of picking one silently. A falsy `repeat.utc` is dropped.
- Breaking: the default `bull events` filter now includes `retries-exhausted`. A flow using an empty event filter starts receiving this additional event type.
- BullMQ removed its own legacy repeatable-job methods, but this package's `getRepeatableJobs`/`getRepeatableJobByKey`/`removeRepeatableByKey`/`count` aliases are unaffected -- they were already implemented against Job Schedulers, not BullMQ's removed methods.
- Added BullMQ v6 cooperative job cancellation: `bull job` gains `cancelJob` and `cancelAllJobs`, acknowledgement-scoped like every other `bull job` action.
- Added `isPaused`, `isMaxed`, and `getVersion` to `bull cmd`.
- Added opt-in OpenTelemetry tracing and metrics for `Queue`, `Worker`, and `FlowProducer` (`telemetry`, `telemetryServiceName`, `telemetryMetrics` on `bull-queue-server`), off by default. See docs/TELEMETRY.md.
- Rejected `addBulk` entries that carry repeat options, pointing at the Job Scheduler commands instead.
- Updated development dependencies: @playwright/test 1.62.1, node-red 5.0.4, prettier 3.9.6.

## 1.0.3 - 2026-07-20

- Updated to BullMQ 5.80.9 and ioredis 5.11.1, both pinned exactly.
- Paired every BullMQ resource with its owned ioredis connection, closed runtime resources on redeploy, and made independent config-node shutdowns concurrent.
- Added unambiguous Cluster and Sentinel endpoint parsing for IPv6 and Redis URLs; URL credentials are rejected in favor of Node-RED credential fields, and explicit schemes must match TLS settings.
- Required Worker concurrency and limiter values to be positive integers, with limiter maximum and duration configured together in both the runtime and editor.
- Hid deployment- and completion-specific editor fields when they do not apply, and corrected the downstream manual-acknowledgement example.

## 1.0.2 - 2026-07-13

- Updated BullMQ from 5.78.0 to 5.80.2, including the upstream Job Scheduler offset fix, while aligning ioredis with BullMQ's tested 5.10.1 release.
- Fixed manual acknowledgements that settle before the worker starts waiting, preventing jobs from remaining active indefinitely.
- Simplified full queue cleanup through BullMQ's unlimited clean operation and added clear validation for incomplete global rate-limit commands.
- Rejected Cluster and MemoryDB prefixes without a Redis hash tag such as `{bull}`.
- Expanded command-dispatch regression coverage and corrected the `getDelayed` BullMQ call signature.
- Updated Node-RED development tooling, Playwright, Prettier, and GitHub Actions dependencies.

## 1.0.1 - 2026-06-10

- Fixed Node-RED shutdown and redeploy hanging while Redis is unreachable: graceful closes are now capped at one second before the underlying sockets are force-disconnected, so Ctrl-C exits promptly. This works around BullMQ `QueueEvents.close()` blocking forever on a connection that never became ready.
- `bull cmd` now connects its shared queue eagerly and reports the real Redis connection state instead of a static green "configured" dot.
- Unified the runtime status vocabulary across `bull cmd`, `bull run`, `bull events`, and `bull flow`: yellow ring `connecting`, green dot `connected`, red ring `disconnected` (replacing the mixed `BullMQ worker: error` / `Redis events: error` style texts).
- Added Node-RED 5.x support: widened the `node-red` version range to `>=4.1.0 <6` and verified the editor, runtime, and all Redis deployment topologies against Node-RED 5.0.0.
- Updated the development dependency on Node-RED to 5.0.0; development now requires Node.js 22.9+ while the published package still supports Node.js 18+ with Node-RED 4.1.x.
- Updated the CI test matrix to Node.js 22.x and 24.x to match Node-RED 5 runtime requirements.

## 1.0.0 - 2026-06-07

- Renamed the publish package to `@pauldeng/node-red-contrib-bullmq`.
- Migrated the runtime to BullMQ 5.78.0 while preserving legacy node types: `bull-queue-server`, `bull cmd`, and `bull run`.
- Added BullMQ-focused nodes for manual job acknowledgement, QueueEvents, and FlowProducer trees.
- Added Redis deployment support for standalone Redis, Redis Cluster, AWS MemoryDB, and Redis Sentinel with ACL and TLS options.
- Documented Bull v4 migration limits, unsupported BullMQ features, and operational requirements.
- Lowered the package engine floor to Node.js 18 to match Node-RED 4.x support.
