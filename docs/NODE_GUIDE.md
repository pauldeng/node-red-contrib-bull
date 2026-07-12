# Node Guide

## `bull-queue-server`

Configures queue name, Redis deployment, credentials, TLS, and BullMQ prefix.

Deployment modes:

- `single`: standalone Redis.
- `cluster`: Redis Cluster and AWS MemoryDB.
- `sentinel`: Redis Sentinel.

Cluster and MemoryDB prefixes must contain a Redis hash tag; use `{bull}` unless you have a tested custom hash tag.

## `bull cmd`

Input node for producer and administration commands.

Input:

- `msg.cmd`: command name. Defaults to `add`.
- `msg.payload`: compatibility payload.
- `msg.jobData`: full BullMQ job data when supplied.
- `msg.jobName`: BullMQ job name. Defaults to `default`.
- `msg.jobopts`: BullMQ job options.

Output:

- successful result in `msg.payload`;
- errors go to `done(err)` or `node.error(err, msg)`.

## `bull run`

Worker node with no input and one output.

Output message:

- `msg.payload`: `job.data.payload` when present, otherwise full `job.data`;
- `msg.job`: serialized job metadata;
- `msg.bull`: queue and job context.

Completion modes:

- `immediate`: complete after sending the message.
- `manual`: wait for downstream `bull job` acknowledgement. Fails the job after the ack timeout; set the timeout to `0` to wait indefinitely.

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

## `bull events`

QueueEvents source node. Empty event filter subscribes to the default documented event list.

Output:

- `msg.topic`: event name;
- `msg.payload`: BullMQ event payload;
- `msg.bull`: queue, event, and event id metadata.

## `bull flow`

Adds a BullMQ FlowProducer tree.

Input:

- `msg.payload`: BullMQ flow tree;
- `msg.flowopts`: optional FlowProducer options.
