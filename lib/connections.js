"use strict";

const DEFAULT_REDIS_HOST = "localhost";
const DEFAULT_REDIS_PORT = 6379;
const CLUSTER_PREFIX = "{bull}";

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

function toPort(value, defaultValue = DEFAULT_REDIS_PORT) {
  if (!isPresent(value)) {
    return defaultValue;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Redis port: ${value}`);
  }
  return port;
}

function parseEndpoint(endpoint, defaultPort = DEFAULT_REDIS_PORT) {
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

  let host = text;
  let port = defaultPort;
  const urlMatch = text.match(
    /^(?:redis|rediss):\/\/(?:[^@]+@)?([^/:]+)(?::(\d+))?/i,
  );
  if (urlMatch) {
    host = urlMatch[1];
    port = toPort(urlMatch[2], defaultPort);
  } else if (text.includes(":")) {
    const parts = text.split(":");
    port = toPort(parts.pop(), defaultPort);
    host = parts.join(":");
  }

  if (!host.trim()) {
    throw new Error(`Redis endpoint requires a host: ${text}`);
  }

  return { host: host.trim(), port };
}

function parseEndpointList(value, defaultPort = DEFAULT_REDIS_PORT) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        typeof item === "string" ? item.split(/[\n,]+/) : [item],
      )
      .filter((item) => isPresent(item))
      .map((item) => parseEndpoint(item, defaultPort));
  }

  if (!isPresent(value)) {
    return [];
  }

  return String(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseEndpoint(item, defaultPort));
}

function readSecret(config, credentials, name) {
  if (credentials && isPresent(credentials[name])) {
    return credentials[name];
  }
  return config[name];
}

function normalizeQueueConfig(config = {}, credentials = {}) {
  const deploymentInput = String(
    config.deployment || config.mode || config.redisMode || "single",
  ).toLowerCase();
  const deployment =
    deploymentInput === "memorydb" ? "cluster" : deploymentInput;

  if (!["single", "cluster", "sentinel"].includes(deployment)) {
    throw new Error(`Unsupported Redis deployment mode: ${deploymentInput}`);
  }

  const host = config.host || config.address || DEFAULT_REDIS_HOST;
  const port = toPort(config.port, DEFAULT_REDIS_PORT);
  const queueName = String(config.queueName || config.name || "").trim();
  if (!queueName) {
    throw new Error("BullMQ queue name is required");
  }

  const normalized = {
    queueName,
    deployment,
    host: String(host).trim(),
    port,
    db: isPresent(config.db) ? Number(config.db) : undefined,
    username: config.username || undefined,
    password: readSecret(config, credentials, "password") || undefined,
    tls: toBoolean(config.tls, false),
    tlsRejectUnauthorized: toBoolean(config.tlsRejectUnauthorized, true),
    tlsCa: readSecret(config, credentials, "tlsCa") || undefined,
    tlsCert: readSecret(config, credentials, "tlsCert") || undefined,
    tlsKey: readSecret(config, credentials, "tlsKey") || undefined,
    tlsServerName: config.tlsServerName || undefined,
    prefix: config.prefix || undefined,
    clusterNodes: parseEndpointList(config.clusterNodes || config.startupNodes),
    sentinelMasterName:
      config.sentinelMasterName || config.masterName || config.nameOfMaster,
    sentinels: parseEndpointList(config.sentinels, 26379),
    sentinelUsername: config.sentinelUsername || undefined,
    sentinelPassword:
      readSecret(config, credentials, "sentinelPassword") || undefined,
    sentinelTls: toBoolean(config.sentinelTls, false),
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

function retryValueForRole(role) {
  return role === "worker" || role === "events" ? null : 1;
}

function buildStandaloneOptions(config, role) {
  const options = {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: retryValueForRole(role),
    enableReadyCheck: true,
    connectTimeout: 10000,
  };

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

function buildBullMQOptions(config, connection) {
  const options = {};
  if (connection) {
    options.connection = connection;
  }
  if (config.prefix) {
    options.prefix = config.prefix;
  }
  return options;
}

module.exports = {
  buildBullMQOptions,
  buildRedisDescriptor,
  createRedisConnection,
  normalizeQueueConfig,
  parseEndpointList,
};
