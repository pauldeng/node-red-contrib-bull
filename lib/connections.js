"use strict";

const { isIP } = require("node:net");

// Shared by both backends; "localhost" is the right default either way.
const DEFAULT_HOST = "localhost";
const DEFAULT_REDIS_PORT = 6379;
const CLUSTER_PREFIX = "{bull}";
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_POSTGRES_POOL_MAX = 2;
// The only fail-fast lever on the PostgreSQL path (skipWaitingForReady is
// Redis-only) -- matches the Redis path's connectTimeout.
const POSTGRES_CONNECTION_TIMEOUT_MS = 10000;
const VALID_BACKENDS = ["redis", "postgres"];

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

function toPort(value, defaultValue = DEFAULT_REDIS_PORT, label = "Redis") {
  if (!isPresent(value)) {
    return defaultValue;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${value}`);
  }
  return port;
}

// A saved 2.0.0 flow has no backend property at all, so absent/blank MUST
// mean "redis" -- that is the only way an existing flow keeps working
// untouched.
function normalizeBackend(config) {
  if (!isPresent(config.backend)) {
    return "redis";
  }
  const backend = String(config.backend).trim().toLowerCase();
  if (!VALID_BACKENDS.includes(backend)) {
    throw new Error(`Unsupported backend: ${config.backend}`);
  }
  return backend;
}

function toPoolMax(value) {
  if (!isPresent(value)) {
    return DEFAULT_POSTGRES_POOL_MAX;
  }
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      "PostgreSQL pool max must be a positive whole number of connections",
    );
  }
  return max;
}

function parseEndpoint(
  endpoint,
  defaultPort = DEFAULT_REDIS_PORT,
  tls,
  tlsName = "TLS",
) {
  if (typeof endpoint === "object" && endpoint !== null) {
    const host = endpoint.host || endpoint.address;
    if (!isPresent(host)) {
      throw new Error("Redis endpoint requires a host");
    }
    return {
      host: String(host).trim(),
      port: toPort(endpoint.port, defaultPort),
    };
  }

  const text = String(endpoint || "").trim();
  if (!text) {
    throw new Error("Redis endpoint cannot be empty");
  }
  if (isIP(text)) {
    return { host: text, port: defaultPort };
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `redis://${text}`);
  } catch {
    throw new Error(`Invalid Redis endpoint: ${text}`);
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis endpoint protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      "Redis endpoint URLs cannot include credentials; use the config node credential fields",
    );
  }
  if (hasScheme && tls !== undefined) {
    const secure = url.protocol === "rediss:";
    if (secure !== tls) {
      throw new Error(
        `${url.protocol}// endpoint requires ${tlsName} to be ${secure ? "enabled" : "disabled"}`,
      );
    }
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new Error(`Redis endpoint requires a host: ${text}`);
  }
  return { host, port: toPort(url.port, defaultPort) };
}

function parseEndpointList(
  value,
  defaultPort = DEFAULT_REDIS_PORT,
  tls,
  tlsName = "TLS",
) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        typeof item === "string" ? item.split(/[\n,]+/) : [item],
      )
      .filter((item) => isPresent(item))
      .map((item) => parseEndpoint(item, defaultPort, tls, tlsName));
  }

  if (!isPresent(value)) {
    return [];
  }

  return String(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseEndpoint(item, defaultPort, tls, tlsName));
}

function readSecret(credentials, name) {
  return credentials && isPresent(credentials[name])
    ? credentials[name]
    : undefined;
}

// Blank means "keep every job", which is BullMQ's own default and grows
// without bound. A count keeps the newest N and is what production needs.
function toKeepCount(value, name) {
  if (!isPresent(value)) {
    return undefined;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `${name} must be a non-negative whole number of jobs to keep`,
    );
  }
  return count;
}

function buildDefaultJobOptions(config) {
  const defaults = {};
  const removeOnComplete = toKeepCount(
    config.removeOnComplete,
    "removeOnComplete",
  );
  const removeOnFail = toKeepCount(config.removeOnFail, "removeOnFail");
  if (removeOnComplete !== undefined) {
    defaults.removeOnComplete = removeOnComplete;
  }
  if (removeOnFail !== undefined) {
    defaults.removeOnFail = removeOnFail;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function normalizeQueueConfig(config = {}, credentials = {}) {
  const removedAlias = [
    "mode",
    "redisMode",
    "host",
    "queueName",
    "startupNodes",
    "masterName",
    "nameOfMaster",
  ].find((name) => isPresent(config[name]));
  if (removedAlias) {
    throw new Error(`Unsupported config field: ${removedAlias}`);
  }
  const plaintextSecret = [
    "password",
    "sentinelPassword",
    "tlsCa",
    "tlsCert",
    "tlsKey",
  ].find((name) => isPresent(config[name]));
  if (plaintextSecret) {
    throw new Error(
      `${plaintextSecret} must be stored in Node-RED credentials`,
    );
  }

  // Validate only the fields belonging to the selected backend. Hidden
  // editor rows keep their values, so a flow switched to postgres still
  // carries deployment/clusterNodes/prefix in its saved JSON -- rejecting
  // those would make switching backends impossible without hand-editing
  // flows.
  if (normalizeBackend(config) === "postgres") {
    return normalizePostgresConfig(config, credentials);
  }

  const deployment = String(config.deployment || "single").toLowerCase();

  if (!["single", "cluster", "sentinel"].includes(deployment)) {
    throw new Error(`Unsupported Redis deployment mode: ${deployment}`);
  }

  const host = config.address || DEFAULT_HOST;
  const port = toPort(config.port, DEFAULT_REDIS_PORT);
  const queueName = String(config.name || "").trim();
  if (!queueName) {
    throw new Error("BullMQ queue name is required");
  }
  const tls = toBoolean(config.tls, false);
  const sentinelTls = toBoolean(config.sentinelTls, false);

  const normalized = {
    queueName,
    deployment,
    host: String(host).trim(),
    port,
    db: isPresent(config.db) ? Number(config.db) : undefined,
    username: config.username || undefined,
    password: readSecret(credentials, "password"),
    tls,
    tlsRejectUnauthorized: toBoolean(config.tlsRejectUnauthorized, true),
    tlsCa: readSecret(credentials, "tlsCa"),
    tlsCert: readSecret(credentials, "tlsCert"),
    tlsKey: readSecret(credentials, "tlsKey"),
    tlsServerName: config.tlsServerName || undefined,
    prefix: config.prefix || undefined,
    defaultJobOptions: buildDefaultJobOptions(config),
    clusterNodes: parseEndpointList(
      config.clusterNodes,
      DEFAULT_REDIS_PORT,
      tls,
      "TLS",
    ),
    sentinelMasterName: config.sentinelMasterName,
    sentinels: parseEndpointList(
      config.sentinels,
      26379,
      sentinelTls,
      "Sentinel TLS",
    ),
    sentinelUsername: config.sentinelUsername || undefined,
    sentinelPassword: readSecret(credentials, "sentinelPassword"),
    sentinelTls,
    telemetry: toBoolean(config.telemetry, false),
    telemetryServiceName: config.telemetryServiceName || undefined,
    telemetryMetrics: toBoolean(config.telemetryMetrics, false),
  };

  if (deployment === "cluster") {
    if (normalized.clusterNodes.length === 0) {
      normalized.clusterNodes = [
        { host: normalized.host, port: normalized.port },
      ];
    }
    normalized.prefix = normalized.prefix || CLUSTER_PREFIX;
    if (!/\{[^}]+\}/.test(normalized.prefix)) {
      throw new Error(
        "Cluster BullMQ prefix must contain a Redis hash tag such as {bull}",
      );
    }
  }

  if (deployment === "sentinel") {
    if (!normalized.sentinelMasterName) {
      throw new Error("Sentinel deployment requires a master name");
    }
    if (normalized.sentinels.length === 0) {
      normalized.sentinels = [{ host: normalized.host, port: 26379 }];
    }
  }

  return normalized;
}

function buildTlsOptions(config, enabled) {
  if (!enabled) {
    return undefined;
  }

  const tls = {
    rejectUnauthorized: config.tlsRejectUnauthorized,
  };

  if (config.tlsServerName) {
    tls.servername = config.tlsServerName;
  }
  if (config.tlsCa) {
    tls.ca = config.tlsCa;
  }
  if (config.tlsCert) {
    tls.cert = config.tlsCert;
  }
  if (config.tlsKey) {
    tls.key = config.tlsKey;
  }

  return tls;
}

// Produces the pg pool config BullMQ's createPostgresBackend will receive as
// `connection`. Only the fields PostgreSQL needs are read; every Redis-only
// field a switched flow still carries in its saved JSON (deployment,
// clusterNodes, sentinels, prefix, ...) is simply never touched here, so it
// is ignored rather than rejected.
function normalizePostgresConfig(config, credentials) {
  const queueName = String(config.name || "").trim();
  if (!queueName) {
    throw new Error("BullMQ queue name is required");
  }
  const tls = toBoolean(config.tls, false);
  const ssl = buildTlsOptions(
    {
      tlsRejectUnauthorized: toBoolean(config.tlsRejectUnauthorized, true),
      tlsServerName: config.tlsServerName || undefined,
      tlsCa: readSecret(credentials, "tlsCa"),
      tlsCert: readSecret(credentials, "tlsCert"),
      tlsKey: readSecret(credentials, "tlsKey"),
    },
    tls,
  );

  const postgres = {
    host: String(config.address || DEFAULT_HOST).trim(),
    port: toPort(config.port, DEFAULT_POSTGRES_PORT, "PostgreSQL"),
    database: config.database || undefined,
    user: config.username || undefined,
    password: readSecret(credentials, "password"),
    schema: config.schema || undefined,
    max: toPoolMax(config.max),
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    migrate: toBoolean(config.migrate, true),
  };
  if (ssl) {
    postgres.ssl = ssl;
  }

  return {
    backend: "postgres",
    queueName,
    postgres,
    defaultJobOptions: buildDefaultJobOptions(config),
    telemetry: toBoolean(config.telemetry, false),
    telemetryServiceName: config.telemetryServiceName || undefined,
    telemetryMetrics: toBoolean(config.telemetryMetrics, false),
  };
}

// BullMQ's production guidance: exponential reconnect backoff with a 1s floor
// and a 20s ceiling, rather than ioredis's default 50ms-2s, which hammers a
// down Redis once per connection role per runtime node.
const RECONNECT_FLOOR_MS = 1000;
const RECONNECT_CEILING_MS = 20000;

function reconnectBackoff(attempt) {
  return Math.min(
    RECONNECT_FLOOR_MS * 2 ** (attempt - 1),
    RECONNECT_CEILING_MS,
  );
}

function isConsumerRole(role) {
  return role === "worker" || role === "events";
}

function retryValueForRole(role) {
  return isConsumerRole(role) ? null : 1;
}

function buildStandaloneOptions(config, role) {
  const options = {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: retryValueForRole(role),
    enableReadyCheck: true,
    connectTimeout: 10000,
    retryStrategy: reconnectBackoff,
  };

  // Deliberately NOT enableOfflineQueue:false, which BullMQ's production guide
  // suggests for producers. Measured against a healthy Redis, it rejects a
  // command issued during the connect window -- which in Node-RED is every
  // deploy-time message. Keeping the offline queue accepts those, while
  // maxRetriesPerRequest above still fails a genuinely-down Redis in about a
  // second instead of hanging.

  if (config.db !== undefined && !Number.isNaN(config.db)) {
    options.db = config.db;
  }
  if (config.username) {
    options.username = config.username;
  }
  if (config.password) {
    options.password = config.password;
  }
  const tls = buildTlsOptions(config, config.tls);
  if (tls) {
    options.tls = tls;
  }

  return options;
}

function buildRedisDescriptor(config, role = "producer") {
  if (config.deployment === "cluster") {
    const redisOptions = {
      maxRetriesPerRequest: retryValueForRole(role),
      enableReadyCheck: true,
      connectTimeout: 10000,
      retryStrategy: reconnectBackoff,
    };
    if (config.username) {
      redisOptions.username = config.username;
    }
    if (config.password) {
      redisOptions.password = config.password;
    }
    const tls = buildTlsOptions(config, config.tls);
    if (tls) {
      redisOptions.tls = tls;
    }

    return {
      kind: "cluster",
      startupNodes: config.clusterNodes,
      options: {
        redisOptions,
        slotsRefreshTimeout: 2000,
        maxRedirections: 16,
        dnsLookup: (address, callback) => callback(null, address),
        clusterRetryStrategy: reconnectBackoff,
      },
    };
  }

  if (config.deployment === "sentinel") {
    const options = buildStandaloneOptions(config, role);
    delete options.host;
    delete options.port;
    if (config.db !== undefined && !Number.isNaN(config.db)) {
      options.db = config.db;
    }
    options.sentinels = config.sentinels;
    options.name = config.sentinelMasterName;
    options.sentinelRetryStrategy = reconnectBackoff;
    if (config.sentinelUsername) {
      options.sentinelUsername = config.sentinelUsername;
    }
    if (config.sentinelPassword) {
      options.sentinelPassword = config.sentinelPassword;
    }
    if (config.sentinelTls) {
      options.enableTLSForSentinelMode = true;
      options.sentinelTLS = buildTlsOptions(config, true);
    }

    return { kind: "single", options };
  }

  return { kind: "single", options: buildStandaloneOptions(config, role) };
}

function createRedisConnection(descriptor, IORedis) {
  if (descriptor.kind === "cluster") {
    return new IORedis.Cluster(descriptor.startupNodes, descriptor.options);
  }
  return new IORedis(descriptor.options);
}

function buildBullMQOptions(config, connection, telemetry, role = "producer") {
  const options = {};
  if (connection) {
    options.connection = connection;
  }
  if (config.prefix) {
    options.prefix = config.prefix;
  }
  if (telemetry) {
    options.telemetry = telemetry;
  }
  // Without this, BullMQ awaits a connection-ready promise that never settles
  // while Redis is unreachable, so a producer command hangs forever instead of
  // erroring. Consumers must keep waiting for the connection to come back.
  // Only createRedisBackend forwards skipWaitingForReady (verified in
  // node_modules/bullmq/dist/cjs/utils/create-backend.js) -- createPostgresBackend
  // never reads it, so setting it there would be a misleading no-op.
  if (!isConsumerRole(role) && config.backend !== "postgres") {
    options.skipWaitingForReady = true;
  }
  return options;
}

module.exports = {
  POSTGRES_CONNECTION_TIMEOUT_MS,
  buildBullMQOptions,
  buildRedisDescriptor,
  createRedisConnection,
  normalizeQueueConfig,
  normalizePostgresConfig,
  parseEndpointList,
};
