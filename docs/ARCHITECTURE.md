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

Closing an owner/connection pair (`bull-queue.js`) uses one of two budgets, chosen from the tracked connection's state:

- `GRACEFUL_CLOSE_MS` (10 seconds) when the connection is `ready`. `Worker.close()` waits for in-flight jobs, and cutting that off abandons a running job to the stalled checker, which re-runs it and can eventually fail it for exceeding `maxStalledCount`. The ceiling stays under Node-RED's own node close timeout, and pairs close concurrently, so it bounds one resource rather than the sum.
- `CLOSE_GRACE_MS` (1 second) otherwise, so an unreachable Redis never blocks shutdown or redeploy.

Within that budget:

1. The BullMQ owner's own graceful close (`Queue.close()` / `Worker.close()` / `QueueEvents.close()` / `FlowProducer.close()`). This alone succeeds whenever Redis is reachable.
2. If graceful close times out, force-disconnect the backend's raw ioredis clients and stop Worker lock-renewal/stalled-check timers.

The fallback is deliberately tied to the exact BullMQ 6.2.1 pin. Its public `disconnect()` awaits the same never-ready connection promise as `close()`, so calling it would spend a second grace period without improving shutdown. Re-evaluate the fallback whenever the BullMQ pin changes.

A raw ioredis connection (not a BullMQ owner) skips straight to a force-disconnect after its own bounded `quit()`/close attempt. Every step is best-effort — one step's error does not stop the ones after it — which is what keeps Node-RED shutdown and redeploy from hanging when Redis is unreachable.

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
