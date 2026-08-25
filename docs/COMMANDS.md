# Command Reference

`bull cmd` reads `msg.cmd`. The `msg.command` field is a legacy alias; use `msg.cmd` in new flows. The node writes the command result to `msg.payload`.

## Jobs

- `add`
- `addBulk`
- `getJob`
- `getJobs`
- `getJobState`
- `removeJob`
- `retryJob`
- `retryJobs`

`add` uses `msg.jobName`, `msg.jobData` or `msg.payload`, and `msg.jobopts`.

`addBulk` rejects any entry whose `opts.repeat` is set; use `upsertJobScheduler`, or `add` with `msg.jobopts.repeat`, to schedule repeating jobs (see Job Schedulers below).

## Delayed Jobs

- `getDelayed`
- `changeDelay`
- `promoteJob`
- `promoteJobs`

Add a delayed job with `msg.jobopts.delay`.

## Priorities

- `getPrioritized`
- `getCountsPerPriority`
- `changePriority`

Add a prioritized job with `msg.jobopts.priority`.

## Deduplication

- `getDeduplicationJobId`
- `removeDeduplicationKey`

Add deduplication options through `msg.jobopts.deduplication`.

## Job Schedulers

Native:

- `upsertJobScheduler`
- `getJobScheduler`
- `getJobSchedulers`
- `getJobSchedulersCount`
- `removeJobScheduler`

Legacy aliases:

- `add` with `msg.jobopts.repeat`
- `count`
- `getRepeatableJobs`
- `getRepeatableJobByKey`
- `removeRepeatableByKey`

Legacy lookup/removal is exact-id based.

BullMQ v6 removed its own repeatable-job API (`Queue.getRepeatableJobs` and friends). The legacy alias commands above are this package's own mapping onto Job Schedulers, not a passthrough to BullMQ's methods, so they are unaffected and keep working.

## Queue Administration

- `getJobCounts`
- `pause`
- `resume`
- `isPaused`
- `isMaxed`
- `drain`
- `clean`
- `stopAndRemoveAllJobs`
- `getVersion`

`stopAndRemoveAllJobs` removes schedulers, drains waiting/delayed jobs, and cleans inactive states. It does not claim to safely remove active jobs.

`getJobCounts` no longer includes a `paused` key in its result: BullMQ v6 removed the `paused` job state, so a paused queue's jobs count as `waiting`. Use `isPaused` to check whether the queue itself is paused.

`isPaused` and `isMaxed` each return a boolean for the queue's current state. `getVersion` returns the BullMQ version recorded against this queue in Redis.

## Concurrency And Rate Limits

- `setGlobalConcurrency`
- `getGlobalConcurrency`
- `removeGlobalConcurrency`
- `setGlobalRateLimit`
- `getGlobalRateLimit`
- `removeGlobalRateLimit`
- `rateLimit`
- `getRateLimitTtl`
- `removeRateLimitKey`

`setGlobalRateLimit` requires `msg.max` and `msg.duration`; the documented `{ max, duration }` object in `msg.payload` is also accepted.

## Logs And Metrics

- `addJobLog`
- `getJobLogs`
- `exportPrometheusMetrics`
