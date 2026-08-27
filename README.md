# @pauldeng/node-red-contrib-bullmq

[![npm version](https://img.shields.io/npm/v/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![npm downloads](https://img.shields.io/npm/dm/@pauldeng/node-red-contrib-bullmq.svg)](https://www.npmjs.com/package/@pauldeng/node-red-contrib-bullmq)
[![CI](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml/badge.svg)](https://github.com/pauldeng/node-red-contrib-bullmq/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/pauldeng/node-red-contrib-bullmq/badge)](https://scorecard.dev/viewer/?uri=github.com/pauldeng/node-red-contrib-bullmq)
[![License: MIT](https://img.shields.io/npm/l/@pauldeng/node-red-contrib-bullmq.svg)](LICENSE)

Node-RED nodes for BullMQ job queues, backed by Redis or PostgreSQL.

This package targets BullMQ 6.3.1 and Node-RED 5. Version 2 is a breaking release: it uses BullMQ v6 node names, commands, and Job Scheduler inputs only.

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
- BullMQ 6.3.1
- One backend per queue config: Redis, or PostgreSQL 13+ (14+ recommended) with the optional peer dependency `pg` installed

For the Redis backend:

- Redis with `maxmemory-policy=noeviction`; evicting arbitrary BullMQ keys can corrupt queue behavior
- Durable Redis persistence; for self-managed Redis, BullMQ recommends Append Only File (AOF) persistence

BullMQ stores job data in clear text, in either backend. Do not put secrets or other sensitive data in a job payload unless the sensitive fields are encrypted before the job is added.

Bull v4 Redis data is not automatically migrated. Drain, retire, or otherwise handle old Bull queues before upgrading the runtime dependency. Upgrading from a BullMQ v5 release of this package has its own steps; see [docs/MIGRATION.md](docs/MIGRATION.md).

## Nodes

- `bullmq-queue-server`: shared BullMQ queue and backend connection config, for Redis or PostgreSQL.
- `bullmq cmd`: message-driven producer and queue administration commands.
- `bullmq run`: BullMQ Worker that emits jobs into a Node-RED flow and caps each job at 100 processing starts by default.
- `bullmq job`: manual acknowledgement and active-job actions for manual `bullmq run` flows.
- `bullmq events`: QueueEvents source node for global BullMQ events.
- `bullmq flow`: FlowProducer node for parent/child job trees.

## Backends

Each queue config node picks one backend. TLS serves both, with CA, client certificate, client key, server name, and certificate verification.

### Redis

Supported deployment modes:

- Standalone Redis
- Redis Cluster
- AWS MemoryDB, configured as Redis Cluster with TLS
- Redis Sentinel

Authentication can use Redis ACL username/password. Cluster and MemoryDB prefixes must contain a hash tag, such as `{bull}`, to keep queue keys in one Redis Cluster slot for atomic operations.

Independent queues may use different hash tags to spread load. Prefixes used in one `bullmq flow` tree or bulk flow batch must contain the same hash tag; each worker must use the exact prefix assigned to its queue in that flow.

### PostgreSQL

Host, port, database, username, password, plus a schema (`bullmq` by default), a connection pool size, and a migrations switch that creates and updates BullMQ's schema on connect. Install `pg` first (`npm install pg`); it is an optional peer dependency, and a missing install is reported once per config node on first use rather than at load.

There is no Cluster or Sentinel topology, and no key prefix — both are Redis concepts. Budget the server's `max_connections` across every pool, and note that PostgreSQL event rows are never trimmed. Full details, including what PostgreSQL does not have, are in [docs/CONNECTIONS.md](docs/CONNECTIONS.md#postgresql).

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

| BullMQ feature                         | Reason                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Sandboxed processors                   | They bypass the Node-RED flow and downstream acknowledgement model.                                              |
| Custom JavaScript backoff strategies   | Executable strategy code is not a safe Node-RED message contract. Use built-in fixed/exponential backoff.        |
| BullMQ Pro features                    | Pro groups, batches, and observables are not part of the open-source BullMQ dependency.                          |
| Built-in dashboard                     | Use a dedicated queue UI; this package only provides Node-RED nodes.                                             |
| Arbitrary method proxying              | Unrestricted method dispatch is hard to validate, document, secure, and test.                                    |
| Dynamic child creation                 | Declare dependencies up front with `bullmq flow`; processor-owned `moveToWaitingChildren` wiring is not exposed. |
| Automatic Bull v4 Redis data migration | Bull and BullMQ do not provide a supported queue-data migration contract.                                        |

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
