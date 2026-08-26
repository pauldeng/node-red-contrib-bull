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

- producer connections fail quickly with bounded retries;
- worker and event connections use `maxRetriesPerRequest: null`;
- QueueEvents uses a dedicated connection;
- Cluster and MemoryDB use `{bull}` by default as the BullMQ prefix.

Each BullMQ owner (`Queue`, `Worker`, `QueueEvents`, or `FlowProducer`) is tracked with its owned ioredis connection. A runtime node releases its pair on redeploy; config-node shutdown closes independent pairs concurrently. See Shutdown below for how each owner/connection pair actually closes.

Connection and resource errors are reported on the consuming runtime node's status (`bullmq run`, `bullmq events`, `bullmq flow`). The config node owns the shared queue and its producer connection. Each `bullmq cmd` mirrors that shared producer connection on its visible status, while Queue errors report on the config node.

Secrets are read only from Node-RED credentials.

## Shutdown

Closing an owner/connection pair (`bull-queue.js`) uses one `CLOSE_GRACE_MS` (1 second) budget:

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

The in-process acknowledgement registry (`lib/acknowledgements.js`) stores live jobs and promise settlement functions. Each entry self-removes when it settles (complete, fail, timeout, or run-node close), so the registry does not accumulate finished jobs. Lock tokens are never sent in messages.

### Cancellation

`bullmq run` builds its processor with three arguments (`async (job, token, signal) => …`), which tells BullMQ to track a per-job `AbortController` for every job it runs, immediate or manual mode alike. `bullmq job`'s `cancelJob`/`cancelAllJobs` actions call `worker.cancelJob()`/`worker.cancelAllJobs()`, which abort that job's signal. `lib/acknowledgements.js` listens for the abort and fails the pending acknowledgement, so the worker's `await acknowledgement.entry.wait()` rejects and the job fails. BullMQ then applies the queue's normal attempts/backoff retry policy — cancellation only fails the current attempt, it does not remove the job.

Both actions require the acknowledgement behind `msg.bull.ackId`, so they only reach manual-mode jobs that have not already settled.

## Events And Flows

`bullmq events` wraps QueueEvents and emits event messages with `msg.topic`, `msg.payload`, and `msg.bull` metadata.

`bullmq flow` wraps FlowProducer and serializes the returned parent/child tree.
