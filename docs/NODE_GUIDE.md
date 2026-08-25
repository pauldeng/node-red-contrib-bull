# Node Guide

## `bull-queue-server`

Configures queue name, Redis deployment, credentials, TLS, and BullMQ prefix.

Deployment modes:

- `single`: standalone Redis.
- `cluster`: Redis Cluster and AWS MemoryDB.
- `sentinel`: Redis Sentinel.

Cluster and MemoryDB prefixes must contain a Redis hash tag; use `{bull}` unless you have a tested custom hash tag.

Optional OpenTelemetry fields `telemetry`, `telemetryServiceName`, and `telemetryMetrics` are off/blank by default; see [docs/TELEMETRY.md](TELEMETRY.md).

## `bull cmd`

Input node for producer and administration commands.

Input:

- `msg.cmd`: command name. Defaults to `add`.
- `msg.command`: legacy alias for `msg.cmd`; use `msg.cmd` in new flows.
- `msg.payload`: compatibility payload.
- `msg.jobData`: full BullMQ job data when supplied.
- `msg.jobName`: BullMQ job name. Defaults to `default`.
- `msg.jobopts`: BullMQ job options.

Output:

- successful result in `msg.payload`;
- errors go to `done(err)` or `node.error(err, msg)`.

BullMQ v6 removed the `paused` job state: `getJobState` never returns `"paused"` (a paused queue's jobs report `"waiting"`), and `getJobCounts` no longer has a `paused` key. Use `isPaused` to check the queue itself.

## `bull run`

Worker node with no input and one output.

Output message:

- `msg.payload`: `job.data.payload` when present, otherwise full `job.data`;
- `msg.job`: serialized job metadata;
- `msg.bull`: queue and job context.

Completion modes:

- `immediate`: complete after sending the message.
- `manual`: wait for downstream `bull job` acknowledgement. Fails the job after the ack timeout; set the timeout to `0` to wait indefinitely.

Concurrency must be a positive integer. The optional limiter maximum and duration must either both be blank or both be positive integers.

## `bull job`

Acts on manual-mode active jobs. Actions can be configured or supplied in `msg.cmd`.

Terminal actions:

- `complete`
- `fail`
- `failUnrecoverable`
- `rateLimit`

Non-terminal actions:

- `progress`
- `removeDeduplicationKey`
- `getChildrenValues`
- `getFailedChildrenValues`
- `removeUnprocessedChildren`

Cancellation actions (BullMQ v6 cooperative cancellation):

- `cancelJob`: cancels the active job identified by `msg.bull.ackId`. Reason comes from `msg.reason`, default `"BullMQ job cancelled"`. Outputs `true`. If BullMQ reports the job as no longer cancellable, the node raises an error naming the job id instead of sending a message.
- `cancelAllJobs`: cancels every active manual-mode job on the `bull run` node that owns `msg.bull.ackId`. Same `msg.reason` default. Always outputs `true`.

Both actions are acknowledgement-scoped: like every `bull job` action, they act on the job behind `msg.bull.ackId`, so they only work for manual-completion jobs that have not yet settled (completed, failed, or timed out). Cancelling aborts the worker's per-job signal, which fails the pending acknowledgement; BullMQ then applies the queue's normal attempts/backoff retry policy to the job. Cancellation does not itself complete or remove the job.

## `bull events`

QueueEvents source node. An empty event filter subscribes to: `active`, `added`, `cleaned`, `completed`, `deduplicated`, `delayed`, `drained`, `duplicated`, `failed`, `paused`, `progress`, `removed`, `resumed`, `retries-exhausted`, `stalled`, `waiting`, and `waiting-children`.

`retries-exhausted` is new in 2.0.0. A flow already deployed with an empty event filter now receives this extra event type without any config change.

Output:

- `msg.topic`: event name;
- `msg.payload`: BullMQ event payload;
- `msg.bull`: queue, event, and event id metadata.

## `bull flow`

Adds a BullMQ FlowProducer tree.

Input:

- `msg.payload`: BullMQ flow tree;
- `msg.flowopts`: optional FlowProducer options.

A child job in the tree that does not set `opts.jobId` gets a UUID as its job id (BullMQ v6 no longer assigns incremental numeric ids). Set `opts.jobId` on a child explicitly if the flow depends on a stable or predictable id.
