# Troubleshooting

## Worker Does Not Receive Jobs

- Confirm `bull run` uses the same `bull-queue-server` as `bull cmd`.
- Confirm Redis is reachable from the Node-RED process.
- Confirm the queue name is correct.
- For scheduled jobs, BullMQ creates the next delayed job only as the previous scheduled job starts processing.

## Cluster `CROSSSLOT` Errors

Use a BullMQ prefix with a Redis Cluster hash tag, such as `{bull}`. This keeps BullMQ queue keys in the same slot for atomic operations.

## MemoryDB Connection Hangs

MemoryDB is a Cluster deployment and normally requires TLS from an EC2/VPC client that can reach the endpoint. Use Cluster mode, TLS, ACL username/password, and a reachable VPC network path.

## TLS Certificate Errors

Keep TLS verification enabled when possible. Provide the CA certificate or server name needed by the Redis deployment. Disable verification only for controlled deployments that cannot be configured with a trusted CA.

## Repeat Job Is Not Found

Legacy repeat lookup uses exact scheduler ids. Pass the id returned during creation in `msg.schedulerId`, `msg.jobid`, or `msg.jobId`. A job option id can help derive the scheduler id during creation, but it is not a separate lookup field.

## Bull v4 Queue Data Missing After Upgrade

Bull v4 Redis data is not automatically migrated. Drain or retire old queues before switching production flows to BullMQ.

## Repeat Job Fires At The Wrong Hour

BullMQ v6 removed `repeat.utc`; timezone is now `repeat.tz`. This package still accepts a legacy `repeat.utc: true` and translates it to `repeat.tz: "UTC"` automatically, so a job that only ever set `utc: true` keeps firing in UTC. A wrong-hour job usually means the flow (or an old scheduler definition) set both `utc` and a `tz` that disagree — that combination now throws instead of silently picking one, so check for the error at add time first. If the job needs a timezone other than UTC, set `repeat.tz` to that zone directly and drop `repeat.utc`.

## `cancelJob` Says No Cancellable Processor

`cancelJob`/`cancelAllJobs` need the acknowledgement behind `msg.bull.ackId`, which only exists for a manual-mode job that has not yet settled. Two different failures look similar:

- No usable `ackId` at all — an immediate-mode job's output message never carries one, and reusing an `ackId` after its job already completed, failed, timed out, or was already cancelled fails the same way. This raises a missing/stale/already-settled acknowledgement error, not "no cancellable processor".
- `BullMQ found no cancellable processor for job <id>` — the `ackId` was still valid, but BullMQ was no longer tracking a cancellation signal for that job. BullMQ stops tracking a job the moment its processor promise settles, so this is a narrow race: the job completed, failed, or lost its lock between the worker sending the message and the cancel arriving. It is also what you would see if `bull run`'s processor were ever changed to take fewer than three parameters, because BullMQ only creates the per-job `AbortController` when the processor declares the signal argument.
