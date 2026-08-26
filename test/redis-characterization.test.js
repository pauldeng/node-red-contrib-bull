// This file pins today's Redis behaviour in lib/connections.js before Phase
// 2 of the PostgreSQL backend work splits that file behind a backend
// branch. Every assertion here is deliberately over-specified -- whole-
// object deepEqual instead of field-by-field checks -- so that any key the
// refactor adds, removes, or renames fails this suite loudly.
//
// Update this file ONLY when a Redis behaviour change is intended. If an
// assertion here breaks and the change was not deliberate, the refactor
// drifted from byte-identical Redis behaviour -- that is a bug in the
// refactor, not a stale test.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildBullMQOptions,
  buildRedisDescriptor,
  normalizeQueueConfig,
} = require("../lib/connections");

// retryStrategy, clusterRetryStrategy, and sentinelRetryStrategy are all the
// same unexported reconnectBackoff closure. Two separately-built option
// objects never share that exact function reference with a literal we write
// here, so deepEqual can't usefully cover them. Strip functions out for the
// deepEqual pass, then check each one separately by its computed values.
function withoutFunctions(value) {
  if (Array.isArray(value)) {
    return value.map(withoutFunctions);
  }
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === "function") continue;
      copy[key] = withoutFunctions(val);
    }
    return copy;
  }
  return value;
}

function assertReconnectBackoff(fn, message) {
  assert.equal(typeof fn, "function", message);
  assert.equal(fn(1), 1000, message);
  assert.equal(fn(2), 2000, message);
  assert.equal(fn(50), 20000, message);
}

const SINGLE_RAW = {
  name: "orders",
  address: "redis.example.test",
  port: "6380",
  username: "default-user",
  db: "2",
  tls: true,
  tlsRejectUnauthorized: false,
  tlsServerName: "redis.example.test",
  prefix: "myprefix",
  removeOnComplete: "100",
  removeOnFail: "50",
  telemetry: true,
  telemetryServiceName: "orders-service",
  telemetryMetrics: true,
};
const SINGLE_CREDS = {
  password: "redis-secret",
  tlsCa: "ca-pem",
  tlsCert: "cert-pem",
  tlsKey: "key-pem",
};

const CLUSTER_RAW = {
  name: "cluster-queue",
  deployment: "cluster",
  clusterNodes: "node-a.example.test:6379,node-b.example.test:6380",
  username: "cluster-user",
  tls: true,
  tlsRejectUnauthorized: true,
  prefix: "myapp:{bull}",
  removeOnComplete: "10",
};
const CLUSTER_CREDS = { password: "cluster-secret" };

const SENTINEL_RAW = {
  name: "sentinel-queue",
  deployment: "sentinel",
  sentinels: "sentinel-a.example.test:26379,sentinel-b.example.test:26380",
  sentinelMasterName: "mymaster",
  username: "data-user",
  sentinelUsername: "sentinel-user",
  tls: true,
  sentinelTls: true,
  db: "1",
};
const SENTINEL_CREDS = {
  password: "data-secret",
  sentinelPassword: "sentinel-secret",
};

// ---------------------------------------------------------------------------
// normalizeQueueConfig: one representative config per deployment mode,
// asserted as a whole object so any added/removed/renamed key fails.
// ---------------------------------------------------------------------------

test("normalizeQueueConfig: exact shape for a standalone deployment", () => {
  const config = normalizeQueueConfig(SINGLE_RAW, SINGLE_CREDS);

  assert.deepEqual(config, {
    queueName: "orders",
    deployment: "single",
    host: "redis.example.test",
    port: 6380,
    db: 2,
    username: "default-user",
    password: "redis-secret",
    tls: true,
    tlsRejectUnauthorized: false,
    tlsCa: "ca-pem",
    tlsCert: "cert-pem",
    tlsKey: "key-pem",
    tlsServerName: "redis.example.test",
    prefix: "myprefix",
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
    clusterNodes: [],
    sentinelMasterName: undefined,
    sentinels: [],
    sentinelUsername: undefined,
    sentinelPassword: undefined,
    sentinelTls: false,
    telemetry: true,
    telemetryServiceName: "orders-service",
    telemetryMetrics: true,
  });
});

test("normalizeQueueConfig: exact shape for a Cluster deployment", () => {
  const config = normalizeQueueConfig(CLUSTER_RAW, CLUSTER_CREDS);

  assert.deepEqual(config, {
    queueName: "cluster-queue",
    deployment: "cluster",
    host: "localhost",
    port: 6379,
    db: undefined,
    username: "cluster-user",
    password: "cluster-secret",
    tls: true,
    tlsRejectUnauthorized: true,
    tlsCa: undefined,
    tlsCert: undefined,
    tlsKey: undefined,
    tlsServerName: undefined,
    prefix: "myapp:{bull}",
    defaultJobOptions: { removeOnComplete: 10 },
    clusterNodes: [
      { host: "node-a.example.test", port: 6379 },
      { host: "node-b.example.test", port: 6380 },
    ],
    sentinelMasterName: undefined,
    sentinels: [],
    sentinelUsername: undefined,
    sentinelPassword: undefined,
    sentinelTls: false,
    telemetry: false,
    telemetryServiceName: undefined,
    telemetryMetrics: false,
  });
});

test("normalizeQueueConfig: exact shape for a Sentinel deployment", () => {
  const config = normalizeQueueConfig(SENTINEL_RAW, SENTINEL_CREDS);

  assert.deepEqual(config, {
    queueName: "sentinel-queue",
    deployment: "sentinel",
    host: "localhost",
    port: 6379,
    db: 1,
    username: "data-user",
    password: "data-secret",
    tls: true,
    tlsRejectUnauthorized: true,
    tlsCa: undefined,
    tlsCert: undefined,
    tlsKey: undefined,
    tlsServerName: undefined,
    prefix: undefined,
    defaultJobOptions: undefined,
    clusterNodes: [],
    sentinelMasterName: "mymaster",
    sentinels: [
      { host: "sentinel-a.example.test", port: 26379 },
      { host: "sentinel-b.example.test", port: 26380 },
    ],
    sentinelUsername: "sentinel-user",
    sentinelPassword: "sentinel-secret",
    sentinelTls: true,
    telemetry: false,
    telemetryServiceName: undefined,
    telemetryMetrics: false,
  });
});

// ---------------------------------------------------------------------------
// buildRedisDescriptor: every role, on every deployment mode. Non-function
// keys via deepEqual; strategy functions checked separately by value.
// ---------------------------------------------------------------------------

test("buildRedisDescriptor: exact shape for a standalone deployment, every role", () => {
  const config = normalizeQueueConfig(SINGLE_RAW, SINGLE_CREDS);
  const expectedTls = {
    rejectUnauthorized: false,
    servername: "redis.example.test",
    ca: "ca-pem",
    cert: "cert-pem",
    key: "key-pem",
  };

  for (const [role, maxRetriesPerRequest] of [
    ["producer", 1],
    ["worker", null],
    ["events", null],
  ]) {
    const descriptor = buildRedisDescriptor(config, role);
    assert.equal(descriptor.kind, "single", role);
    assert.deepEqual(
      withoutFunctions(descriptor.options),
      {
        host: "redis.example.test",
        port: 6380,
        maxRetriesPerRequest,
        enableReadyCheck: true,
        connectTimeout: 10000,
        db: 2,
        username: "default-user",
        password: "redis-secret",
        tls: expectedTls,
      },
      role,
    );
    assertReconnectBackoff(descriptor.options.retryStrategy, role);
  }
});

test("buildRedisDescriptor: exact shape for a Cluster deployment, every role", () => {
  const config = normalizeQueueConfig(CLUSTER_RAW, CLUSTER_CREDS);

  for (const [role, maxRetriesPerRequest] of [
    ["producer", 1],
    ["worker", null],
    ["events", null],
  ]) {
    const descriptor = buildRedisDescriptor(config, role);
    assert.equal(descriptor.kind, "cluster", role);
    assert.deepEqual(
      descriptor.startupNodes,
      [
        { host: "node-a.example.test", port: 6379 },
        { host: "node-b.example.test", port: 6380 },
      ],
      role,
    );
    assert.deepEqual(
      withoutFunctions(descriptor.options),
      {
        redisOptions: {
          maxRetriesPerRequest,
          enableReadyCheck: true,
          connectTimeout: 10000,
          username: "cluster-user",
          password: "cluster-secret",
          tls: { rejectUnauthorized: true },
        },
        slotsRefreshTimeout: 2000,
        maxRedirections: 16,
      },
      role,
    );
    assertReconnectBackoff(descriptor.options.redisOptions.retryStrategy, role);
    assertReconnectBackoff(descriptor.options.clusterRetryStrategy, role);

    let seen;
    descriptor.options.dnsLookup("some-host", (err, address) => {
      seen = { err, address };
    });
    assert.equal(seen.err, null, role);
    assert.equal(seen.address, "some-host", role);
  }
});

test("buildRedisDescriptor: exact shape for a Sentinel deployment, every role", () => {
  const config = normalizeQueueConfig(SENTINEL_RAW, SENTINEL_CREDS);

  for (const [role, maxRetriesPerRequest] of [
    ["producer", 1],
    ["worker", null],
    ["events", null],
  ]) {
    const descriptor = buildRedisDescriptor(config, role);
    assert.equal(descriptor.kind, "single", role);
    // Sentinel mode deletes host/port from the standalone base entirely --
    // not merely leaves them undefined.
    assert.equal(Object.hasOwn(descriptor.options, "host"), false, role);
    assert.equal(Object.hasOwn(descriptor.options, "port"), false, role);
    assert.deepEqual(
      withoutFunctions(descriptor.options),
      {
        maxRetriesPerRequest,
        enableReadyCheck: true,
        connectTimeout: 10000,
        db: 1,
        username: "data-user",
        password: "data-secret",
        tls: { rejectUnauthorized: true },
        sentinels: [
          { host: "sentinel-a.example.test", port: 26379 },
          { host: "sentinel-b.example.test", port: 26380 },
        ],
        name: "mymaster",
        sentinelUsername: "sentinel-user",
        sentinelPassword: "sentinel-secret",
        enableTLSForSentinelMode: true,
        sentinelTLS: { rejectUnauthorized: true },
      },
      role,
    );
    assertReconnectBackoff(descriptor.options.retryStrategy, role);
    assertReconnectBackoff(descriptor.options.sentinelRetryStrategy, role);
  }
});

// ---------------------------------------------------------------------------
// buildBullMQOptions: skipWaitingForReady per role; telemetry/connection
// pass through unchanged; defaultJobOptions does NOT flow through here.
// ---------------------------------------------------------------------------

test("buildBullMQOptions: skipWaitingForReady only on producer; connection and telemetry pass through by reference", () => {
  const config = normalizeQueueConfig(
    { name: "orders", prefix: "myprefix" },
    {},
  );
  const connection = { fake: "connection" };
  const telemetry = { fake: "telemetry" };

  const producer = buildBullMQOptions(
    config,
    connection,
    telemetry,
    "producer",
  );
  assert.deepEqual(Object.keys(producer).sort(), [
    "connection",
    "prefix",
    "skipWaitingForReady",
    "telemetry",
  ]);
  assert.equal(producer.connection, connection);
  assert.equal(producer.telemetry, telemetry);
  assert.equal(producer.prefix, "myprefix");
  assert.equal(producer.skipWaitingForReady, true);

  for (const role of ["worker", "events"]) {
    const options = buildBullMQOptions(config, connection, telemetry, role);
    assert.deepEqual(
      Object.keys(options).sort(),
      ["connection", "prefix", "telemetry"],
      role,
    );
    assert.equal(Object.hasOwn(options, "skipWaitingForReady"), false, role);
    assert.equal(options.connection, connection, role);
    assert.equal(options.telemetry, telemetry, role);
  }
});

test("buildBullMQOptions: never carries defaultJobOptions, even though normalizeQueueConfig computed one", () => {
  // Surprising: defaultJobOptions lives on the normalized config object, but
  // buildBullMQOptions does not read it -- bull-queue.js applies
  // config.defaultJobOptions to queue options separately. Pinning this here
  // so the Phase 2 split does not accidentally start forwarding it through
  // this function, or silently stop applying it elsewhere.
  const config = normalizeQueueConfig(
    { name: "orders", removeOnComplete: "5" },
    {},
  );
  assert.deepEqual(config.defaultJobOptions, { removeOnComplete: 5 });

  for (const role of ["producer", "worker", "events"]) {
    const options = buildBullMQOptions(config, {}, undefined, role);
    assert.equal(Object.hasOwn(options, "defaultJobOptions"), false, role);
  }
});

// ---------------------------------------------------------------------------
// TLS: every field, and the Sentinel variant.
// ---------------------------------------------------------------------------

test("TLS: a standalone config with every tls* field reaches ioredis as one exact object, every role", () => {
  const config = normalizeQueueConfig(SINGLE_RAW, SINGLE_CREDS);
  const expectedTls = {
    rejectUnauthorized: false,
    servername: "redis.example.test",
    ca: "ca-pem",
    cert: "cert-pem",
    key: "key-pem",
  };

  for (const role of ["producer", "worker", "events"]) {
    assert.deepEqual(
      buildRedisDescriptor(config, role).options.tls,
      expectedTls,
      role,
    );
  }
});

test("TLS: Sentinel variant sets enableTLSForSentinelMode/sentinelTLS from the shared tls* fields", () => {
  // sentinelTls only toggles whether sentinelTLS/enableTLSForSentinelMode
  // are emitted -- the certificate material (ca/cert/key/servername/
  // rejectUnauthorized) is the SAME tls* config used for the data
  // connection. There is no separate sentinel-only certificate. Here tls is
  // OFF and sentinelTls is ON, to prove options.tls is entirely absent while
  // sentinelTLS still carries the full cert set.
  const config = normalizeQueueConfig(
    {
      name: "sentinel-tls",
      deployment: "sentinel",
      sentinels: "sentinel-a.example.test:26379",
      sentinelMasterName: "mymaster",
      tls: false,
      sentinelTls: true,
      tlsRejectUnauthorized: false,
      tlsServerName: "db.example.test",
    },
    { tlsCa: "ca-pem", tlsCert: "cert-pem", tlsKey: "key-pem" },
  );

  const descriptor = buildRedisDescriptor(config, "producer");
  assert.equal(Object.hasOwn(descriptor.options, "tls"), false);
  assert.equal(descriptor.options.enableTLSForSentinelMode, true);
  assert.deepEqual(descriptor.options.sentinelTLS, {
    rejectUnauthorized: false,
    servername: "db.example.test",
    ca: "ca-pem",
    cert: "cert-pem",
    key: "key-pem",
  });
});
