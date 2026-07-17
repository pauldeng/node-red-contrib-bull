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
