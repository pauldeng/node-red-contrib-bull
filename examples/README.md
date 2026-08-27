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

## `postgres_backend.json`

The same add/run flow on the PostgreSQL backend, for the `pgcasts` queue. It exists to show what changes when the backend does: only the queue config node.

- The config node sets `backend` to `postgres` with `database`, `username`, `schema`, `max` and `migrate`, and leaves the Redis-only fields (`deployment`, `db`, `clusterNodes`, `sentinels`, `prefix`) empty so switching the selector back to Redis needs no cleanup.
- `add order job` and `handle order` use exactly the same `msg.cmd`, job options and worker message shape as the Redis examples. Nothing in a producer or worker flow is backend-specific.
- Install `pg` first (`npm install pg`). It is an optional peer dependency, so a missing install is reported on first use with the command to run.
- Set the password on the config node before deploying; a shipped flow carries no credential.

## `scheduled_notifications.json`

Scheduling a series of user notifications on the `notifycasts` queue, and delivering each one to a worker. Both halves share one queue and one worker.

- `notify: schedule user series` builds one delayed job per notification from a per-user schedule of explicit ISO-8601 instants, and enqueues the whole series with a single `addBulk`. BullMQ delays in milliseconds rather than at an absolute time, so each instant is converted to a delay at enqueue time; an instant already in the past becomes a delay of `0` and is delivered immediately. Send your own schedule as `msg.payload` in the same shape -- the built-in sample dates are placeholders.
- Each job gets a `jobId` derived from the user, the notification type and the scheduled instant, so re-sending the same schedule cannot double-book a notification. The instant is used as epoch milliseconds and the parts joined with `-`, because BullMQ rejects a custom job id containing `:`.
- `notify: cron daily digest` sends `upsertJobScheduler` with a six-field cron `msg.repeat.pattern` (the leading field is seconds) and `msg.repeat.tz`, carrying the notification in `msg.template.data` so every generated job arrives with it.
- `notify: remove cron digest` sends `removeJobScheduler`. A Job Scheduler outlives a redeploy, so an example that creates one needs a way to remove it.
- `notification worker` is an immediate-mode `bullmq run` node; `deliver notification` reads the notification out of `msg.payload.message` and sets `msg.topic` to `userId/type`.

A delayed job's time is when it becomes _eligible_, not a guaranteed start: worker availability and concurrency still decide when it actually runs.

Point `notifycasts` at your Redis or PostgreSQL deployment before deploying the flow.

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
