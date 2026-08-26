# Migration Guide

Package 2.0.0 is a breaking BullMQ v6 release. It does not register the old Bull node types or accept the old command, job-id, or repeatable-job aliases. Existing Bull v4 and BullMQ v5 queue data is not migrated.

## Before Upgrading

- Drain or otherwise account for Bull v4 jobs.
- While still running the previous BullMQ package version, remove its repeatable-job definitions.
- Export flows before changing node types and message shapes.

Bull and BullMQ do not provide a supported Redis data migration contract. Do not assume existing delayed, waiting, active, completed, or repeatable keys are usable after this upgrade.

## Flow Changes

Rename every node type:

| Old type            | BullMQ v6 type        |
| ------------------- | --------------------- |
| `bull-queue-server` | `bullmq-queue-server` |
| `bull cmd`          | `bullmq cmd`          |
| `bull run`          | `bullmq run`          |
| `bull job`          | `bullmq job`          |
| `bull events`       | `bullmq events`       |
| `bull flow`         | `bullmq flow`         |

Replace `msg.command` with `msg.cmd` and `msg.jobid` with `msg.jobId`; the removed fields now produce explicit errors. Removed repeatable aliases have these native replacements:

| Removed command          | BullMQ v6 command       |
| ------------------------ | ----------------------- |
| `getRepeatableJobs`      | `getJobSchedulers`      |
| `count`                  | `getJobSchedulersCount` |
| `getRepeatableJobByKey`  | `getJobScheduler`       |
| `removeRepeatableByKey`  | `removeJobScheduler`    |
| `add` with `opts.repeat` | `upsertJobScheduler`    |

Job Scheduler lookup and removal require the exact id in `msg.schedulerId`.

## Scheduler Shape

Replace the old repeat shape:

```js
msg.cmd = "add";
msg.jobopts = {
  jobId: "heartbeat",
  repeat: { cron: "*/1 * * * *", utc: true },
};
```

with BullMQ v6 inputs:

```js
msg.cmd = "upsertJobScheduler";
msg.schedulerId = "heartbeat";
msg.repeat = { pattern: "*/1 * * * *", tz: "UTC" };
msg.template = {
  name: "heartbeat",
  data: { payload: "scheduled heartbeat" },
};
```

Use `pattern`, not `cron`, and `tz`, not `utc`.

## Other BullMQ v6 Changes

- `job.getState()` no longer returns `paused`; jobs in a paused queue report `waiting`. Use `isPaused` for the queue state.
- `getJobCounts` no longer includes a `paused` key.
- Flow children without an explicit `opts.jobId` receive UUIDs rather than incremental numeric ids.
- The default event filter includes `retries-exhausted`.

After updating flows, run them against a non-production Redis deployment before upgrading production.
