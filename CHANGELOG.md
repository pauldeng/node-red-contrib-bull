# Changelog

All notable changes to this package are documented here.

## Unreleased

- Updated BullMQ from 5.78.0 to 5.80.2, including the upstream Job Scheduler offset fix.
- Expanded command-dispatch regression coverage and corrected the `getDelayed` BullMQ call signature.

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
