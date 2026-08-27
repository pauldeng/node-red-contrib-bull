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
const {
  DEFAULT_SCHEMA,
  LATEST_SCHEMA_VERSION,
  SchemaMigrationRequiredError,
} = require("bullmq");
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

// node-red-node-test-helper proxies Node.prototype.error (among others) and
// re-emits every call as "call:error" on the node instance itself, so a
// node.error(err, msg) inside the node under test surfaces here the same way
// waitForInput observes node.send(). Bounded like waitForInput: a timeout
// proves "no error observed within the window", which is exactly what
// "stays usable" (does not hang) requires -- not "never happens".
async function waitForNodeError(node, timeoutMs = 10000) {
  const [call] = await once(node, "call:error", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return call.args[0];
}

// The config node's backend readiness starts "connecting" and settles to
// "connected"/"disconnected" only after a real round trip to PostgreSQL
// (schema check or migration), asynchronously and after helper.load() has
// already resolved -- so tests must wait for it rather than read it right
// after deploy. Registers the reader before checking status (so an
// already-settled status is not missed) and defers acting on a
// synchronously-delivered read until the subscription's own return value is
// assigned, since readBackendStatus() calls back immediately with the
// current status.
function waitForBackendSettled(configNode, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for the backend status to leave "connecting"`,
        ),
      );
    }, timeoutMs);
    const stop = configNode.readBackendStatus((status) => {
      if (status === "connecting") {
        return;
      }
      queueMicrotask(() => {
        clearTimeout(timer);
        stop();
        resolve(status);
      });
    });
  });
}

// Every ERROR-level node.error/node.warn(...) call recorded by
// node-red-node-test-helper's log spy since the most recent helper.load().
function errorLogEntries() {
  const spy = helper.log();
  return spy.args
    .map(([entry]) => entry)
    .filter((entry) => entry.level === spy.ERROR);
}

function postgresQueueConfig(id, name, postgres, extra = {}) {
  return {
    id,
    type: "bullmq-queue-server",
    name,
    backend: "postgres",
    address: "127.0.0.1",
    port: String(postgres.port),
    database: postgres.database,
    username: postgres.user,
    ...extra,
  };
}

function postgresClient(postgres) {
  return new PgClient({
    host: "127.0.0.1",
    port: postgres.port,
    user: postgres.user,
    password: postgres.password,
    database: postgres.database,
  });
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
      const client = postgresClient(postgres);
      await client.connect();
      try {
        const { rows } = await client.query(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
          [DEFAULT_SCHEMA],
        );
        assert.deepEqual(
          rows.map((row) => row.schema_name),
          [DEFAULT_SCHEMA],
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

test(
  "PostgreSQL backend: a redeploy performs no schema change",
  { skip: skipReason },
  async () => {
    const postgres = await startPostgres();
    let userDir;
    let client;

    try {
      userDir = await startHelper();
      client = postgresClient(postgres);
      await client.connect();

      const flow = [
        { id: "tab", type: "tab", label: "postgres redeploy" },
        postgresQueueConfig("queue", "redeploycasts", postgres),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          x: 160,
          y: 120,
          wires: [[]],
        },
      ];
      const credentials = { queue: { password: postgres.password } };

      async function deployAndReadLedger() {
        await helper.load(bullNodes, flow, credentials);
        const status = await waitForBackendSettled(helper.getNode("queue"));
        assert.equal(status, "connected");
        const { rows } = await client.query(
          `SELECT version, name, applied_at FROM "${DEFAULT_SCHEMA}".migration ORDER BY version`,
        );
        return rows.map((row) => ({
          version: row.version,
          name: row.name,
          appliedAt: row.applied_at.toISOString(),
        }));
      }

      const firstDeploy = await deployAndReadLedger();
      assert.ok(
        firstDeploy.length > 0,
        "the first deploy must have recorded at least one applied migration",
      );

      // Tear the flow down (closes the config node -> closes the queue's
      // PostgresConnection) and deploy the identical flow again -- a redeploy
      // in everything but Node-RED's own deploy button.
      await helper.unload();

      const secondDeploy = await deployAndReadLedger();

      assert.deepEqual(
        secondDeploy,
        firstDeploy,
        "a redeploy must not touch the schema version ledger -- same rows, same applied_at",
      );
    } finally {
      try {
        if (client) {
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
    }
  },
);

test(
  "PostgreSQL backend: migrations off against a never-migrated database reports the actionable schema error and stays usable",
  { skip: skipReason },
  async () => {
    const postgres = await startPostgres();
    let userDir;

    try {
      userDir = await startHelper();
      const flow = [
        { id: "tab", type: "tab", label: "postgres migrate off" },
        postgresQueueConfig("queue", "migrateoffcasts", postgres, {
          migrate: false,
        }),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          x: 160,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 360, y: 120, wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          queue: "queue",
          completionMode: "immediate",
          concurrency: 1,
          x: 160,
          y: 220,
          wires: [[]],
        },
        {
          id: "events",
          type: "bullmq events",
          z: "tab",
          queue: "queue",
          x: 160,
          y: 320,
          wires: [[]],
        },
        {
          id: "flow",
          type: "bullmq flow",
          z: "tab",
          queue: "queue",
          x: 160,
          y: 420,
          wires: [[]],
        },
      ];

      await helper.load(bullNodes, flow, {
        queue: { password: postgres.password },
      });

      const configNode = helper.getNode("queue");
      const status = await waitForBackendSettled(configNode);
      assert.equal(
        status,
        "disconnected",
        "an unmigrated schema with migrations off must not settle as connected",
      );

      const cmd = helper.getNode("cmd");
      const run = helper.getNode("run");
      const events = helper.getNode("events");
      const flowNode = helper.getNode("flow");
      const readiness = await Promise.allSettled([
        cmd.bullConn.queue.waitUntilReady(),
        run.worker.waitUntilReady(),
        events.queueEvents.waitUntilReady(),
        flowNode.flowProducer.waitUntilReady(),
      ]);
      assert.ok(
        readiness.every((result) => result.status === "rejected"),
        "all four independently created backends must observe the unmigrated schema",
      );
      const errors = errorLogEntries();
      assert.equal(
        errors.length,
        1,
        "exactly one actionable report, not a stack trace",
      );
      assert.equal(errors[0].id, configNode.id);
      // BullMQ's own real message (built from the exported error class rather
      // than reproduced by hand) plus this package's actionable suffix. The
      // suffix is matched on its distinctive part so rewording the sentence
      // does not require editing a duplicated copy of it here.
      assert.ok(
        errors[0].msg.startsWith(
          new SchemaMigrationRequiredError(DEFAULT_SCHEMA).message,
        ),
        `report must carry BullMQ's own message, got: ${errors[0].msg}`,
      );
      assert.match(errors[0].msg, /"migrate" property/);
      assert.doesNotMatch(errors[0].msg, /\n\s+at /, "not a stack trace");

      const client = postgresClient(postgres);
      await client.connect();
      try {
        const { rows } = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'migration'",
          [DEFAULT_SCHEMA],
        );
        assert.equal(
          rows.length,
          0,
          "the database must genuinely never have been migrated",
        );
      } finally {
        await client.end();
      }

      // Stays usable: a later command must settle -- as an error surfaced
      // through this node's own node.error(err, msg), same as any other
      // rejected msg.cmd -- rather than hang. Bounded, so this proves
      // "settled within the window", not "can never hang".
      cmd.receive({ cmd: "add", payload: "should not hang" });
      const err = await waitForNodeError(cmd);
      assert.ok(
        err,
        "the add command must fail with an error, not hang silently",
      );
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

test(
  "PostgreSQL backend: a custom schema is used end to end, and a blank schema still defaults to bullmq",
  { skip: skipReason },
  async () => {
    // migrator.js runs `CREATE SCHEMA IF NOT EXISTS` for whatever schema it is
    // told, so a custom schema is a config value against one plain container --
    // no dedicated fixture needed. Both halves share the one container to keep
    // this to a single docker run.
    const postgres = await startPostgres();
    let userDir;

    try {
      userDir = await startHelper();

      // Half 1: a custom schema, used end to end -- the job itself must land
      // in that schema's `job` table, not just the schema existing.
      const customSchema = "custom_ns";
      const customFlow = [
        { id: "tab", type: "tab", label: "postgres custom schema" },
        postgresQueueConfig("queue", "customschemacasts", postgres, {
          schema: customSchema,
        }),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          x: 160,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 360, y: 120, wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
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
          action: "complete",
          x: 360,
          y: 220,
          wires: [["job-out"]],
        },
        { id: "job-out", type: "helper", z: "tab", x: 560, y: 220, wires: [] },
      ];

      await helper.load(bullNodes, customFlow, {
        queue: { password: postgres.password },
      });

      const cmd = helper.getNode("cmd");
      const addOutput = waitForInput(helper.getNode("cmd-out"));
      const completeOutput = waitForInput(helper.getNode("job-out"));
      cmd.receive({
        cmd: "add",
        payload: "custom schema payload",
        // No removeOnComplete: the row must still be there to query after
        // completion.
      });
      const jobId = (await addOutput).payload.id;
      assert.equal((await completeOutput).payload, "custom schema payload");

      await helper.unload();

      const client = postgresClient(postgres);
      await client.connect();
      try {
        const { rows: customRows } = await client.query(
          `SELECT queue, state, data FROM "${customSchema}".job WHERE id = $1`,
          [jobId],
        );
        assert.equal(
          customRows.length,
          1,
          "the completed job must be a real row in the custom schema's job table",
        );
        assert.equal(customRows[0].queue, "customschemacasts");
        assert.equal(customRows[0].state, "completed");
        assert.equal(customRows[0].data.payload, "custom schema payload");

        // Half 2: no schema field at all -- must default to "bullmq", and the
        // job must land there too, not merely a schema of that name existing.
        const blankSchemaFlow = [
          { id: "tab", type: "tab", label: "postgres blank schema" },
          postgresQueueConfig("queue", "blankschemacasts", postgres),
          {
            id: "cmd",
            type: "bullmq cmd",
            z: "tab",
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
        ];

        await helper.load(bullNodes, blankSchemaFlow, {
          queue: { password: postgres.password },
        });

        const blankCmd = helper.getNode("cmd");
        const blankAddOutput = waitForInput(helper.getNode("cmd-out"));
        blankCmd.receive({
          cmd: "add",
          payload: "blank schema payload",
          jobopts: { removeOnComplete: true },
        });
        const blankJobId = (await blankAddOutput).payload.id;

        const { rows: defaultRows } = await client.query(
          `SELECT queue, data FROM "${DEFAULT_SCHEMA}".job WHERE id = $1`,
          [blankJobId],
        );
        assert.equal(
          defaultRows.length,
          1,
          "a blank schema field must land the job in BullMQ's default schema",
        );
        assert.equal(defaultRows[0].queue, "blankschemacasts");
        assert.equal(defaultRows[0].data.payload, "blank schema payload");
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

test(
  "PostgreSQL backend: four independently created backends migrate a fresh database exactly once",
  { skip: skipReason },
  async () => {
    // createPostgresBackend builds a fresh PostgresConnection per call, so the
    // queue, worker, events and flow resources each run `migrate` on their own
    // first waitUntilReady() against a database that has never been migrated.
    // BullMQ serialises them with a transaction-scoped advisory lock; the
    // requirement is idempotence across those independent backends, not a
    // single call. If the lock did not hold, this is where duplicate ledger
    // rows or a migration error would show up.
    const postgres = await startPostgres();
    let userDir;

    try {
      userDir = await startHelper();
      const flow = [
        { id: "tab", type: "tab", label: "postgres concurrent migrate" },
        postgresQueueConfig("queue", "migraterace", postgres),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          wires: [[]],
        },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          queue: "queue",
          completionMode: "immediate",
          concurrency: 1,
          wires: [[]],
        },
        {
          id: "events",
          type: "bullmq events",
          z: "tab",
          queue: "queue",
          wires: [[]],
        },
        {
          id: "flow",
          type: "bullmq flow",
          z: "tab",
          queue: "queue",
          wires: [[]],
        },
      ];

      await helper.load(bullNodes, flow, {
        queue: { password: postgres.password },
      });

      const configNode = helper.getNode("queue");
      assert.equal(await waitForBackendSettled(configNode), "connected");

      const readiness = await Promise.allSettled([
        helper.getNode("cmd").bullConn.queue.waitUntilReady(),
        helper.getNode("run").worker.waitUntilReady(),
        helper.getNode("events").queueEvents.waitUntilReady(),
        helper.getNode("flow").flowProducer.waitUntilReady(),
      ]);
      assert.ok(
        readiness.every((result) => result.status === "fulfilled"),
        `all four backends must become ready: ${JSON.stringify(
          readiness.map((r) =>
            r.status === "rejected" ? String(r.reason) : "ok",
          ),
        )}`,
      );
      assert.deepEqual(errorLogEntries(), []);

      const client = postgresClient(postgres);
      await client.connect();
      try {
        const { rows } = await client.query(
          `SELECT version FROM "${DEFAULT_SCHEMA}".migration ORDER BY version`,
        );
        const versions = rows.map((row) => Number(row.version));
        assert.deepEqual(
          versions,
          [...new Set(versions)],
          "a migration must be recorded once, not once per backend that raced for it",
        );
        assert.equal(
          versions.at(-1),
          LATEST_SCHEMA_VERSION,
          "the ledger must reach the schema version this BullMQ ships",
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
