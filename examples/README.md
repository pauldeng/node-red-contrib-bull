# Examples

Import these files from the Node-RED editor with **Import > Clipboard**.

## `example_flow.json`

End-to-end compatibility flow for the `basecasts` queue. It includes the required scheduled job payload and cron expression, plus basic events, manual acknowledgement, and flow examples.

## `bullmq_features.json`

Small BullMQ feature examples that all use one local Redis queue config named `bullmq-features`.

- Delay: `delay: send later` sets `msg.jobopts.delay = 10000`.
- Priority: `priority: high priority` sets `msg.jobopts.priority = 1`.
- Deduplication: `dedupe: same job once` sets `msg.jobopts.deduplication.id` from `msg.payload`.
- Rate limit: `rate limit: 2 per second` sends `msg.cmd = "setGlobalRateLimit"` with `{ "max": 2, "duration": 1000 }`.
- Scheduler: `scheduler: every minute` adds a repeatable scheduler with `repeat.pattern`.
- Events: the `bull events` node emits completed, failed, delayed, deduplicated, duplicated, and progress events.
- Manual acknowledgement: `manual ack worker` sends a job through `bull job` progress and complete actions.
- Cancel: `cancel: stop running job` demonstrates BullMQ v6 cooperative cancellation on its own `bullmq-cancel` queue, with its own manual-mode worker. It is deliberately separate from the manual ack demo: a `cancelJob` node sharing that worker would cancel the very job the acknowledgement demo is completing.
- Metrics: `metrics: exportPrometheusMetrics` sends `msg.cmd = "exportPrometheusMetrics"` and returns a Prometheus-formatted string.
- Flow: `flow: parent plus child` sends a parent/child tree to `bull flow`.

Point `bullmq-features` at your Redis deployment before deploying the flow.

## `repeatable_jobs.json`

Commands for the `basecasts` queue's BullMQ Job Scheduler, using this package's legacy repeatable-job command names (`getRepeatableJobs`, `getRepeatableJobByKey`, `removeRepeatableByKey`, `count`) as aliases onto the Job Scheduler API.

- `repeat: add basecasts job` sends `msg.cmd = "add"` with `msg.jobopts.repeat.cron`.
- `repeat: add job with repeat.utc` sends the same shape plus a legacy `repeat.utc: true`, which this package translates into `repeat.tz: "UTC"`.
- `repeat: getRepeatableJobs` lists Job Schedulers.
- `repeat: count` counts Job Schedulers.
- `repeat: getRepeatableJobByKey` reads the scheduler id from `msg.payload` into `msg.jobid`.
- `repeat: removeRepeatableByKey` removes the scheduler id from `msg.payload`.
- `repeat: stopAndRemoveAllJobs` sends `msg.cmd = "stopAndRemoveAllJobs"` to remove schedulers and clean inactive jobs.

Use the add inject first, then inspect with get/count/get-by-key. Use remove-by-key for one scheduler or stopAndRemoveAllJobs for full cleanup.
