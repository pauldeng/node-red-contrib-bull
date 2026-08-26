# Command Reference

`bullmq cmd` reads `msg.cmd` and writes the command result to `msg.payload`.

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

`add` and `addBulk` reject repeat options. Use `upsertJobScheduler` for repeating jobs.

## Delayed Jobs

- `getDelayed`
- `changeDelay`
- `promoteJob`
- `promoteJobs`

Add a delayed job with `msg.jobopts.delay`.

One one-off job, delayed by 10 seconds:

```js
msg.cmd = "add";
msg.jobName = "delayed";
msg.jobData = { payload: "first" };
msg.jobopts = { delay: 10000, removeOnComplete: true };
return msg;
```

A series of one-off jobs, each delayed from the time the batch is added:

```js
msg.cmd = "addBulk";
msg.payload = [
  {
    name: "delayed-1",
    data: { payload: "first" },
    opts: { delay: 10000, removeOnComplete: true },
  },
  {
    name: "delayed-2",
    data: { payload: "second" },
    opts: { delay: 20000, removeOnComplete: true },
  },
  {
    name: "delayed-3",
    data: { payload: "third" },
    opts: { delay: 30000, removeOnComplete: true },
  },
];
return msg;
```

These are ordinary jobs, not schedulers. Increasing delays make them eligible in sequence; worker availability and concurrency determine their actual start times.

For a series with exact date-times, convert each ISO-8601 timestamp to a delay when enqueueing:

```js
const schedule = [
  { at: "2030-01-01T09:00:00+11:00", payload: "first" },
  { at: "2030-01-01T09:15:00+11:00", payload: "second" },
  { at: "2030-01-01T09:30:00+11:00", payload: "third" },
];
const now = Date.now();

msg.cmd = "addBulk";
msg.payload = schedule.map(({ at, payload }, index) => ({
  name: `scheduled-${index + 1}`,
  data: { payload, scheduledFor: at },
  opts: {
    delay: Math.max(0, Date.parse(at) - now),
    removeOnComplete: true,
  },
}));
return msg;
```

Use timestamps with an explicit `Z` or numeric UTC offset. A past timestamp becomes immediately eligible. Delayed jobs are eligible at the requested time, but worker availability still determines when processing starts.

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

- `upsertJobScheduler`
- `getJobScheduler`
- `getJobSchedulers`
- `getJobSchedulersCount`
- `removeJobScheduler`

`upsertJobScheduler` uses `msg.schedulerId`, `msg.repeat`, and `msg.template`. Use `msg.repeat.pattern` for cron expressions and `msg.repeat.tz` for a timezone. Lookup and removal are exact-id based through `msg.schedulerId`.

Removed repeatable-job command names fail with an error naming their BullMQ v6 replacement; see [MIGRATION.md](MIGRATION.md).

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
