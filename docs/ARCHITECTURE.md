# Architecture

The package remains a single Node-RED module entry point, but BullMQ behavior is split into focused CommonJS helpers.

## Entry Point

`bull-queue.js` registers:

- `bull-queue-server`
- `bull cmd`
- `bull run`
- `bull job`
- `bull events`
- `bull flow`

The runtime does Node-RED lifecycle work only: creating nodes, wiring input handlers, setting status, and closing resources.

## Connections

`bull-queue-server` owns queue name and Redis deployment config. It creates role-specific ioredis connections:

- producer connections fail quickly with bounded retries;
- worker and event connections use `maxRetriesPerRequest: null`;
- QueueEvents uses a dedicated connection;
- Cluster and MemoryDB use `{bull}` by default as the BullMQ prefix.

Each BullMQ owner (`Queue`, `Worker`, `QueueEvents`, or `FlowProducer`) is tracked with its owned ioredis connection. A runtime node releases its pair on redeploy; config-node shutdown closes independent pairs concurrently. See Shutdown below for how each owner/connection pair actually closes.

Connection and resource errors are reported on the consuming runtime node's status (`bull run`, `bull events`, `bull flow`). The config node owns the shared queue and its producer connection. Each `bull cmd` mirrors that shared producer connection on its visible status, while Queue errors report on the config node.

Secrets are read from Node-RED credentials first, with legacy plain fields accepted only for backward compatibility.

## Shutdown

Closing an owner/connection pair (`bull-queue.js`) escalates through four steps, each attempted only after the previous one fails to settle within `CLOSE_GRACE_MS` (1 second):

1. The BullMQ owner's own graceful close (`Queue.close()` / `Worker.close()` / `QueueEvents.close()` / `FlowProducer.close()`). This alone succeeds whenever Redis is reachable.
2. The owner's public `disconnect()`. On installed BullMQ 6.2.1, `RedisConnection.disconnect()` awaits the same connection-ready promise `close()` blocks on, so while Redis is unreachable this step cannot settle either — it is still tried first because it is the supported API, and it is the only step that can succeed on its own once Redis returns.
3. A force-disconnect of the backend's raw ioredis clients, reached through the owner's `getBackend()` accessor rather than a private field.
4. For a `Worker` specifically: stop the lock-renewal timer (`worker.lockManager.close()`) and the stalled-job checker (`worker.stalledCheckStopper()`). `Worker.close()` only clears these itself after the cleanup step that step 1 got stuck on, so a hung close never reaches them without this.

A raw ioredis connection (not a BullMQ owner) skips straight to a force-disconnect after its own bounded `quit()`/close attempt. Every step is best-effort — one step's error does not stop the ones after it — which is what keeps Node-RED shutdown and redeploy from hanging when Redis is unreachable.

## Commands

`lib/commands.js` maps `msg.cmd` to explicit BullMQ calls. It does not expose arbitrary method names. Legacy repeat commands call Job Scheduler APIs.

## Schedulers

`lib/scheduler.js` translates `msg.jobopts.repeat.cron` to `repeat.pattern` and requires a deterministic scheduler id. Scheduler lookup/removal uses exact ids.

## Workers And Acknowledgement

`bull run` creates a BullMQ Worker.

- Immediate mode sends a Node-RED message and completes the job immediately.
- Manual mode creates an opaque `msg.bull.ackId` and waits for a downstream `bull job` node.

The in-process acknowledgement registry (`lib/acknowledgements.js`) stores live jobs and promise settlement functions. Each entry self-removes when it settles (complete, fail, timeout, or run-node close), so the registry does not accumulate finished jobs. Lock tokens are never sent in messages.

### Cancellation

`bull run` builds its processor with three arguments (`async (job, token, signal) => …`), which tells BullMQ to track a per-job `AbortController` for every job it runs, immediate or manual mode alike. `bull job`'s `cancelJob`/`cancelAllJobs` actions call `worker.cancelJob()`/`worker.cancelAllJobs()`, which abort that job's signal. `lib/acknowledgements.js` listens for the abort and fails the pending acknowledgement, so the worker's `await acknowledgement.entry.wait()` rejects and the job fails. BullMQ then applies the queue's normal attempts/backoff retry policy — cancellation only fails the current attempt, it does not remove the job.

Both actions require the acknowledgement behind `msg.bull.ackId`, so they only reach manual-mode jobs that have not already settled.

## Events And Flows

`bull events` wraps QueueEvents and emits event messages with `msg.topic`, `msg.payload`, and `msg.bull` metadata.

`bull flow` wraps FlowProducer and serializes the returned parent/child tree.
