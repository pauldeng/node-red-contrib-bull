# @pauldeng/node-red-contrib-bullmq

[![npm version](https://img.shields.io/npm/v/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![npm downloads](https://img.shields.io/npm/dm/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![CI](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml/badge.svg)](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/pauldeng/node-red-contrib-bullmq/badge)](https://scorecard.dev/viewer/?uri=github.com/pauldeng/node-red-contrib-bullmq)
[![License: MIT](https://img.shields.io/npm/l/@pauldeng/node-red-contrib-bullmq.svg)](LICENSE)

Node-RED nodes for BullMQ-backed Redis job queues.

This package targets BullMQ 5.80.6 and Node-RED 4.1 or 5.x. It preserves the legacy `bull-queue-server`, `bull cmd`, and `bull run` node types where BullMQ has compatible behavior, and adds `bull job`, `bull events`, and `bull flow`.

## Installation

To install - either use the manage palette option in the editor, or change to your Node-RED user directory.

```sh
cd ~/.node-red
npm install @pauldeng/node-red-contrib-bullmq
```

Repository: <https://github.com/pauldeng/node-red-contrib-bullmq>

## Requirements

- Node-RED 4.1.x or 5.x
- Node.js 18+ with Node-RED 4.1.x, or Node.js 22.9+ with Node-RED 5.x
- Redis with `maxmemory-policy=noeviction`
- BullMQ 5.80.6

Bull v4 Redis data is not automatically migrated. Drain, retire, or otherwise handle old Bull queues before upgrading the runtime dependency.

## Nodes

- `bull-queue-server`: shared BullMQ queue and Redis deployment config.
- `bull cmd`: message-driven producer and queue administration commands.
- `bull run`: BullMQ Worker that emits jobs into a Node-RED flow.
- `bull job`: manual acknowledgement and active-job actions for manual `bull run` flows.
- `bull events`: QueueEvents source node for global BullMQ events.
- `bull flow`: FlowProducer node for parent/child job trees.

## Redis Deployments

Supported deployment modes:

- Standalone Redis
- Redis Cluster
- AWS MemoryDB, configured as Redis Cluster with TLS
- Redis Sentinel

Authentication can use Redis ACL username/password. TLS supports CA, client certificate, client key, server name, and certificate verification. Cluster and MemoryDB prefixes must contain a hash tag, such as `{bull}`, to keep queue keys in one Redis Cluster slot for atomic operations.

## Legacy Repeat Cron Compatibility

The legacy repeat flow remains supported through BullMQ Job Schedulers:

```js
msg.payload = "gateway-FCC23DFFFE0AA2A8";
msg.cmd = "add";
msg.jobopts = {
  jobId: msg.payload,
  repeat: {
    cron: "30 9,19,29,39,49,59 * * * *",
  },
};
return msg;
```

When adding a legacy repeat job, the scheduler id is `msg.schedulerId` when present, otherwise `msg.jobopts.jobId`. `repeat.cron` is translated to `repeat.pattern`; conflicting `cron` and `pattern` values are rejected. Lookup and removal commands require the exact scheduler id in `msg.schedulerId`, `msg.jobid`, or `msg.jobId`.

## Commands

`bull cmd` reads `msg.cmd`. The legacy `msg.command` alias is also accepted, but new flows should use `msg.cmd`. The default command is `add`.

Core supported command families include:

- add jobs, add bulk jobs, get jobs, retry jobs, remove jobs
- delayed jobs and delay promotion
- priorities and priority counts
- deduplication keys
- Job Scheduler commands and legacy repeat aliases
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

- [examples/example_flow.json](examples/example_flow.json): an end-to-end flow with add/run, a legacy scheduler compatibility case, delayed and prioritized jobs, manual acknowledgement, QueueEvents, and a parent/child flow.
- [examples/bullmq_features.json](examples/bullmq_features.json): focused examples of common BullMQ features.
- [examples/repeatable_jobs.json](examples/repeatable_jobs.json): legacy repeat-command and Job Scheduler compatibility examples.

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
- [Migration Guide](docs/MIGRATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Changelog](CHANGELOG.md)
