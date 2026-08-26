# Node Guide

## `bullmq-queue-server`

Configures queue name, Redis deployment, credentials, TLS, and BullMQ prefix.

Deployment modes:

- `single`: standalone Redis.
- `cluster`: Redis Cluster and AWS MemoryDB.
- `sentinel`: Redis Sentinel.

Cluster and MemoryDB prefixes must contain a Redis hash tag. `{bull}` is the default. Independent queues may use different tags — `{orders}`, `{emails}` — to spread load across cluster nodes. Prefixes in one `bullmq flow` tree or bulk flow batch must contain the same hash tag so their atomic Redis operations stay in one slot. Each worker must use the exact prefix assigned to its queue in the flow.

`removeOnComplete` and `removeOnFail` set queue-level auto-removal as BullMQ `defaultJobOptions`, keeping that many of the newest jobs in each state. New config nodes default to keeping 1000 completed and 5000 failed jobs. A blank field keeps every job, which is BullMQ's own default and grows Redis without bound.

For `bullmq cmd`, `msg.jobopts` overrides these defaults. For `bullmq flow`, the defaults apply to every queue named in the flow tree; `msg.flowopts.queuesOptions[queueName].defaultJobOptions` overrides the config for one queue, and the job's own `opts` has final precedence.

Optional OpenTelemetry fields `telemetry`, `telemetryServiceName`, and `telemetryMetrics` are off/blank by default; see [docs/TELEMETRY.md](TELEMETRY.md).

## `bullmq cmd`

Input node for producer and administration commands.

Input:

- `msg.cmd`: command name. Defaults to `add`.
- `msg.payload`: job data for `add` when `msg.jobData` is not supplied, or command input where documented.
- `msg.jobData`: full BullMQ job data when supplied.
- `msg.jobName`: BullMQ job name. Defaults to `default`.
- `msg.jobopts`: BullMQ job options.

`add` and `addBulk` reject repeat options. Use the native Job Scheduler commands and fields documented in [docs/COMMANDS.md](COMMANDS.md).

Output:

- successful result in `msg.payload`;
- errors go to `done(err)` or `node.error(err, msg)`.

BullMQ v6 removed the `paused` job state: `getJobState` never returns `"paused"` (a paused queue's jobs report `"waiting"`), and `getJobCounts` no longer has a `paused` key. Use `isPaused` to check the queue itself.

## `bullmq run`

Worker node with no input and one output.

Output message:

- `msg.payload`: `job.data.payload` when present, otherwise full `job.data`;
- `msg.job`: serialized job metadata;
- `msg.bull`: queue and job context.

Completion modes:

- `immediate`: complete after sending the message.
- `manual`: wait for downstream `bullmq job` acknowledgement. Fails the job after the ack timeout; set the timeout to `0` to wait indefinitely.

Concurrency and Max Started Attempts must be positive integers. Max Started Attempts defaults to 100 and bounds reprocessing loops from transitions that do not increment `attemptsMade`, including `moveToWait` and `moveToDelayed`. BullMQ fails the job unrecoverably before its processor runs for the 101st time. The optional limiter maximum and duration must either both be blank or both be positive integers.

## `bullmq job`

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
- `updateData`: replaces the job's stored data with `msg.jobData`, falling back to `msg.payload`. The new data survives a retry, so it is how a flow records which step a job reached.

Step and retry transitions. Each hands the job's lock token back to BullMQ, so the job leaves the active state without counting a failed attempt, and the flow's acknowledgement is settled for it:

- `moveToWait`: requeues the job to be picked up again. This is BullMQ's manual-retry pattern.
- `moveToDelayed`: delays the job by `msg.delay` milliseconds and resumes it later. Requires `msg.delay`.

Together with `updateData` these implement BullMQ's process-step-jobs pattern: record the step, then requeue or delay the job, and resume at that step on its next activation. The lock token these need never appears in a Node-RED message.

Cancellation actions (BullMQ v6 cooperative cancellation):

- `cancelJob`: cancels the active job identified by `msg.bull.ackId`. Reason comes from `msg.reason`, default `"BullMQ job cancelled"`. Outputs `true`. If BullMQ reports the job as no longer cancellable, the node raises an error naming the job id instead of sending a message.
- `cancelAllJobs`: cancels every active manual-mode job on the `bullmq run` node that owns `msg.bull.ackId`. Same `msg.reason` default. Always outputs `true`.

Both actions are acknowledgement-scoped: like every `bullmq job` action, they act on the job behind `msg.bull.ackId`, so they only work for manual-completion jobs that have not yet settled (completed, failed, or timed out). Cancelling aborts the worker's per-job signal, which fails the pending acknowledgement; BullMQ then applies the queue's normal attempts/backoff retry policy to the job. Cancellation does not itself complete or remove the job.

## `bullmq events`

QueueEvents source node. An empty event filter subscribes to: `active`, `added`, `cleaned`, `completed`, `deduplicated`, `delayed`, `drained`, `duplicated`, `failed`, `paused`, `progress`, `removed`, `resumed`, `retries-exhausted`, `stalled`, `waiting`, and `waiting-children`.

`retries-exhausted` is new in 2.0.0. A flow already deployed with an empty event filter now receives this extra event type without any config change.

Output:

- `msg.topic`: event name;
- `msg.payload`: BullMQ event payload;
- `msg.bull`: queue, event, and event id metadata.

## `bullmq flow`

Adds a BullMQ FlowProducer tree.

Input:

- `msg.payload`: a BullMQ flow tree, or an array of flow trees;
- `msg.flowopts`: optional FlowProducer options, for a single tree.

An array uses `FlowProducer.addBulk`, which atomically creates multiple independent root trees: every tree is added or none is. Use one flow tree when jobs are related by parent/child dependencies, even when that tree spans queues. `msg.flowopts` does not apply to an array, because `addBulk` takes no options argument; queue-level auto-removal is stamped onto each job's own `opts` instead, where anything the tree already sets wins. On Redis Cluster, omit each flow job's `prefix` to use the flow node's prefix throughout. If prefixes are set per job, they must contain the same hash tag, and each worker must use its queue's exact prefix. An empty array is an error.

A child job in the tree that does not set `opts.jobId` gets a UUID as its job id (BullMQ v6 no longer assigns incremental numeric ids). Set `opts.jobId` on a child explicitly if the flow depends on a stable or predictable id.
