# Connection Guide

BullMQ v6 stores a queue in either Redis or PostgreSQL. Each `bullmq-queue-server` config node picks one with **Backend**; everything below the Redis heading applies to the Redis backend only, and the PostgreSQL section states what changes.

## Standalone Redis

Use deployment `single`, host, port, optional database, optional username/password, and optional TLS.

Producer commands fail fast so a Node-RED input handler errors instead of hanging forever: the BullMQ owner sets `skipWaitingForReady: true` and the socket keeps `maxRetriesPerRequest: 1`, which rejects in about a second when Redis is down. Workers and QueueEvents use the persistent retry behavior BullMQ requires (`maxRetriesPerRequest: null`).

The offline queue stays enabled for producers too, which departs from BullMQ's production guide. Disabling it does fail faster, but it also rejects messages emitted during the brief connection window after a Node-RED deploy.

Every data connection reconnects with exponential backoff floored at 1s and capped at 20s, which is what [BullMQ's production guide](https://docs.bullmq.io/guide/going-to-production) recommends. Cluster discovery uses the same range through `clusterRetryStrategy`, and Sentinel discovery uses it through `sentinelRetryStrategy`.

## PostgreSQL

Select backend `postgres`. The connection uses **Host**, **Port** (5432), **Database Name**, **Username**, the password credential, and three PostgreSQL-only fields: **Schema**, **Pool Max**, and **Migrations**. BullMQ owns every PostgreSQL connection — a pool plus one dedicated `LISTEN` client per backend — so this package creates none of its own on that path, and there is no raw client to reach for.

A blank **Username** or **Database Name** is not "no value": node-postgres falls back to the `PGUSER`/`PGDATABASE` environment variables and then to the operating-system user name, so a blank field takes its value from the Node-RED process's environment. Set both explicitly unless that fallback is deliberate.

`pg` is an optional peer dependency and is not installed with this package. Install it separately (`npm install pg`) before selecting the backend. BullMQ lazily requires it while constructing a queue, so a missing install is reported once per config node on first use, naming the command to run, rather than at load.

PostgreSQL 13 is the floor BullMQ enforces and 14 is what it recommends; an older server is rejected with its version named. The server version is checked on connect, so a downgrade is reported rather than discovered mid-job.

### Schema

BullMQ's tables live in a schema, `bullmq` by default. Separate schemas keep independent queue sets in one database, and the schema name is validated before any I/O — an invalid name throws out of the queue constructor rather than reaching the server.

### Migrations

**Migrations** on (the default) runs BullMQ's migrator when the connection is first established, which issues `CREATE SCHEMA IF NOT EXISTS` and brings the schema to the version this BullMQ release expects. It is safe with several queues, workers, and event listeners starting at once: the migrator takes a PostgreSQL advisory lock, so concurrent starts converge on one migration rather than racing.

Turn it off where the database user is not permitted to change the schema, and apply BullMQ's migrations out of band. A queue pointed at a database whose schema is missing or outdated then reports that as an actionable error naming the schema, not a stack trace, and the node stays usable.

### Pool sizing

**Pool Max** is the maximum connections in _each_ pool, defaulting to 2. Blank means the default; `0` is rejected, because a pool that can never hand out a connection cannot run a queue.

There is one pool per BullMQ resource, not one per config node. BullMQ builds a fresh connection for every `Queue`, `Worker`, `QueueEvents`, and `FlowProducer`, and each of those also holds one dedicated `LISTEN` connection outside its pool. A config node feeding one `bullmq cmd`, one `bullmq run`, one `bullmq events`, and one `bullmq flow` therefore costs up to 4 × (**Pool Max** + 1) server connections — 12 at the default.

Unlike Redis, PostgreSQL has a hard server-wide ceiling — `max_connections`, commonly 100, shared with every other client. Multiply the figure above by every config node and every Node-RED instance pointed at the database before assuming headroom. Raise `max_connections`, or put a pooler in front, rather than guessing.

Raising **Pool Max** is the answer to a busy worker, not lowering it. node-postgres applies the same 10-second connection timeout to waiting for a free pooled connection as it does to opening a new one, so a `bullmq run` node whose **Concurrency** is well above **Pool Max** can fail an operation with `timeout exceeded when trying to connect` under load rather than merely running slower. Size the pool against the worker concurrency it has to serve, then check the total against `max_connections`.

### TLS

The shared TLS fields apply: enabling **TLS** builds the `ssl` object node-postgres receives, with the CA, client certificate, client key, and verification settings. One difference from Redis: node-postgres derives the TLS server name from the connection host when that host is a hostname, so **TLS Server Name** takes effect only when **Host** is a literal IP address.

### What PostgreSQL does not have

- No Cluster and no Sentinel. Those are Redis topologies; **Deployment** is hidden for PostgreSQL, and high availability is the database's own concern.
- No key prefix. `prefix` is a Redis key-namespacing concept and is not sent, so the hash-tag rules below do not apply.
- No raw client access, which is why shutdown differs — see the PostgreSQL step in [ARCHITECTURE.md](ARCHITECTURE.md#shutdown).
- Three operations in BullMQ 6.3.1's PostgreSQL adapter throw `operation '...' is not implemented yet`: `trimEvents`, `removeDeprecatedPriorityKey`, and `paginate` for anything other than a flow's `:dependencies` and `:processed` keys. None is on a path these nodes use today.
- Event rows are never trimmed. The adapter's `publishEvent` ignores the `maxEvents` argument, so the events table grows for as long as the queue is used. Prune it out of band if a flow leans on `bullmq events`.
- BullMQ's own PostgreSQL documentation reports lower job-processing throughput than Redis, with `addBulk` close to parity. Treat Redis as the faster backend for high job rates and PostgreSQL as the one that removes a second datastore from the deployment.

## Production Redis Configuration

Redis must use `maxmemory-policy=noeviction`; evicting arbitrary BullMQ keys can corrupt queue behavior. Redis data must also be durable. For self-managed Redis, BullMQ recommends Append Only File (AOF) persistence, commonly with writes flushed once per second. For managed Redis, enable the provider's durable persistence and backup features appropriate to the job-loss tolerance of the deployment.

## Redis Cluster

Use deployment `cluster` and provide startup nodes as a comma- or newline-separated endpoint list.

Cluster auth and TLS are applied through ioredis `redisOptions`. The runtime always sets a DNS lookup passthrough for cluster discovery, including non-TLS deployments.

The BullMQ prefix must contain a Redis hash tag. Untagged Cluster prefixes are rejected to prevent `CROSSSLOT` failures.

`{bull}` is the default. Independent queues may use different tagged prefixes — `{orders}`, `{emails}` — to spread load across cluster nodes. Prefixes used in one `bullmq flow` tree or `FlowProducer.addBulk` batch must instead contain the same Redis hash tag because BullMQ updates those queues atomically and all involved keys must share a slot. Exact prefixes may differ, such as `{flow}:orders` and `{flow}:emails`; each worker must use the exact prefix assigned to its queue in the flow.

## AWS MemoryDB

Use deployment `cluster`.

Typical settings:

- cluster endpoint and port as a startup node;
- ACL username and password;
- TLS enabled;
- prefix `{bull}`;
- client located in a VPC/network path that can reach MemoryDB.

Do not write MemoryDB credentials into flows, examples, docs, or logs.

## Sentinel

Use deployment `sentinel` and configure:

- Sentinel endpoints;
- master name;
- optional Redis data-node username/password;
- optional Sentinel username/password;
- optional TLS for Redis data nodes;
- optional TLS for Sentinel discovery.

Sentinel authentication is separate from Redis data-node authentication.

## Cluster And Sentinel Endpoint Lists

Cluster startup nodes and Sentinel discovery lists accept host names, `host:port`, bare IPv6 with the default port, bracketed IPv6 such as `[2001:db8::1]:6379`, and `redis://` or `rediss://` URLs. Explicit URL schemes must agree with the applicable TLS setting: Cluster endpoints use `tls`, and Sentinel discovery endpoints use `sentinelTls`.

URL credentials are rejected. Store Redis and Sentinel usernames/passwords in the config node credential fields instead of embedding them in an endpoint.

## TLS

TLS behavior and options:

- rejects unauthorized certificates by default;
- optional CA;
- optional client certificate;
- optional client private key;
- optional server name.

These fields serve both backends. Disable verification only when the deployment cannot be configured with a trusted CA and the risk is understood.

## Secrets And Imported Flows

Passwords, CA data, client certificates, and private keys are read only from Node-RED credentials.

BullMQ stores job names, payloads, results, and failure details in clear text, in Redis or in PostgreSQL alike. Avoid sensitive job data; when it is unavoidable, encrypt sensitive fields before sending the job to `bullmq cmd` or `bullmq flow` and decrypt them only in a trusted worker path.
