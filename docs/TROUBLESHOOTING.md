# Troubleshooting

## Worker Does Not Receive Jobs

- Confirm `bullmq run` uses the same `bullmq-queue-server` as `bullmq cmd`.
- Confirm the backend (Redis or PostgreSQL) is reachable from the Node-RED process.
- Confirm the queue name is correct.
- For scheduled jobs, BullMQ creates the next delayed job only as the previous scheduled job starts processing.

## Cluster `CROSSSLOT` Errors

Use a BullMQ prefix with a Redis Cluster hash tag, such as `{bull}`. This keeps BullMQ queue keys in the same slot for atomic operations.

## MemoryDB Connection Hangs

MemoryDB is a Cluster deployment and normally requires TLS from an EC2/VPC client that can reach the endpoint. Use Cluster mode, TLS, ACL username/password, and a reachable VPC network path.

## `Cannot find module 'pg'`

The PostgreSQL backend needs the optional peer dependency: `npm install pg` in the Node-RED user directory, then redeploy. BullMQ loads `pg` while constructing the queue, so this is reported on first use rather than at load, once per config node.

## `PostgreSQL schema "bullmq" is not initialized`

The database has no BullMQ schema and this node was told not to create one. Either enable **Migrations** on the queue config node so it initialises the schema, or run BullMQ's PostgreSQL migrations against the database yourself before deploying. The node stays usable and reports the error rather than hanging.

## PostgreSQL Schema Version Mismatch

The schema was created by a different BullMQ major version. Upgrade this package to a release using the required BullMQ major; PostgreSQL schema downgrades are not supported.

## Unsupported PostgreSQL Version

BullMQ requires PostgreSQL 13 or newer, and recommends 14+. The server version is checked on connect, so this is reported before any job work rather than discovered mid-job.

## PostgreSQL Connections Exhausted

PostgreSQL has a server-wide `max_connections` ceiling, commonly 100, shared with every other client. There is one pool per BullMQ resource rather than one per config node; Worker and QueueEvents also hold one dedicated `LISTEN` connection each. A config node feeding `bullmq cmd`, `bullmq run`, `bullmq events`, and `bullmq flow` therefore costs up to 4 × **Pool Max** + 2 connections — 10 at the default — and many queues or many Node-RED instances multiply that. Raise `max_connections`, lower **Pool Max**, or put a pooler in front.

## PostgreSQL `timeout exceeded when trying to connect`

Two different causes share this message, because node-postgres uses one timeout for both. Either the server is unreachable, or the pool is full and the caller waited 10 seconds for a free connection. Suspect contention when the database is healthy. Raise **Pool Max** only after observing sustained pool waits; worker **Concurrency** does not require a one-to-one pool size because each operation releases its client. Re-check the total against `max_connections` after any increase.

## PostgreSQL Events Table Keeps Growing

Expected, and not fixable from here: BullMQ's PostgreSQL adapter ignores the `maxEvents` trim argument, so event rows accumulate for as long as the queue is used. Prune the table out of band if a flow relies on `bullmq events`.

## TLS Certificate Errors

Keep TLS verification enabled when possible. Provide the CA certificate or server name the deployment needs. On PostgreSQL, node-postgres takes the TLS server name from the connection host when that host is a hostname, so the server-name override only applies when the host is a literal IP address. Disable verification only for controlled deployments that cannot be configured with a trusted CA.

## Job Scheduler Is Not Found

Job Scheduler lookup uses exact ids. Pass the id used during creation in `msg.schedulerId`.

## Bull v4 Queue Data Missing After Upgrade

Bull v4 Redis data is not automatically migrated. Drain or retire old queues before switching production flows to BullMQ.

## Repeat Job Fires At The Wrong Hour

BullMQ v6 uses `msg.repeat.pattern` and optional `msg.repeat.tz` with `upsertJobScheduler`. Confirm the IANA timezone name and remove/recreate any scheduler created with the wrong timezone.

## `cancelJob` Says No Cancellable Processor

`cancelJob`/`cancelAllJobs` need the acknowledgement behind `msg.bull.ackId`, which only exists for a manual-mode job that has not yet settled. Two different failures look similar:

- No usable `ackId` at all — an immediate-mode job's output message never carries one, and reusing an `ackId` after its job already completed, failed, timed out, or was already cancelled fails the same way. This raises a missing/stale/already-settled acknowledgement error, not "no cancellable processor".
- `BullMQ found no cancellable processor for job <id>` — the `ackId` was still valid, but BullMQ was no longer tracking a cancellation signal for that job. BullMQ stops tracking a job the moment its processor promise settles, so this is a narrow race: the job completed, failed, or lost its lock between the worker sending the message and the cancel arriving. It is also what you would see if `bullmq run`'s processor were ever changed to take fewer than three parameters, because BullMQ only creates the per-job `AbortController` when the processor declares the signal argument.
