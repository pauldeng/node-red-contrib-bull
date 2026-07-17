const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildBullMQOptions,
  buildRedisDescriptor,
  normalizeQueueConfig,
  parseEndpointList,
} = require("../lib/connections");

test("normalizes legacy single Redis config", () => {
  const config = normalizeQueueConfig({
    name: "basecasts",
    address: "redis.example.test",
    port: "6380",
    password: "secret",
  });

  assert.equal(config.queueName, "basecasts");
  assert.equal(config.deployment, "single");
  assert.equal(config.host, "redis.example.test");
  assert.equal(config.port, 6380);
  assert.equal(config.password, "secret");
  assert.equal(config.tls, false);
});

test("builds role-specific standalone Redis descriptors", () => {
  const config = normalizeQueueConfig({
    name: "secure",
    address: "redis.example.test",
    port: "6380",
    username: "default",
    password: "secret",
    tls: true,
    tlsServerName: "redis.example.test",
  });

  const producer = buildRedisDescriptor(config, "producer");
  assert.equal(producer.kind, "single");
  assert.equal(producer.options.host, "redis.example.test");
  assert.equal(producer.options.port, 6380);
  assert.equal(producer.options.username, "default");
  assert.equal(producer.options.password, "secret");
  assert.equal(producer.options.maxRetriesPerRequest, 1);
  assert.deepEqual(producer.options.tls, {
    rejectUnauthorized: true,
    servername: "redis.example.test",
  });

  const worker = buildRedisDescriptor(config, "worker");
  assert.equal(worker.options.maxRetriesPerRequest, null);
});

test("builds Cluster and MemoryDB descriptors with a BullMQ hash-tag prefix", () => {
  const config = normalizeQueueConfig({
    name: "basecasts",
    deployment: "cluster",
    clusterNodes:
      "clustercfg.memdb.example.test:6379,redis-2.example.test:6380",
    username: "pdeng",
    password: "secret",
    tls: true,
  });

  const descriptor = buildRedisDescriptor(config, "producer");
  assert.equal(descriptor.kind, "cluster");
  assert.deepEqual(descriptor.startupNodes, [
    { host: "clustercfg.memdb.example.test", port: 6379 },
    { host: "redis-2.example.test", port: 6380 },
  ]);
  assert.equal(descriptor.options.redisOptions.username, "pdeng");
  assert.equal(descriptor.options.redisOptions.password, "secret");
  assert.deepEqual(descriptor.options.redisOptions.tls, {
    rejectUnauthorized: true,
  });
  assert.equal(typeof descriptor.options.dnsLookup, "function");

  const bullmqOptions = buildBullMQOptions(config, descriptor);
  assert.equal(bullmqOptions.prefix, "{bull}");
});

test("rejects a Cluster prefix without a Redis hash tag", () => {
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "clustered",
        deployment: "cluster",
        clusterNodes: "redis.example.test:6379",
        prefix: "bull",
      }),
    /Cluster BullMQ prefix must contain a Redis hash tag/,
  );

  assert.equal(
    normalizeQueueConfig({
      name: "clustered",
      deployment: "cluster",
      clusterNodes: "redis.example.test:6379",
      prefix: "queues:{bull}",
    }).prefix,
    "queues:{bull}",
  );
});

test("builds Sentinel descriptors with separate Sentinel auth and TLS", () => {
  const config = normalizeQueueConfig({
    name: "sentinel-queue",
    deployment: "sentinel",
    sentinels: "sentinel-1.example.test:26379\nsentinel-2.example.test:26379",
    sentinelMasterName: "mymaster",
    username: "data-user",
    password: "data-secret",
    sentinelUsername: "sentinel-user",
    sentinelPassword: "sentinel-secret",
    tls: true,
    tlsRejectUnauthorized: false,
    sentinelTls: true,
  });

  const descriptor = buildRedisDescriptor(config, "worker");
  assert.equal(descriptor.kind, "single");
  assert.deepEqual(descriptor.options.sentinels, [
    { host: "sentinel-1.example.test", port: 26379 },
    { host: "sentinel-2.example.test", port: 26379 },
  ]);
  assert.equal(descriptor.options.name, "mymaster");
  assert.equal(descriptor.options.username, "data-user");
  assert.equal(descriptor.options.password, "data-secret");
  assert.equal(descriptor.options.sentinelUsername, "sentinel-user");
  assert.equal(descriptor.options.sentinelPassword, "sentinel-secret");
  assert.equal(descriptor.options.enableTLSForSentinelMode, true);
  assert.deepEqual(descriptor.options.tls, {
    rejectUnauthorized: false,
  });
  assert.deepEqual(descriptor.options.sentinelTLS, {
    rejectUnauthorized: false,
  });
  assert.equal(descriptor.options.maxRetriesPerRequest, null);
});

test("parses endpoint lists from strings and arrays", () => {
  assert.deepEqual(parseEndpointList("host-a:6379, host-b:6380"), [
    { host: "host-a", port: 6379 },
    { host: "host-b", port: 6380 },
  ]);
  assert.deepEqual(
    parseEndpointList([{ host: "host-c", port: "6381" }, "host-d:6382"]),
    [
      { host: "host-c", port: 6381 },
      { host: "host-d", port: 6382 },
    ],
  );
});

test("parses hostnames, IPv6, and credential-free Redis URLs", () => {
  assert.deepEqual(
    parseEndpointList(
      "host-a,host-b:6380,::1,[2001:db8::2]:6381,redis://host-c:6382,rediss://[2001:db8::3]:6383",
    ),
    [
      { host: "host-a", port: 6379 },
      { host: "host-b", port: 6380 },
      { host: "::1", port: 6379 },
      { host: "2001:db8::2", port: 6381 },
      { host: "host-c", port: 6382 },
      { host: "2001:db8::3", port: 6383 },
    ],
  );
});

test("rejects credentials embedded in Redis endpoint URLs", () => {
  assert.throws(
    () => parseEndpointList("redis://user:secret@redis.example.test:6379"),
    /endpoint URLs cannot include credentials/i,
  );
});

test("rejects endpoint URL schemes that contradict topology TLS", () => {
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "clustered",
        deployment: "cluster",
        clusterNodes: "rediss://redis.example.test:6379",
        tls: false,
      }),
    /rediss:\/\/.*TLS.*enabled/i,
  );
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "clustered",
        deployment: "cluster",
        clusterNodes: "redis://redis.example.test:6379",
        tls: true,
      }),
    /redis:\/\/.*TLS.*disabled/i,
  );
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "sentinel",
        deployment: "sentinel",
        sentinelMasterName: "mymaster",
        sentinels: "rediss://sentinel.example.test:26379",
        sentinelTls: false,
      }),
    /rediss:\/\/.*Sentinel TLS.*enabled/i,
  );
});
