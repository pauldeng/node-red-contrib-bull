# Migration Guide

## From Bull v4

### What Stays Compatible

- Node types `bull-queue-server`, `bull cmd`, and `bull run`.
- Message-driven `msg.cmd` command dispatch.
- `msg.payload` compatibility for added jobs and worker output.
- `msg.jobopts.repeat.cron` for scheduled jobs.

### What Changes

- Runtime dependency is BullMQ 6.2.1.
- `bull` and `sprintf-js` are removed.
- Repeatable jobs use BullMQ Job Schedulers.
- Scheduled jobs require a stable scheduler id.
- `bull run` uses BullMQ Worker instead of Bull v4 `queue.process`.

### Repeat Jobs

Legacy:

```js
msg.jobopts = {
  jobId: msg.payload,
  repeat: { cron: "30 9,19,29,39,49,59 * * * *" },
};
```

Runtime translation:

- scheduler id: `msg.schedulerId` or `msg.jobopts.jobId`;
- repeat pattern: `msg.jobopts.repeat.pattern`;
- template data: `msg.jobData` or `{ payload: msg.payload }`.

### Data Migration

Bull v4 and BullMQ do not provide a supported Redis data migration contract. Do not assume existing delayed, waiting, active, completed, or repeatable Bull v4 keys will be usable by BullMQ.

## From BullMQ v5 To v6 (Package 2.0.0)

BullMQ 6.2.1 (this package's 2.0.0) removes and changes behavior this package previously depended on. Each item below is a real behavior change, not just a version bump.

### Legacy Repeatable-Job API Removed From BullMQ Itself

BullMQ v6 deletes `Queue.getRepeatableJobs`, `Queue.removeRepeatableByKey`, and the rest of its own legacy repeatable-job methods. This package's `msg.cmd` names `getRepeatableJobs`, `getRepeatableJobByKey`, `removeRepeatableByKey`, and `count` are this package's own aliases onto Job Schedulers (`lib/commands.js`), not passthroughs to BullMQ's methods, so **they keep working unchanged**. Nothing to do here — but if you know BullMQ v6 removed these, do not assume this package removed them too.

### `paused` Job State Removed

`job.getState()` never returns `"paused"` any more; a job sitting in a paused queue now reports `"waiting"`. `queue.getJobCounts()` no longer includes a `paused` key in its result (`getJobState`/`getJobCounts` in `docs/COMMANDS.md`). If a flow branches on `getJobState` returning `"paused"`, or reads `msg.payload.paused` from `getJobCounts`, change it to check `isPaused` (new in this release; see `docs/COMMANDS.md`) instead.

### `bull flow` Child Jobs Get UUID Ids By Default

A `bull flow` child job that does not set an explicit `opts.jobId` now gets a UUID instead of an incremental numeric id. If downstream code assumed sequential numeric child ids, set `opts.jobId` explicitly on each child in `msg.payload`.

### `repeat.utc` Is Gone; Use `repeat.tz`

BullMQ v6 dropped `repeat.utc` in favor of `repeat.tz`. This package still accepts a legacy `repeat.utc: true` and translates it to `repeat.tz: "UTC"`; combining a truthy `utc` with a `tz` other than `"UTC"` throws instead of picking one silently. A falsy `repeat.utc` is simply dropped, since it never meant anything but "use local time". New flows should set `repeat.tz` directly and drop `repeat.utc`.

### v5 Repeatable-Job Data Is Not Migrated

BullMQ v5's repeatable-job Redis data is **not** migrated by upgrading this package. Before upgrading, remove every v5 repeatable-job definition (drain them with the `stopAndRemoveAllJobs` command, or remove each one individually) while still running the BullMQ v5 version, then recreate the schedules after upgrading. This package does not inventory or convert old repeatable-job keys for you.
