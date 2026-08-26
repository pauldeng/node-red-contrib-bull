const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const {
  buildBullMQOptions,
  buildRedisDescriptor,
  createRedisConnection,
  normalizeQueueConfig,
  normalizePostgresConfig,
  parseEndpointList,
} = require("../lib/connections");

test("normalizes standalone Redis config and credential-backed secrets", () => {
  const config = normalizeQueueConfig(
    {
      name: "basecasts",
      address: "redis.example.test",
      port: "6380",
    },
    { password: "secret" },
  );

  assert.equal(config.queueName, "basecasts");
  assert.equal(config.deployment, "single");
  assert.equal(config.host, "redis.example.test");
  assert.equal(config.port, 6380);
  assert.equal(config.password, "secret");
  assert.equal(config.tls, false);
});

test("builds role-specific standalone Redis descriptors", () => {
  const config = normalizeQueueConfig(
    {
      name: "secure",
      address: "redis.example.test",
      port: "6380",
      username: "default",
      tls: true,
      tlsServerName: "redis.example.test",
    },
    { password: "secret" },
  );

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
  const config = normalizeQueueConfig(
    {
      name: "basecasts",
      deployment: "cluster",
      clusterNodes:
        "clustercfg.memdb.example.test:6379,redis-2.example.test:6380",
      username: "pdeng",
      tls: true,
    },
    { password: "secret" },
  );

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
  const config = normalizeQueueConfig(
    {
      name: "sentinel-queue",
      deployment: "sentinel",
      sentinels: "sentinel-1.example.test:26379\nsentinel-2.example.test:26379",
      sentinelMasterName: "mymaster",
      username: "data-user",
      sentinelUsername: "sentinel-user",
      tls: true,
      tlsRejectUnauthorized: false,
      sentinelTls: true,
    },
    { password: "data-secret", sentinelPassword: "sentinel-secret" },
  );

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

test("rejects removed config aliases and plaintext secrets", () => {
  assert.throws(
    () => normalizeQueueConfig({ name: "queue", deployment: "memorydb" }),
    /Unsupported Redis deployment mode/,
  );
  assert.throws(
    () => normalizeQueueConfig({ name: "queue", password: "plaintext" }),
    /must be stored in Node-RED credentials/,
  );
  assert.throws(
    () => normalizeQueueConfig({ name: "queue", mode: "cluster" }),
    /Unsupported config field: mode/,
  );
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

test("normalizes telemetry config with a blank service name", () => {
  const config = normalizeQueueConfig({
    name: "basecasts",
  });

  assert.equal(config.telemetry, false);
  assert.equal(config.telemetryServiceName, undefined);
  assert.equal(config.telemetryMetrics, false);
});

test("normalizes telemetry config when enabled", () => {
  const config = normalizeQueueConfig({
    name: "basecasts",
    telemetry: true,
    telemetryServiceName: "my-service",
    telemetryMetrics: true,
  });

  assert.equal(config.telemetry, true);
  assert.equal(config.telemetryServiceName, "my-service");
  assert.equal(config.telemetryMetrics, true);
});

test("buildBullMQOptions omits the telemetry key entirely when no telemetry instance is passed", () => {
  const config = normalizeQueueConfig({ name: "basecasts" });
  const options = buildBullMQOptions(config, { fake: "connection" });

  assert.equal(Object.hasOwn(options, "telemetry"), false);
});

test("buildBullMQOptions sets telemetry only when an instance is passed", () => {
  const config = normalizeQueueConfig({ name: "basecasts" });
  const telemetry = { fake: "telemetry" };
  const options = buildBullMQOptions(config, { fake: "connection" }, telemetry);

  assert.equal(Object.hasOwn(options, "telemetry"), true);
  assert.equal(options.telemetry, telemetry);
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

test("producer connections fail fast instead of queueing commands while Redis is unreachable", () => {
  const config = normalizeQueueConfig({ name: "prod" }, {});

  // A producer must reject promptly: a bullmq cmd node awaits the command, so a
  // queued-forever command means done() never fires and the message is lost.
  const producerOptions = buildBullMQOptions(config, {}, undefined, "producer");
  assert.equal(producerOptions.skipWaitingForReady, true);

  // But NOT by disabling the offline queue, even though BullMQ's guide
  // suggests it for producers: measured against a healthy Redis that rejects
  // any command issued during the connect window, which is every deploy-time
  // message in Node-RED. maxRetriesPerRequest is what bounds a dead Redis.
  for (const role of ["producer", "worker", "events"]) {
    const descriptor = buildRedisDescriptor(config, role);
    assert.notEqual(descriptor.options.enableOfflineQueue, false, role);
  }
  assert.equal(
    buildRedisDescriptor(config, "producer").options.maxRetriesPerRequest,
    1,
  );

  // Consumers must keep waiting for the connection to come back instead.
  for (const role of ["worker", "events"]) {
    const options = buildBullMQOptions(config, {}, undefined, role);
    assert.equal(Object.hasOwn(options, "skipWaitingForReady"), false);
  }
});

test("reconnect backoff uses the BullMQ production range for every role", () => {
  const config = normalizeQueueConfig({ name: "prod" }, {});

  for (const role of ["producer", "worker", "events"]) {
    const { options } = buildRedisDescriptor(config, role);
    assert.equal(typeof options.retryStrategy, "function", role);
    assert.equal(options.retryStrategy(1), 1000, role);
    assert.equal(options.retryStrategy(2), 2000, role);
    assert.equal(options.retryStrategy(50), 20000, role);
  }

  const cluster = buildRedisDescriptor(
    normalizeQueueConfig(
      { name: "prod", deployment: "cluster", clusterNodes: "node-a:6379" },
      {},
    ),
    "producer",
  );
  assert.equal(typeof cluster.options.redisOptions.retryStrategy, "function");
  assert.equal(typeof cluster.options.clusterRetryStrategy, "function");
  assert.equal(cluster.options.clusterRetryStrategy(1), 1000);
  assert.equal(cluster.options.clusterRetryStrategy(50), 20000);

  const sentinel = buildRedisDescriptor(
    normalizeQueueConfig({
      name: "prod",
      deployment: "sentinel",
      sentinels: "sentinel-a:26379",
      sentinelMasterName: "mymaster",
    }),
    "producer",
  );
  assert.equal(typeof sentinel.options.sentinelRetryStrategy, "function");
  assert.equal(sentinel.options.sentinelRetryStrategy(1), 1000);
  assert.equal(sentinel.options.sentinelRetryStrategy(50), 20000);
});

test(
  "a real producer command rejects promptly when Redis is unavailable",
  { timeout: 3000 },
  async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const port = server.address().port;
    const config = normalizeQueueConfig({
      name: "unavailable",
      address: "127.0.0.1",
      port,
    });
    const connection = createRedisConnection(
      buildRedisDescriptor(config, "producer"),
      IORedis,
    );
    connection.on("error", () => {});
    const queue = new Queue(
      config.queueName,
      buildBullMQOptions(config, connection, undefined, "producer"),
    );
    queue.on("error", () => {});

    try {
      await assert.rejects(
        queue.add("probe", {}),
        /Reached the max retries per request limit/,
      );
    } finally {
      connection.disconnect(false);
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("queue-level auto-removal normalizes into BullMQ defaultJobOptions", () => {
  const bounded = normalizeQueueConfig(
    { name: "q", removeOnComplete: "100", removeOnFail: "500" },
    {},
  );
  assert.deepEqual(bounded.defaultJobOptions, {
    removeOnComplete: 100,
    removeOnFail: 500,
  });

  // Blank means "keep every job", which is BullMQ's own default and unbounded.
  const unbounded = normalizeQueueConfig(
    { name: "q", removeOnComplete: "", removeOnFail: "" },
    {},
  );
  assert.equal(unbounded.defaultJobOptions, undefined);

  assert.throws(
    () => normalizeQueueConfig({ name: "q", removeOnComplete: "-1" }, {}),
    /removeOnComplete/,
  );
  assert.throws(
    () => normalizeQueueConfig({ name: "q", removeOnFail: "not-a-number" }, {}),
    /removeOnFail/,
  );
});

// ---------------------------------------------------------------------------
// backend seam
// ---------------------------------------------------------------------------

test("absent or blank backend means redis, and the redis config shape is unchanged", () => {
  const absent = normalizeQueueConfig({ name: "basecasts" });
  assert.equal(Object.hasOwn(absent, "backend"), false);
  assert.equal(absent.host, "localhost");

  const blank = normalizeQueueConfig({ name: "basecasts", backend: "" });
  assert.equal(Object.hasOwn(blank, "backend"), false);
});

test("rejects an unsupported backend value", () => {
  assert.throws(
    () => normalizeQueueConfig({ name: "q", backend: "mongodb" }),
    /Unsupported backend: mongodb/,
  );
});

test("postgres backend ignores Redis-only fields instead of throwing", () => {
  // A flow switched from Redis to postgres keeps its hidden Redis rows in the
  // saved JSON -- deployment, clusterNodes, sentinelMasterName, and prefix
  // must not be validated or cause an error.
  const config = normalizeQueueConfig({
    name: "switched",
    backend: "postgres",
    deployment: "cluster",
    clusterNodes: "not-even-a-valid-host-list::::",
    sentinelMasterName: "",
    prefix: "myprefix",
    address: "pg.example.test",
    database: "jobs",
  });

  assert.equal(config.backend, "postgres");
  assert.equal(config.postgres.host, "pg.example.test");
  assert.equal(config.postgres.database, "jobs");
  assert.equal(Object.hasOwn(config, "prefix"), false);
  assert.equal(Object.hasOwn(config, "deployment"), false);
});

test("postgres backend still rejects removed aliases and plaintext secrets", () => {
  assert.throws(
    () =>
      normalizeQueueConfig({ name: "q", backend: "postgres", mode: "cluster" }),
    /Unsupported config field: mode/,
  );
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "q",
        backend: "postgres",
        password: "plaintext",
      }),
    /must be stored in Node-RED credentials/,
  );
});

test("normalizePostgresConfig: every field default", () => {
  const config = normalizePostgresConfig({ name: "q" }, {});

  assert.equal(config.backend, "postgres");
  assert.equal(config.queueName, "q");
  assert.deepEqual(config.postgres, {
    host: "localhost",
    port: 5432,
    database: undefined,
    user: undefined,
    password: undefined,
    schema: undefined,
    max: 2,
    connectionTimeoutMillis: 10000,
    migrate: true,
  });
  assert.equal(Object.hasOwn(config.postgres, "ssl"), false);
});

test("normalizePostgresConfig: every field set, including credentials", () => {
  const config = normalizePostgresConfig(
    {
      name: "orders",
      address: "pg.example.test",
      port: "5433",
      database: "orders",
      username: "app",
      schema: "myschema",
      max: "5",
      migrate: false,
    },
    { password: "pg-secret" },
  );

  assert.deepEqual(config.postgres, {
    host: "pg.example.test",
    port: 5433,
    database: "orders",
    user: "app",
    password: "pg-secret",
    schema: "myschema",
    max: 5,
    connectionTimeoutMillis: 10000,
    migrate: false,
  });
});

test("normalizePostgresConfig: pool max rejects 0 but blank means the default", () => {
  assert.throws(
    () => normalizePostgresConfig({ name: "q", max: "0" }, {}),
    /pool max must be a positive whole number/i,
  );
  assert.throws(
    () => normalizePostgresConfig({ name: "q", max: "-1" }, {}),
    /pool max must be a positive whole number/i,
  );
  assert.equal(
    normalizePostgresConfig({ name: "q", max: "" }, {}).postgres.max,
    2,
  );
});

test("normalizePostgresConfig: invalid port is reported as PostgreSQL, not Redis", () => {
  assert.throws(
    () => normalizePostgresConfig({ name: "q", port: "70000" }, {}),
    /Invalid PostgreSQL port/,
  );
});

test("normalizePostgresConfig: requires a queue name", () => {
  assert.throws(
    () => normalizePostgresConfig({}, {}),
    /BullMQ queue name is required/,
  );
});

test("normalizePostgresConfig: ssl is built from the shared TLS fields when tls is on, absent when off", () => {
  const withTls = normalizePostgresConfig(
    {
      name: "q",
      tls: true,
      tlsRejectUnauthorized: false,
      tlsServerName: "pg.example.test",
    },
    { tlsCa: "ca-pem", tlsCert: "cert-pem", tlsKey: "key-pem" },
  );
  assert.deepEqual(withTls.postgres.ssl, {
    rejectUnauthorized: false,
    servername: "pg.example.test",
    ca: "ca-pem",
    cert: "cert-pem",
    key: "key-pem",
  });

  const withoutTls = normalizePostgresConfig({ name: "q", tls: false }, {});
  assert.equal(Object.hasOwn(withoutTls.postgres, "ssl"), false);
});

test("buildBullMQOptions omits skipWaitingForReady for postgres, keeps it for redis producers", () => {
  const postgresConfig = normalizeQueueConfig({
    name: "q",
    backend: "postgres",
  });
  const postgresOptions = buildBullMQOptions(
    postgresConfig,
    {},
    undefined,
    "producer",
  );
  assert.equal(Object.hasOwn(postgresOptions, "skipWaitingForReady"), false);

  const redisConfig = normalizeQueueConfig({ name: "q" });
  const redisOptions = buildBullMQOptions(
    redisConfig,
    {},
    undefined,
    "producer",
  );
  assert.equal(redisOptions.skipWaitingForReady, true);
});
