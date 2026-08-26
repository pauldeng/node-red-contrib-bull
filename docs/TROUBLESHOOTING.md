# Troubleshooting

## Worker Does Not Receive Jobs

- Confirm `bullmq run` uses the same `bullmq-queue-server` as `bullmq cmd`.
- Confirm Redis is reachable from the Node-RED process.
- Confirm the queue name is correct.
- For scheduled jobs, BullMQ creates the next delayed job only as the previous scheduled job starts processing.

## Cluster `CROSSSLOT` Errors

Use a BullMQ prefix with a Redis Cluster hash tag, such as `{bull}`. This keeps BullMQ queue keys in the same slot for atomic operations.

## MemoryDB Connection Hangs

MemoryDB is a Cluster deployment and normally requires TLS from an EC2/VPC client that can reach the endpoint. Use Cluster mode, TLS, ACL username/password, and a reachable VPC network path.

## TLS Certificate Errors

Keep TLS verification enabled when possible. Provide the CA certificate or server name needed by the Redis deployment. Disable verification only for controlled deployments that cannot be configured with a trusted CA.

## Job Scheduler Is Not Found

Job Scheduler lookup uses exact ids. Pass the id used during creation in `msg.schedulerId`.

## Bull v4 Queue Data Missing After Upgrade

Bull v4 Redis data is not automatically migrated. Drain or retire old queues before switching production flows to BullMQ.

## Repeat Job Fires At The Wrong Hour

BullMQ v6 uses `msg.repeat.pattern` and optional `msg.repeat.tz` with `upsertJobScheduler`. Confirm the IANA timezone name and remove/recreate any scheduler created with the wrong timezone.

## `cancelJob` Says No Cancellable Processor

`cancelJob`/`cancelAllJobs` need the acknowledgement behind `msg.bull.ackId`, which only exists for a manual-mode job that has not yet settled. Two different failures look similar:

- No usable `ackId` at all — an immediate-mode job's output message never carries one, and reusing an `ackId` after its job already completed, failed, timed out, or was already cancelled fails the same way. This raises a missing/stale/already-settled acknowledgement error, not "no cancellable processor".
- `BullMQ found no cancellable processor for job <id>` — the `ackId` was still valid, but BullMQ was no longer tracking a cancellation signal for that job. BullMQ stops tracking a job the moment its processor promise settles, so this is a narrow race: the job completed, failed, or lost its lock between the worker sending the message and the cancel arriving. It is also what you would see if `bullmq run`'s processor were ever changed to take fewer than three parameters, because BullMQ only creates the per-job `AbortController` when the processor declares the signal argument.
