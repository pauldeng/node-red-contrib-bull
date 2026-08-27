#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const AUTH_USERNAME = "node_red";
const AUTH_PASSWORD = "node-red-pass";
const PROJECT_PREFIX = "node-red-contrib-bullmq";
const SINGLE_NOAUTH_PORT = process.env.BULLMQ_SINGLE_NOAUTH_PORT || "16379";
const SINGLE_AUTH_PORT = process.env.BULLMQ_SINGLE_AUTH_PORT || "16380";
const SINGLE_TLS_PORT = process.env.BULLMQ_SINGLE_TLS_PORT || "16387";
const CLUSTER_PORT_A = process.env.BULLMQ_CLUSTER_PORT_A || "17000";
const CLUSTER_PORT_B = process.env.BULLMQ_CLUSTER_PORT_B || "17001";
const CLUSTER_TLS_PORT_A = process.env.BULLMQ_CLUSTER_TLS_PORT_A || "17002";
const CLUSTER_TLS_PORT_B = process.env.BULLMQ_CLUSTER_TLS_PORT_B || "17003";
const SENTINEL_MASTER_PORT = process.env.BULLMQ_SENTINEL_MASTER_PORT || "16381";
const SENTINEL_REPLICA_PORT_A =
  process.env.BULLMQ_SENTINEL_REPLICA_PORT_A || "16382";
const SENTINEL_REPLICA_PORT_B =
  process.env.BULLMQ_SENTINEL_REPLICA_PORT_B || "16383";
const SENTINEL_PORT_A = process.env.BULLMQ_SENTINEL_PORT_A || "26390";
const SENTINEL_PORT_B = process.env.BULLMQ_SENTINEL_PORT_B || "26391";
const SENTINEL_PORT_C = process.env.BULLMQ_SENTINEL_PORT_C || "26392";
const SENTINEL_TLS_MASTER_PORT =
  process.env.BULLMQ_SENTINEL_TLS_MASTER_PORT || "16384";
const SENTINEL_TLS_PORT_A = process.env.BULLMQ_SENTINEL_TLS_PORT_A || "26393";
const SENTINEL_TLS_PORT_B = process.env.BULLMQ_SENTINEL_TLS_PORT_B || "26394";
const SENTINEL_TLS_PORT_C = process.env.BULLMQ_SENTINEL_TLS_PORT_C || "26395";
const POSTGRES_PLAIN_PORT = process.env.BULLMQ_POSTGRES_PLAIN_PORT || "15432";
const POSTGRES_TLS_PORT = process.env.BULLMQ_POSTGRES_TLS_PORT || "15433";
const POSTGRES_DATABASE = "bullmq";

let dockerCommand = ["docker"];

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
  return result;
}

function canRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function resolveDockerCommand() {
  if (canRun("docker", ["info"]) && canRun("docker", ["compose", "version"])) {
    return ["docker"];
  }
  if (
    canRun("sudo", ["-n", "docker", "info"]) &&
    canRun("sudo", "-n docker compose version".split(" "))
  ) {
    return ["sudo", "-n", "docker"];
  }
  return ["docker"];
}

function composeArgs(name, args) {
  return [
    "compose",
    "-p",
    `${PROJECT_PREFIX}-${name}`,
    "-f",
    path.join("test", "deployments", name, "compose.yml"),
    ...args,
  ];
}

function docker(args, options = {}) {
  return run(dockerCommand[0], dockerCommand.slice(1).concat(args), options);
}

function dockerCapture(args) {
  return docker(args, { stdio: "pipe", allowFailure: true });
}

function redisAuthArgs() {
  return ["--user", AUTH_USERNAME, "-a", AUTH_PASSWORD, "--no-auth-warning"];
}

function waitUntil(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const result = check();
    lastOutput = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.status === 0 && result.ready) {
      return;
    }
    sleepMs(500);
  }

  throw new Error(`Timed out waiting for ${label}: ${lastOutput}`);
}

function waitForSingleNoAuth() {
  waitUntil(
    "single-noauth Redis",
    () => {
      const result = dockerCapture(
        composeArgs("single-noauth", [
          "exec",
          "-T",
          "redis",
          "redis-cli",
          "PING",
        ]),
      );
      result.ready = /PONG/.test(result.stdout || "");
      return result;
    },
    30000,
  );
}

function waitForSingleAuth() {
  waitUntil(
    "single-auth Redis",
    () => {
      const result = dockerCapture(
        composeArgs("single-auth", [
          "exec",
          "-T",
          "redis",
          "redis-cli",
          ...redisAuthArgs(),
          "PING",
        ]),
      );
      result.ready = /PONG/.test(result.stdout || "");
      return result;
    },
    30000,
  );
}

function waitForSingleTls() {
  waitUntil(
    "single-tls Redis",
    () => {
      const result = dockerCapture(
        composeArgs("single-tls", [
          "exec",
          "-T",
          "redis",
          "redis-cli",
          "--tls",
          "--insecure",
          "-p",
          SINGLE_TLS_PORT,
          "PING",
        ]),
      );
      result.ready = /PONG/.test(result.stdout || "");
      return result;
    },
    30000,
  );
}

function waitForClusterAuth() {
  waitUntil(
    "cluster-auth Redis Cluster",
    () => {
      const result = dockerCapture(
        composeArgs("cluster-auth", [
          "exec",
          "-T",
          "redis-7000",
          "redis-cli",
          "-p",
          CLUSTER_PORT_A,
          ...redisAuthArgs(),
          "CLUSTER",
          "INFO",
        ]),
      );
      result.ready = /cluster_state:ok/.test(result.stdout || "");
      return result;
    },
    45000,
  );
}

function waitForClusterTls() {
  waitUntil(
    "cluster-tls Redis Cluster",
    () => {
      const result = dockerCapture(
        composeArgs("cluster-tls", [
          "exec",
          "-T",
          "redis-17002",
          "redis-cli",
          "--tls",
          "--insecure",
          "-p",
          CLUSTER_TLS_PORT_A,
          "CLUSTER",
          "INFO",
        ]),
      );
      result.ready = /cluster_state:ok/.test(result.stdout || "");
      return result;
    },
    45000,
  );
}

function waitForSentinelAuth() {
  waitUntil(
    "sentinel-auth Redis Sentinel",
    () => {
      const result = dockerCapture(
        composeArgs("sentinel-auth", [
          "exec",
          "-T",
          "sentinel-26379",
          "redis-cli",
          "-p",
          SENTINEL_PORT_A,
          "SENTINEL",
          "get-master-addr-by-name",
          "mymaster",
        ]),
      );
      result.ready =
        /127\.0\.0\.1/.test(result.stdout || "") &&
        new RegExp(SENTINEL_MASTER_PORT).test(result.stdout || "");
      return result;
    },
    45000,
  );
}

function waitForSentinelTls() {
  waitUntil(
    "sentinel-tls Redis Sentinel",
    () => {
      const result = dockerCapture(
        composeArgs("sentinel-tls", [
          "exec",
          "-T",
          "sentinel-26393",
          "redis-cli",
          "--tls",
          "--insecure",
          "-p",
          SENTINEL_TLS_PORT_A,
          "SENTINEL",
          "get-master-addr-by-name",
          "mymaster",
        ]),
      );
      result.ready =
        /127\.0\.0\.1/.test(result.stdout || "") &&
        new RegExp(SENTINEL_TLS_MASTER_PORT).test(result.stdout || "");
      return result;
    },
    45000,
  );
}

function runExternalIntegration(env) {
  run(process.execPath, ["--test", "test/integration-deployment.test.js"], {
    env: {
      BULLMQ_EXTERNAL_REDIS: "1",
      ...env,
    },
  });
}

function deploymentEnv(name, overrides = {}) {
  return {
    BULLMQ_DEPLOYMENT_NAME: name,
    // Absent means Redis, matching the runtime's own reading of a config node
    // with no backend property.
    BULLMQ_BACKEND: "redis",
    BULLMQ_HOST: "127.0.0.1",
    BULLMQ_PORT: "6379",
    ...overrides,
  };
}

function runDeployment(deployment) {
  console.log(`\n==> ${deployment.name}: starting Docker deployment`);
  docker(composeArgs(deployment.name, ["down", "-v", "--remove-orphans"]), {
    allowFailure: true,
  });

  try {
    docker(composeArgs(deployment.name, ["up", "-d"]));
    deployment.wait();
    console.log(`==> ${deployment.name}: running Node-RED BullMQ tests`);
    runExternalIntegration(deployment.env);
  } finally {
    console.log(`==> ${deployment.name}: tearing down Docker deployment`);
    docker(composeArgs(deployment.name, ["down", "-v", "--remove-orphans"]), {
      allowFailure: true,
    });
  }
}

// READINESS TRAP, and the reason this is not a single successful probe: the
// official postgres image's entrypoint starts the server DURING initdb and
// then restarts it, so a probe that succeeds inside that window reports a
// server that is about to drop the connection. Probing over TCP rather than
// the unix socket (which is up during initdb) and requiring two consecutive
// successes straddles the restart. Same rule as
// test/helpers/stores.js's waitForPostgresReady, for the same reason.
function waitForPostgres(name) {
  let consecutive = 0;
  waitUntil(
    `${name} PostgreSQL`,
    () => {
      const result = dockerCapture(
        composeArgs(name, [
          "exec",
          "-T",
          "postgres",
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          AUTH_USERNAME,
          "-d",
          POSTGRES_DATABASE,
          "-t",
          "2",
        ]),
      );
      consecutive = result.status === 0 ? consecutive + 1 : 0;
      result.ready = consecutive >= 2;
      return result;
    },
    // Longer than the Redis probes: initdb plus the entrypoint restart, and on
    // the TLS fixture a first-run image build as well.
    120000,
  );
}

function memoryDbEnv() {
  if (process.env.MEMORYDB_ENABLED !== "1") {
    return null;
  }

  const required = [
    "MEMORYDB_ENDPOINT",
    "MEMORYDB_PORT",
    "MEMORYDB_USERNAME",
    "MEMORYDB_PASSWORD",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`MEMORYDB_ENABLED=1 but missing: ${missing.join(", ")}`);
  }

  return deploymentEnv("memorydb", {
    BULLMQ_REDIS_MODE: "cluster",
    BULLMQ_CLUSTER_NODES: `${process.env.MEMORYDB_ENDPOINT}:${process.env.MEMORYDB_PORT}`,
    BULLMQ_USERNAME: process.env.MEMORYDB_USERNAME,
    BULLMQ_PASSWORD: process.env.MEMORYDB_PASSWORD,
    BULLMQ_TLS: process.env.MEMORYDB_TLS || "true",
    BULLMQ_QUEUE_PREFIX: "{bull}",
  });
}

function main() {
  dockerCommand = resolveDockerCommand();

  const deployments = [
    {
      name: "single-noauth",
      env: deploymentEnv("single-noauth", {
        BULLMQ_REDIS_MODE: "single",
        BULLMQ_PORT: SINGLE_NOAUTH_PORT,
      }),
      wait: waitForSingleNoAuth,
    },
    {
      name: "single-auth",
      env: deploymentEnv("single-auth", {
        BULLMQ_REDIS_MODE: "single",
        BULLMQ_PORT: SINGLE_AUTH_PORT,
        BULLMQ_USERNAME: AUTH_USERNAME,
        BULLMQ_PASSWORD: AUTH_PASSWORD,
      }),
      wait: waitForSingleAuth,
    },
    {
      name: "single-tls",
      env: deploymentEnv("single-tls", {
        BULLMQ_REDIS_MODE: "single",
        BULLMQ_PORT: SINGLE_TLS_PORT,
        BULLMQ_TLS: "true",
        BULLMQ_TLS_REJECT_UNAUTHORIZED: "false",
      }),
      wait: waitForSingleTls,
    },
    {
      name: "cluster-auth",
      env: deploymentEnv("cluster-auth", {
        BULLMQ_REDIS_MODE: "cluster",
        BULLMQ_CLUSTER_NODES: `127.0.0.1:${CLUSTER_PORT_A},127.0.0.1:${CLUSTER_PORT_B}`,
        BULLMQ_USERNAME: AUTH_USERNAME,
        BULLMQ_PASSWORD: AUTH_PASSWORD,
        BULLMQ_QUEUE_PREFIX: "{bull}",
      }),
      wait: waitForClusterAuth,
    },
    {
      name: "cluster-tls",
      env: deploymentEnv("cluster-tls", {
        BULLMQ_REDIS_MODE: "cluster",
        BULLMQ_CLUSTER_NODES: `127.0.0.1:${CLUSTER_TLS_PORT_A},127.0.0.1:${CLUSTER_TLS_PORT_B}`,
        BULLMQ_TLS: "true",
        BULLMQ_TLS_REJECT_UNAUTHORIZED: "false",
        BULLMQ_QUEUE_PREFIX: "{bull}",
      }),
      wait: waitForClusterTls,
    },
    {
      name: "sentinel-auth",
      env: deploymentEnv("sentinel-auth", {
        BULLMQ_REDIS_MODE: "sentinel",
        BULLMQ_PORT: SENTINEL_MASTER_PORT,
        BULLMQ_SENTINELS: `127.0.0.1:${SENTINEL_PORT_A},127.0.0.1:${SENTINEL_PORT_B},127.0.0.1:${SENTINEL_PORT_C}`,
        BULLMQ_SENTINEL_MASTER_NAME: "mymaster",
        BULLMQ_USERNAME: AUTH_USERNAME,
        BULLMQ_PASSWORD: AUTH_PASSWORD,
      }),
      wait: waitForSentinelAuth,
    },
    {
      name: "sentinel-tls",
      env: deploymentEnv("sentinel-tls", {
        BULLMQ_REDIS_MODE: "sentinel",
        BULLMQ_PORT: SENTINEL_TLS_MASTER_PORT,
        BULLMQ_SENTINELS: `127.0.0.1:${SENTINEL_TLS_PORT_A},127.0.0.1:${SENTINEL_TLS_PORT_B},127.0.0.1:${SENTINEL_TLS_PORT_C}`,
        BULLMQ_SENTINEL_MASTER_NAME: "mymaster",
        BULLMQ_TLS: "true",
        BULLMQ_SENTINEL_TLS: "true",
        BULLMQ_TLS_REJECT_UNAUTHORIZED: "false",
      }),
      wait: waitForSentinelTls,
    },
    {
      name: "postgres-plain",
      env: deploymentEnv("postgres-plain", {
        BULLMQ_BACKEND: "postgres",
        BULLMQ_PORT: POSTGRES_PLAIN_PORT,
        BULLMQ_DATABASE: POSTGRES_DATABASE,
        BULLMQ_USERNAME: AUTH_USERNAME,
        BULLMQ_PASSWORD: AUTH_PASSWORD,
      }),
      wait: () => waitForPostgres("postgres-plain"),
    },
    {
      name: "postgres-tls",
      env: deploymentEnv("postgres-tls", {
        BULLMQ_BACKEND: "postgres",
        BULLMQ_PORT: POSTGRES_TLS_PORT,
        BULLMQ_DATABASE: POSTGRES_DATABASE,
        BULLMQ_USERNAME: AUTH_USERNAME,
        BULLMQ_PASSWORD: AUTH_PASSWORD,
        BULLMQ_TLS: "true",
        // Self-signed fixture certificate, same as the Redis TLS deployments.
        BULLMQ_TLS_REJECT_UNAUTHORIZED: "false",
      }),
      wait: () => waitForPostgres("postgres-tls"),
    },
  ];

  for (const deployment of deployments) {
    runDeployment(deployment);
  }

  const memorydb = memoryDbEnv();
  if (memorydb) {
    console.log("\n==> memorydb: running AWS MemoryDB tests");
    runExternalIntegration(memorydb);
  } else {
    console.log("\n==> memorydb: skipped because MEMORYDB_ENABLED is not 1");
  }
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message || err);
  process.exit(1);
}
