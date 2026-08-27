# Architecture

The package remains a single Node-RED module entry point, but BullMQ behavior is split into focused CommonJS helpers.

## Entry Point

`bull-queue.js` registers:

- `bullmq-queue-server`
- `bullmq cmd`
- `bullmq run`
- `bullmq job`
- `bullmq events`
- `bullmq flow`

The runtime does Node-RED lifecycle work only: creating nodes, wiring input handlers, setting status, and closing resources.

## Connections

`bullmq-queue-server` owns queue name and Redis deployment config. It creates role-specific ioredis connections:

- producer connections fail fast through `skipWaitingForReady: true` on the BullMQ owner plus `maxRetriesPerRequest: 1` on the socket. Without the first, BullMQ awaits a connection-ready promise that never settles while Redis is unreachable, so a `bullmq cmd` command hangs instead of erroring and the node never calls `done()`. The offline queue is deliberately left enabled so messages emitted during the brief connection window after a deploy are buffered;
- worker and event connections use `maxRetriesPerRequest: null` and keep the offline queue, because a consumer should wait for the connection to come back rather than fail;
- every role reconnects with exponential backoff between 1s and 20s, including Cluster and Sentinel discovery retries;
- QueueEvents uses a dedicated connection;
- Cluster and MemoryDB use `{bull}` by default as the BullMQ prefix.

Each BullMQ owner (`Queue`, `Worker`, `QueueEvents`, or `FlowProducer`) is tracked with its owned ioredis connection. A runtime node releases its pair on redeploy; config-node shutdown closes independent pairs concurrently. See Shutdown below for how each owner/connection pair actually closes.

Connection and resource errors are reported on the consuming runtime node's status (`bullmq run`, `bullmq events`, `bullmq flow`). The config node owns the shared queue and its producer connection. Each `bullmq cmd` mirrors that shared queue's backend (`Queue.getBackend()`, BullMQ's `IQueueBackend`) on its visible status instead of reading the producer connection directly, while Queue errors report on the config node.

Secrets are read only from Node-RED credentials.

Queue retention defaults are attached directly to `Queue`. For a single tree, `bullmq flow` builds BullMQ `queuesOptions` for every queue name so the same defaults also reach `FlowProducer`. For a bulk array, whose BullMQ API accepts no options argument, it stamps the defaults onto each job's `opts`. Both paths preserve job-level overrides.

## Shutdown

Closing an owner/connection pair (`bull-queue.js`) uses a budget chosen from the resource ownership already recorded in the config node's `resources` map:

- A Redis owner with a ready companion ioredis connection gets `GRACEFUL_CLOSE_MS` (10 seconds). `Worker.close()` waits for in-flight jobs, and cutting that off abandons a running job to the stalled checker, which re-runs it and can eventually fail it for exceeding `maxStalledCount`.
- A Redis owner whose companion connection is not ready gets `CLOSE_GRACE_MS` (1 second), followed by the Redis force-disconnect fallback.
- A PostgreSQL owner has no companion connection because BullMQ owns its pool. It gets `POSTGRES_CLOSE_MS` (11 seconds), derived as `POSTGRES_CONNECTION_TIMEOUT_MS` (the 10-second `connectionTimeoutMillis` this package fixes in `lib/connections.js`) plus one second of scheduling margin, so raising that timeout cannot leave the budget short. PostgreSQL exposes no raw client that this package can safely force closed, so Node-RED must await pg's own timeout before reporting close complete.

Pairs close concurrently, so these budgets bound one resource rather than adding across all resources. They also avoid using the config node's shared `backendStatus`: that status belongs to the shared `Queue`, so a config node backing only a `bullmq run` node may never advance it.

Within that budget:

1. The BullMQ owner's own graceful close (`Queue.close()` / `Worker.close()` / `QueueEvents.close()` / `FlowProducer.close()`). This alone succeeds whenever the datastore is reachable.
2. If graceful close times out, force-disconnect and stop Worker lock-renewal/stalled-check timers (`forceDisconnect`).

Step 2 differs by backend:

- **Redis**: force-disconnect the backend's raw ioredis clients (`connection._client` / `blockingConnection._client`), behind an `IQueueBackend` capability check (`typeof resource.getBackend === "function"`). This escalation is deliberately tied to the exact BullMQ 6.3.1 pin: its public `disconnect()` awaits the same never-ready connection promise as `close()`, so calling it would spend a second grace period without improving shutdown. Re-evaluate the fallback whenever the BullMQ pin changes.
- **PostgreSQL**: no raw-force branch. Against a blackholed host, `PostgresConnection.close()` settles when its configured 10-second connection timeout expires; the 11-second PostgreSQL budget awaits that promise instead of returning while its socket is still active. Worker's lock-renewal and stalled-check timers remain Worker-owned and use the same cleanup path on both backends.

A raw ioredis connection (not a BullMQ owner) skips straight to a force-disconnect after its own bounded `quit()`/close attempt. Every step is best-effort — one step's error does not stop the ones after it — which is what keeps Node-RED shutdown and redeploy from hanging when the datastore is unreachable.

## Commands

`lib/commands.js` maps `msg.cmd` to explicit BullMQ v6 calls. It does not expose arbitrary method names or compatibility aliases.

## Schedulers

`lib/scheduler.js` serializes Job Scheduler metadata and requires an exact `msg.schedulerId`. Creation uses native `msg.repeat` and `msg.template` inputs.

## Workers And Acknowledgement

`bullmq run` creates a BullMQ Worker.

- Immediate mode sends a Node-RED message and completes the job immediately.
- Manual mode creates an opaque `msg.bull.ackId` and waits for a downstream `bullmq job` node.
- Every worker defaults `maxStartedAttempts` to 100 so repeated non-failing transitions cannot reactivate one job forever.

The in-process acknowledgement registry (`lib/acknowledgements.js`) stores live jobs and promise settlement functions. Each entry self-removes when it settles (complete, fail, timeout, or run-node close), so the registry does not accumulate finished jobs. Lock tokens are never sent in messages.

### Cancellation

`bullmq run` builds its processor with three arguments (`async (job, token, signal) => …`), which tells BullMQ to track a per-job `AbortController` for every job it runs, immediate or manual mode alike. `bullmq job`'s `cancelJob`/`cancelAllJobs` actions call `worker.cancelJob()`/`worker.cancelAllJobs()`, which abort that job's signal. `lib/acknowledgements.js` listens for the abort and fails the pending acknowledgement, so the worker's `await acknowledgement.entry.wait()` rejects and the job fails. BullMQ then applies the queue's normal attempts/backoff retry policy — cancellation only fails the current attempt, it does not remove the job.

Both actions require the acknowledgement behind `msg.bull.ackId`, so they only reach manual-mode jobs that have not already settled.

## Events And Flows

`bullmq events` wraps QueueEvents and emits event messages with `msg.topic`, `msg.payload`, and `msg.bull` metadata.

`bullmq flow` wraps FlowProducer and serializes the returned parent/child tree, or the array of trees returned by `addBulk`.
