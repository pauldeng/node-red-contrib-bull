// Test-side backend adapters, so one integration test body can run against
// both stores. Deliberately small: a suite differs only in how the store is
// started, how a config node points at it, and how an out-of-band inspector
// Queue is built. Everything else in a parameterized test is already
// backend-neutral, and anything that cannot be must say which backend it needs
// rather than quietly skipping.

const { execFile, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { promisify } = require("node:util");

const { Queue, createPostgresBackend } = require("bullmq");
const Redis = require("ioredis");

const execFileAsync = promisify(execFile);
const REDIS_IMAGE = "redis:7.2-alpine";

// The newest PostgreSQL series (18.x). Pinned to the major rather than
// :latest so a future major bump is a deliberate change with its own test
// run, not a silent one on someone else's machine.
const POSTGRES_IMAGE = "postgres:18-alpine";

function commandAvailable(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function dockerAvailable() {
  return commandAvailable("docker", ["info"]);
}

// --- Redis ------------------------------------------------------------------

async function waitForRedis(port) {
  const deadline = Date.now() + 10000;
  let lastError;

  while (Date.now() < deadline) {
    const client = new Redis({
      host: "127.0.0.1",
      port,
      connectTimeout: 200,
      maxRetriesPerRequest: 1,
      retryStrategy: null,
    });
    client.on("error", () => {});
    try {
      await client.ping();
      client.disconnect();
      return;
    } catch (err) {
      lastError = err;
      client.disconnect();
      await sleep(50);
    }
  }

  throw new Error(`Timed out waiting for redis-server: ${lastError.message}`);
}

async function startRedis(port = 16400 + Math.floor(Math.random() * 1000)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bullmq-redis-"));
  const child = spawn(
    "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      dir,
      "--maxmemory-policy",
      "noeviction",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForRedis(port);
  } catch (err) {
    if (child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return {
    port,
    async stop() {
      if (child.exitCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startRedisContainer(requestedPort) {
  const name = `bullmq-redis-test-${process.pid}-${Date.now()}`;
  const publishedPort = requestedPort
    ? `127.0.0.1:${requestedPort}:6379`
    : "127.0.0.1::6379";

  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    publishedPort,
    REDIS_IMAGE,
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
    "--maxmemory-policy",
    "noeviction",
  ]);

  async function stop() {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      // best effort after a failed test
    }
  }

  try {
    let port = requestedPort;
    if (!port) {
      const { stdout } = await execFileAsync("docker", ["port", name, "6379"]);
      const match = stdout.match(/:(\d+)\s*$/m);
      if (!match) {
        throw new Error(`could not read the published port from: ${stdout}`);
      }
      port = Number(match[1]);
    }
    await waitForRedis(port);
    return { port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function startRedisStore(port) {
  return commandAvailable("redis-server", ["--version"])
    ? startRedis(port)
    : startRedisContainer(port);
}

// --- PostgreSQL -------------------------------------------------------------

function postgresClient(postgres) {
  // Required lazily: pg is an optional peer dependency, and the Redis half of
  // a parameterized suite must not need it installed.
  const { Client: PgClient } = require("pg");
  return new PgClient({
    host: "127.0.0.1",
    port: postgres.port,
    user: postgres.user,
    password: postgres.password,
    database: postgres.database,
  });
}

async function pgIsReadyOnce(name, user, database) {
  try {
    await execFileAsync("docker", [
      "exec",
      name,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      user,
      "-d",
      database,
      "-t",
      "2",
    ]);
    return true;
  } catch {
    return false;
  }
}

// READINESS TRAP: the official image's entrypoint starts the server DURING
// initdb, then restarts it. A probe that succeeds in that window is a false
// ready, and the restart drops the connection moments later. Probing over TCP
// and requiring two consecutive successes straddles the restart.
async function waitForPostgresReady(
  name,
  port,
  user,
  database,
  timeoutMs = 30000,
) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await pgIsReadyOnce(name, user, database)) {
      consecutive += 1;
      if (consecutive >= 2) {
        return;
      }
    } else {
      consecutive = 0;
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for PostgreSQL to become ready on port ${port}`,
  );
}

async function startPostgres() {
  const name = `bullmq-pg-test-${process.pid}-${Date.now()}`;
  const user = "bullmq";
  const password = "bullmqpw";
  const database = "bullmq";

  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--shm-size",
    "128mb",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_DB=${database}`,
    // Let Docker choose the host port and then read back the mapping it
    // published. Picking a random port ourselves races anything else on the
    // machine -- a parallel run, or an unrelated local service -- and the
    // container owns the listener until we ask, so there is no window between
    // probing a port and binding it.
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);

  // -v removes the anonymous volume the postgres image declares for its
  // data directory. Without it every run leaks one, and enough runs fill
  // the host disk -- which surfaces as initdb failing with "No space left
  // on device", not as anything resembling a test problem.
  async function stop() {
    try {
      await execFileAsync("docker", ["rm", "-f", "-v", name]);
    } catch {
      // best effort after a failed test
    }
  }

  let port;
  try {
    const { stdout } = await execFileAsync("docker", ["port", name, "5432"]);
    // e.g. "127.0.0.1:49154" (possibly several lines, one per family)
    const match = stdout.match(/:(\d+)\s*$/m);
    if (!match) {
      throw new Error(`could not read the published port from: ${stdout}`);
    }
    port = Number(match[1]);
  } catch (err) {
    await stop();
    throw err;
  }

  try {
    await waitForPostgresReady(name, port, user, database);
  } catch (err) {
    await stop();
    throw err;
  }

  return { port, user, password, database, stop };
}

// --- Adapters ---------------------------------------------------------------

const REDIS_ADAPTER = {
  name: "redis",
  unavailable() {
    return commandAvailable("redis-server", ["--version"]) || dockerAvailable()
      ? undefined
      : "neither redis-server nor Docker is available";
  },
  start: startRedisStore,
  queueConfig(id, name, store, extra = {}) {
    return {
      id,
      type: "bullmq-queue-server",
      name,
      deployment: "single",
      address: "127.0.0.1",
      port: String(store.port),
      ...extra,
    };
  },
  credentials() {
    return {};
  },
  inspectorQueue(name, store) {
    return new Queue(name, {
      connection: { host: "127.0.0.1", port: store.port },
    });
  },
};

const POSTGRES_ADAPTER = {
  name: "postgres",
  unavailable() {
    if (!dockerAvailable()) {
      return "Docker is not available, and the PostgreSQL fixture is a container";
    }
    try {
      require.resolve("pg");
    } catch {
      return "the optional peer dependency pg is not installed";
    }
    return undefined;
  },
  start: startPostgres,
  queueConfig(id, name, store, extra = {}) {
    return {
      id,
      type: "bullmq-queue-server",
      name,
      backend: "postgres",
      address: "127.0.0.1",
      port: String(store.port),
      database: store.database,
      username: store.user,
      ...extra,
    };
  },
  credentials(store) {
    // The config node's password is a Node-RED credential, so it never
    // travels in the flow itself.
    return { queue: { password: store.password } };
  },
  inspectorQueue(name, store) {
    return new Queue(
      name,
      {
        connection: {
          host: "127.0.0.1",
          port: store.port,
          user: store.user,
          password: store.password,
          database: store.database,
          // An inspector may be built before the flow deploys, so it cannot
          // assume the schema exists yet. Migrating here is safe rather than a
          // race: BullMQ's migrator takes an advisory lock, which
          // test/integration-postgres.test.js proves by migrating a fresh
          // database from four independent backends exactly once.
          migrate: true,
        },
      },
      createPostgresBackend,
    );
  },
};

const ADAPTERS = [REDIS_ADAPTER, POSTGRES_ADAPTER];

module.exports = {
  ADAPTERS,
  POSTGRES_ADAPTER,
  POSTGRES_IMAGE,
  REDIS_ADAPTER,
  dockerAvailable,
  postgresClient,
  startPostgres,
  waitForRedis,
};
