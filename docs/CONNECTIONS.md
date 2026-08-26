# Connection Guide

## Standalone Redis

Use deployment `single`, host, port, optional database, optional username/password, and optional TLS.

Producer commands fail fast so a Node-RED input handler errors instead of hanging forever: the BullMQ owner sets `skipWaitingForReady: true` and the socket keeps `maxRetriesPerRequest: 1`, which rejects in about a second when Redis is down. Workers and QueueEvents use the persistent retry behavior BullMQ requires (`maxRetriesPerRequest: null`).

The offline queue stays enabled for producers too, which departs from BullMQ's production guide. Disabling it does fail faster, but it also rejects messages emitted during the brief connection window after a Node-RED deploy.

Every data connection reconnects with exponential backoff floored at 1s and capped at 20s, which is what [BullMQ's production guide](https://docs.bullmq.io/guide/going-to-production) recommends. Cluster discovery uses the same range through `clusterRetryStrategy`, and Sentinel discovery uses it through `sentinelRetryStrategy`.

## Production Redis Configuration

Redis must use `maxmemory-policy=noeviction`; evicting arbitrary BullMQ keys can corrupt queue behavior. Redis data must also be durable. For self-managed Redis, BullMQ recommends Append Only File (AOF) persistence, commonly with writes flushed once per second. For managed Redis, enable the provider's durable persistence and backup features appropriate to the job-loss tolerance of the deployment.

## Redis Cluster

Use deployment `cluster` and provide startup nodes as a comma- or newline-separated endpoint list.

Cluster auth and TLS are applied through ioredis `redisOptions`. The runtime always sets a DNS lookup passthrough for cluster discovery, including non-TLS deployments.

The BullMQ prefix must contain a Redis hash tag. Untagged Cluster prefixes are rejected to prevent `CROSSSLOT` failures.

`{bull}` is the default. Independent queues may use different tagged prefixes — `{orders}`, `{emails}` — to spread load across cluster nodes. Prefixes used in one `bullmq flow` tree or `FlowProducer.addBulk` batch must instead contain the same Redis hash tag because BullMQ updates those queues atomically and all involved keys must share a slot. Exact prefixes may differ, such as `{flow}:orders` and `{flow}:emails`; each worker must use the exact prefix assigned to its queue in the flow.

## AWS MemoryDB

Use deployment `cluster`.

Typical settings:

- cluster endpoint and port as a startup node;
- ACL username and password;
- TLS enabled;
- prefix `{bull}`;
- client located in a VPC/network path that can reach MemoryDB.

Do not write MemoryDB credentials into flows, examples, docs, or logs.

## Sentinel

Use deployment `sentinel` and configure:

- Sentinel endpoints;
- master name;
- optional Redis data-node username/password;
- optional Sentinel username/password;
- optional TLS for Redis data nodes;
- optional TLS for Sentinel discovery.

Sentinel authentication is separate from Redis data-node authentication.

## Cluster And Sentinel Endpoint Lists

Cluster startup nodes and Sentinel discovery lists accept host names, `host:port`, bare IPv6 with the default port, bracketed IPv6 such as `[2001:db8::1]:6379`, and `redis://` or `rediss://` URLs. Explicit URL schemes must agree with the applicable TLS setting: Cluster endpoints use `tls`, and Sentinel discovery endpoints use `sentinelTls`.

URL credentials are rejected. Store Redis and Sentinel usernames/passwords in the config node credential fields instead of embedding them in an endpoint.

## TLS

TLS behavior and options:

- rejects unauthorized certificates by default;
- optional CA;
- optional client certificate;
- optional client private key;
- optional server name.

Disable verification only when the Redis deployment cannot be configured with a trusted CA and the risk is understood.

## Secrets And Imported Flows

Passwords, CA data, client certificates, and private keys are read only from Node-RED credentials.

BullMQ stores job names, payloads, results, and failure details in Redis in clear text. Avoid sensitive job data; when it is unavoidable, encrypt sensitive fields before sending the job to `bullmq cmd` or `bullmq flow` and decrypt them only in a trusted worker path.
