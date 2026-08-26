# Connection Guide

## Standalone Redis

Use deployment `single`, host, port, optional database, optional username/password, and optional TLS.

Producer commands use bounded retries so Node-RED input handlers fail instead of hanging forever. Workers and QueueEvents use persistent retry behavior required by BullMQ.

## Redis Cluster

Use deployment `cluster` and provide startup nodes as a comma- or newline-separated endpoint list.

Cluster auth and TLS are applied through ioredis `redisOptions`. The runtime always sets a DNS lookup passthrough for cluster discovery, including non-TLS deployments.

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
