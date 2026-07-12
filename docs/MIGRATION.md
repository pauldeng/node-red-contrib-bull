# Migration From Bull v4

## What Stays Compatible

- Node types `bull-queue-server`, `bull cmd`, and `bull run`.
- Message-driven `msg.cmd` command dispatch.
- `msg.payload` compatibility for added jobs and worker output.
- `msg.jobopts.repeat.cron` for scheduled jobs.

## What Changes

- Runtime dependency is BullMQ 5.80.2.
- `bull` and `sprintf-js` are removed.
- Repeatable jobs use BullMQ Job Schedulers.
- Scheduled jobs require a stable scheduler id.
- `bull run` uses BullMQ Worker instead of Bull v4 `queue.process`.

## Repeat Jobs

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

## Data Migration

Bull v4 and BullMQ do not provide a supported Redis data migration contract. Do not assume existing delayed, waiting, active, completed, or repeatable Bull v4 keys will be usable by BullMQ.
