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

Each BullMQ owner (`Queue`, `Worker`, `QueueEvents`, or `FlowProducer`) is tracked with its owned ioredis connection. A runtime node releases its pair on redeploy; config-node shutdown closes independent pairs concurrently, always attempting the BullMQ owner before its raw connection.

Connection and resource errors are reported on the consuming runtime node's status (`bull run`, `bull events`, `bull flow`). The config node owns the shared queue and its producer connection. Each `bull cmd` mirrors that shared producer connection on its visible status, while Queue errors report on the config node.

Secrets are read from Node-RED credentials first, with legacy plain fields accepted only for backward compatibility.

## Commands

`lib/commands.js` maps `msg.cmd` to explicit BullMQ calls. It does not expose arbitrary method names. Legacy repeat commands call Job Scheduler APIs.

## Schedulers

`lib/scheduler.js` translates `msg.jobopts.repeat.cron` to `repeat.pattern` and requires a deterministic scheduler id. Scheduler lookup/removal uses exact ids.

## Workers And Acknowledgement

`bull run` creates a BullMQ Worker.

- Immediate mode sends a Node-RED message and completes the job immediately.
- Manual mode creates an opaque `msg.bull.ackId` and waits for a downstream `bull job` node.

The in-process acknowledgement registry (`lib/acknowledgements.js`) stores live jobs and promise settlement functions. Each entry self-removes when it settles (complete, fail, timeout, or run-node close), so the registry does not accumulate finished jobs. Lock tokens are never sent in messages.

## Events And Flows

`bull events` wraps QueueEvents and emits event messages with `msg.topic`, `msg.payload`, and `msg.bull` metadata.

`bull flow` wraps FlowProducer and serializes the returned parent/child tree.
