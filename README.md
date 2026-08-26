# @pauldeng/node-red-contrib-bullmq

[![npm version](https://img.shields.io/npm/v/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![npm downloads](https://img.shields.io/npm/dm/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![CI](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml/badge.svg)](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/pauldeng/node-red-contrib-bullmq/badge)](https://scorecard.dev/viewer/?uri=github.com/pauldeng/node-red-contrib-bullmq)
[![License: MIT](https://img.shields.io/npm/l/@pauldeng/node-red-contrib-bullmq.svg)](LICENSE)

Node-RED nodes for BullMQ-backed Redis job queues.

This package targets BullMQ 6.2.1 and Node-RED 5. Version 2 is a breaking release: it uses BullMQ v6 node names, commands, and Job Scheduler inputs only.

## Installation

To install - either use the manage palette option in the editor, or change to your Node-RED user directory.

```sh
cd ~/.node-red
npm install @pauldeng/node-red-contrib-bullmq
```

Repository: <https://github.com/pauldeng/node-red-contrib-bullmq>

## Requirements

- Node-RED 5.x
- Node.js 22.9+
- Redis with `maxmemory-policy=noeviction`
- Durable Redis persistence; for self-managed Redis, BullMQ recommends Append Only File (AOF) persistence
- BullMQ 6.2.1

BullMQ stores job data in clear text. Do not put secrets or other sensitive data in a job payload unless the sensitive fields are encrypted before the job is added.

Bull v4 Redis data is not automatically migrated. Drain, retire, or otherwise handle old Bull queues before upgrading the runtime dependency. Upgrading from a BullMQ v5 release of this package has its own steps; see [docs/MIGRATION.md](docs/MIGRATION.md).

## Nodes

- `bullmq-queue-server`: shared BullMQ queue and Redis deployment config.
- `bullmq cmd`: message-driven producer and queue administration commands.
- `bullmq run`: BullMQ Worker that emits jobs into a Node-RED flow.
- `bullmq job`: manual acknowledgement and active-job actions for manual `bullmq run` flows.
- `bullmq events`: QueueEvents source node for global BullMQ events.
- `bullmq flow`: FlowProducer node for parent/child job trees.

## Redis Deployments

Supported deployment modes:

- Standalone Redis
- Redis Cluster
- AWS MemoryDB, configured as Redis Cluster with TLS
- Redis Sentinel

Authentication can use Redis ACL username/password. TLS supports CA, client certificate, client key, server name, and certificate verification. Cluster and MemoryDB prefixes must contain a hash tag, such as `{bull}`, to keep queue keys in one Redis Cluster slot for atomic operations.

## Job Schedulers

Use the native BullMQ v6 Job Scheduler shape:

```js
msg.cmd = "upsertJobScheduler";
msg.schedulerId = "gateway-FCC23DFFFE0AA2A8";
msg.repeat = {
  pattern: "30 9,19,29,39,49,59 * * * *",
  tz: "UTC",
};
msg.template = {
  name: "default",
  data: { payload: "gateway-FCC23DFFFE0AA2A8" },
};
return msg;
```

Lookup and removal commands require the exact id in `msg.schedulerId`.

## Commands

`bullmq cmd` reads `msg.cmd`; the default command is `add`.

Core supported command families include:

- add jobs, add bulk jobs, get jobs, retry jobs, remove jobs
- delayed jobs and delay promotion
- priorities and priority counts
- deduplication keys
- BullMQ v6 Job Scheduler commands
- pause, resume, drain, clean, and `stopAndRemoveAllJobs`
- global concurrency and rate limits
- job logs and Prometheus metrics export

See [docs/COMMANDS.md](docs/COMMANDS.md).

## Unsupported

| BullMQ feature                         | Reason                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sandboxed processors                   | They bypass the Node-RED flow and downstream acknowledgement model.                                       |
| Custom JavaScript backoff strategies   | Executable strategy code is not a safe Node-RED message contract. Use built-in fixed/exponential backoff. |
| BullMQ Pro features                    | Pro groups, batches, and observables are not part of the open-source BullMQ dependency.                   |
| Built-in dashboard                     | Use a dedicated queue UI; this package only provides Node-RED nodes.                                      |
| Arbitrary method proxying              | Unrestricted method dispatch is hard to validate, document, secure, and test.                             |
| Automatic Bull v4 Redis data migration | Bull and BullMQ do not provide a supported queue-data migration contract.                                 |

## Examples

Import any of these flows into Node-RED:

- [examples/example_flow.json](examples/example_flow.json): an end-to-end flow with add/run, a Job Scheduler, delayed and prioritized jobs, manual acknowledgement, QueueEvents, and a parent/child flow.
- [examples/bullmq_features.json](examples/bullmq_features.json): focused examples, including one delayed job, a batch with increasing delays, and a series targeted at exact ISO date-times.
- [examples/repeatable_jobs.json](examples/repeatable_jobs.json): native BullMQ v6 Job Scheduler examples.

The examples do not contain secrets.

## Development

```sh
npm install
npm test
```

Use [docs/TESTING.md](docs/TESTING.md) for Docker, Playwright, and MemoryDB test plans. Use [docs/CHANGE_WORKFLOW.md](docs/CHANGE_WORKFLOW.md) before changing behavior.

## More Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Node Guide](docs/NODE_GUIDE.md)
- [Connection Guide](docs/CONNECTIONS.md)
- [Telemetry Guide](docs/TELEMETRY.md)
- [Migration Guide](docs/MIGRATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Changelog](CHANGELOG.md)
