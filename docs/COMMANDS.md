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

## Queue Administration

- `getJobCounts`
- `pause`
- `resume`
- `drain`
- `clean`
- `stopAndRemoveAllJobs`

`stopAndRemoveAllJobs` removes schedulers, drains waiting/delayed jobs, and cleans inactive states. It does not claim to safely remove active jobs.

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
