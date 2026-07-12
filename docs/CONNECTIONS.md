# Connection Guide

## Standalone Redis

Use deployment `single`, host, port, optional database, optional username/password, and optional TLS.

Producer commands use bounded retries so Node-RED input handlers fail instead of hanging forever. Workers and QueueEvents use persistent retry behavior required by BullMQ.

## Redis Cluster

Use deployment `cluster` and provide startup nodes as comma or newline separated `host:port` values.

Cluster auth and TLS are applied through ioredis `redisOptions`. The runtime sets a DNS lookup passthrough for TLS-enabled cluster discovery.

The BullMQ prefix must contain a Redis hash tag, normally `{bull}`. Untagged Cluster prefixes are rejected to prevent `CROSSSLOT` failures.

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

## TLS

TLS options:

- verify unauthorized certificates by default;
- optional CA;
- optional client certificate;
- optional client private key;
- optional server name.

Disable verification only when the Redis deployment cannot be configured with a trusted CA and the risk is understood.
