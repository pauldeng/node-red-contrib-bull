// First live evidence for the PostgreSQL backend (Phase 3 wiring): a real
// round trip through the Node-RED nodes against a real PostgreSQL container,
// not against raw BullMQ. Mirrors the shape of
// test/integration-standalone.test.js's Redis fixtures and its "manual
// acknowledgement completes a BullMQ job through bullmq job" test.

const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");
const { promisify } = require("node:util");

const { Client: PgClient } = require("pg");
const helper = require("node-red-node-test-helper");
const bullNodes = require("../bull-queue");

const execFileAsync = promisify(execFile);

const POSTGRES_IMAGE = "postgres:17-alpine";

const enabled = process.env.BULLMQ_INTEGRATION_POSTGRES === "1";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Computed once, lazily, so a disabled run never even shells out to docker.
let skipReason;
if (!enabled) {
  skipReason = "set BULLMQ_INTEGRATION_POSTGRES=1 to run";
} else if (!dockerAvailable()) {
  skipReason = "Docker is not available";
}

async function waitForInput(node, timeoutMs = 10000) {
  const [msg] = await once(node, "input", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return msg;
}

async function pgIsReadyOnce(port, user, database) {
  try {
    await execFileAsync("pg_isready", [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
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
// ready, and the restart drops the connection moments later. Probing over
// TCP (rather than the Unix socket, the only listener during init) and
// requiring two consecutive successes catches the restart: a probe made
// during it fails and resets the streak.
async function waitForPostgresReady(port, user, database, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await pgIsReadyOnce(port, user, database)) {
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

// Runs the official image in Docker and returns { port, stop }, mirroring
// integration-standalone.test.js's startRedis().
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

  async function stop() {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
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
    await waitForPostgresReady(port, user, database);
  } catch (err) {
    await stop();
    throw err;
  }

  return { port, user, password, database, stop };
}

async function startHelper() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-bullmq-pg-"));
  helper.init(require.resolve("node-red"), {
    userDir,
    flowFile: "flows.json",
    credentialSecret: false,
    logging: { console: { level: "fatal" } },
  });
  await helper.startServer();
  return userDir;
}

async function stopHelper(userDir) {
  await helper.unload();
  await helper.stopServer();
  fs.rmSync(userDir, { recursive: true, force: true });
}

test(
  "PostgreSQL backend: manual acknowledgement round-trips a job through the Node-RED nodes",
  { skip: skipReason },
  async () => {
    // The container is started first and released last: startHelper() can throw
    // (port conflict, mkdtemp failure), and a leaked postgres container is
    // worse than a failed test. Each teardown gets its own guard so one
    // failing cannot skip the other.
    const postgres = await startPostgres();
    let userDir;

    try {
      userDir = await startHelper();
      // No schema field: leaving it unset is what proves BullMQ's own
      // DEFAULT_SCHEMA ("bullmq") is what migrate actually creates.
      const flow = [
        { id: "tab", type: "tab", label: "postgres manual ack" },
        {
          id: "queue",
          type: "bullmq-queue-server",
          name: "pgcasts",
          backend: "postgres",
          address: "127.0.0.1",
          port: String(postgres.port),
          database: postgres.database,
          username: postgres.user,
        },
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 160,
          y: 120,
          wires: [["cmd-out"]],
        },
        {
          id: "cmd-out",
          type: "helper",
          z: "tab",
          x: 360,
          y: 120,
          wires: [],
        },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          name: "postgres worker",
          queue: "queue",
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 1,
          x: 160,
          y: 220,
          wires: [["complete"]],
        },
        {
          id: "complete",
          type: "bullmq job",
          z: "tab",
          name: "complete",
          action: "complete",
          x: 360,
          y: 220,
          wires: [["job-out"]],
        },
        {
          id: "job-out",
          type: "helper",
          z: "tab",
          x: 560,
          y: 220,
          wires: [],
        },
      ];

      await helper.load(bullNodes, flow, {
        queue: { password: postgres.password },
      });
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const jobOut = helper.getNode("job-out");

      const addOutput = waitForInput(cmdOut);
      const completeOutput = waitForInput(jobOut);
      cmd.receive({
        cmd: "add",
        payload: "postgres manual ack payload",
        jobopts: { removeOnComplete: true },
      });

      assert.equal((await addOutput).payload.name, "default");
      assert.equal(
        (await completeOutput).payload,
        "postgres manual ack payload",
      );

      // Cheapest possible proof that migrate ran and the schema option is
      // honoured: BullMQ's migrator only issues `CREATE SCHEMA IF NOT
      // EXISTS` for the namespace it was told to use, defaulting to
      // "bullmq" when the config carries no schema at all -- exactly what
      // this flow's config node does.
      const client = new PgClient({
        host: "127.0.0.1",
        port: postgres.port,
        user: postgres.user,
        password: postgres.password,
        database: postgres.database,
      });
      await client.connect();
      try {
        const { rows } = await client.query(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
          ["bullmq"],
        );
        assert.deepEqual(
          rows.map((row) => row.schema_name),
          ["bullmq"],
          "BullMQ's migrator must have created the default 'bullmq' schema",
        );
      } finally {
        await client.end();
      }
    } finally {
      try {
        if (userDir) {
          await stopHelper(userDir);
        }
      } finally {
        await postgres.stop();
      }
    }
  },
);
