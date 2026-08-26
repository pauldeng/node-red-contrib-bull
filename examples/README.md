# Examples

Import these files from the Node-RED editor with **Import > Clipboard**.

## `example_flow.json`

End-to-end BullMQ v6 flow for the `basecasts` queue. It includes a native Job Scheduler pattern, plus basic events, manual acknowledgement, and flow examples.

## `bullmq_features.json`

Small BullMQ feature examples that all use one local Redis queue config named `bullmq-features`.

- Delay: `delay: send later` sets `msg.jobopts.delay = 10000`.
- Delay batch: `delay: series of one-off jobs` sends `addBulk` jobs with increasing delays.
- Date-time batch: `delay: series at exact date-times` converts explicit ISO-8601 timestamps to delays. Replace the sample 2030 timestamps before running it.
- Priority: `priority: high priority` sets `msg.jobopts.priority = 1`.
- Deduplication: `dedupe: same job once` sets `msg.jobopts.deduplication.id` from `msg.payload`.
- Rate limit: `rate limit: 2 per second` sends `msg.cmd = "setGlobalRateLimit"` with `{ "max": 2, "duration": 1000 }`.
- Scheduler: `scheduler: every minute` uses `upsertJobScheduler` with `msg.repeat.pattern`.
- Events: the `bullmq events` node emits completed, failed, delayed, deduplicated, duplicated, and progress events.
- Manual acknowledgement: `manual ack worker` sends a job through `bullmq job` progress and complete actions.
- Cancel: `cancel: stop running job` demonstrates BullMQ v6 cooperative cancellation on its own `bullmq-cancel` queue, with its own manual-mode worker. It is deliberately separate from the manual ack demo: a `cancelJob` node sharing that worker would cancel the very job the acknowledgement demo is completing.
- Metrics: `metrics: exportPrometheusMetrics` sends `msg.cmd = "exportPrometheusMetrics"` and returns a Prometheus-formatted string.
- Flow: `flow: parent plus child` sends a parent/child tree to `bullmq flow`.

Point `bullmq-features` at your Redis deployment before deploying the flow.

## `repeatable_jobs.json`

Native BullMQ v6 Job Scheduler commands for the `basecasts` queue.

- `scheduler: upsert basecasts job` sends `upsertJobScheduler` with `msg.schedulerId`, `msg.repeat.pattern`, `msg.repeat.tz`, and `msg.template`.
- `scheduler: upsert with timezone` demonstrates an IANA timezone in `msg.repeat.tz`.
- `scheduler: getJobSchedulers` lists Job Schedulers.
- `scheduler: getJobSchedulersCount` counts Job Schedulers.
- `scheduler: getJobScheduler` reads the exact scheduler id from `msg.payload` into `msg.schedulerId`.
- `scheduler: removeJobScheduler` removes that exact scheduler id.
- `scheduler: stopAndRemoveAllJobs` removes schedulers and cleans inactive jobs.

Use the add inject first, then inspect with get/count/get-by-key. Use remove-by-key for one scheduler or stopAndRemoveAllJobs for full cleanup.
