// TLS evidence for the PostgreSQL backend, mirroring the shape of
// test/integration-postgres.test.js (same startPostgres/startHelper/
// waitForNodeError pattern, self-contained rather than imported from it,
// matching that file's own precedent of not sharing a test-util module with
// test/integration-standalone.test.js).
//
// Three things this file proves:
//   1. A job round-trips through the Node-RED nodes over verified TLS using
//      the configured CA credential.
//   2. tlsRejectUnauthorized:true with no CA fails the connection with a
//      clear certificate error rather than silently downgrading to
//      plaintext.
//   3. The open question: does node-postgres overwrite ssl.servername with
//      the connection host when host is a hostname? Answered by reading
//      node_modules/pg/lib/connection.js directly (see the comment on the
//      "open question" test below) and demonstrated live with a minimal fake
//      PostgreSQL-TLS-negotiation server -- no Docker needed for that part,
//      so it runs unconditionally as a permanent regression proof.

const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");
const { promisify } = require("node:util");

const { Client: PgClient } = require("pg");
const helper = require("node-red-node-test-helper");
const bullNodes = require("../bull-queue");

const execFileAsync = promisify(execFile);

async function ignoreFailure(promise) {
  try {
    await promise;
  } catch {
    // best-effort test cleanup
  }
}

const TLS_CERTS_DIR = path.join(__dirname, "deployments", "tls-certs");
const DOCKERFILE = path.join(
  __dirname,
  "deployments",
  "postgres-tls",
  "Dockerfile",
);
const BUILD_CONTEXT = path.join(__dirname, "deployments");

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

// node-red-node-test-helper proxies Node.prototype.error and re-emits every
// call as "call:error"; see test/integration-postgres.test.js for the same
// pattern's rationale.
function errorLogEntries() {
  const spy = helper.log();
  return spy.args
    .map(([entry]) => entry)
    .filter((entry) => entry.level === spy.ERROR);
}

// Same rationale as test/integration-postgres.test.js's waitForBackendSettled:
// the config node's backend status starts "connecting" and only settles
// asynchronously, after helper.load() has already resolved.
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

function postgresTlsQueueConfig(id, name, postgres, extra = {}) {
  return {
    id,
    type: "bullmq-queue-server",
    name,
    backend: "postgres",
    address: "127.0.0.1",
    port: String(postgres.port),
    database: postgres.database,
    username: postgres.user,
    tls: true,
    ...extra,
  };
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

// Same readiness trap as test/integration-postgres.test.js: the entrypoint
// restarts the server mid-init, so two consecutive TCP successes are
// required before trusting "ready".
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

// Builds the fixture image (test/deployments/postgres-tls/Dockerfile), runs
// it with TLS turned on, and returns { port, user, password, database, stop }
// mirroring integration-postgres.test.js's startPostgres(). The Dockerfile
// exists (rather than a bind mount) because PostgreSQL refuses to start
// unless its private key is owned by the server user and not group/world
// readable, and a bind-mounted repo file keeps its host ownership.
async function startPostgresTls() {
  const suffix = `${process.pid}-${Date.now()}`;
  const imageTag = `bullmq-pg-tls-test-${suffix}`;
  const containerName = `bullmq-pg-tls-test-${suffix}`;
  const user = "bullmq";
  const password = "bullmqpw";
  const database = "bullmq";

  await execFileAsync("docker", [
    "build",
    "-f",
    DOCKERFILE,
    "-t",
    imageTag,
    BUILD_CONTEXT,
  ]);

  async function removeImage() {
    await ignoreFailure(execFileAsync("docker", ["rmi", "-f", imageTag]));
  }

  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--shm-size",
      "128mb",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      "127.0.0.1::5432",
      imageTag,
      "-c",
      "ssl=on",
      "-c",
      "ssl_cert_file=/etc/postgresql/tls/server.crt",
      "-c",
      "ssl_key_file=/etc/postgresql/tls/server.key",
    ]);
  } catch (err) {
    await removeImage();
    throw err;
  }

  // Independent teardown steps: a failing container removal must not skip
  // the image removal, and vice versa.
  async function stop() {
    try {
      await ignoreFailure(
        execFileAsync("docker", ["rm", "-f", "-v", containerName]),
      );
    } finally {
      await removeImage();
    }
  }

  let port;
  try {
    const { stdout } = await execFileAsync("docker", [
      "port",
      containerName,
      "5432",
    ]);
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-bullmq-pg-tls-"));
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
  "PostgreSQL backend over verified TLS: a job round-trips through the Node-RED nodes",
  { skip: skipReason },
  async () => {
    // Container first, released last -- see integration-postgres.test.js for
    // why (a leaked container is worse than a failed test).
    const postgres = await startPostgresTls();
    let userDir;

    try {
      userDir = await startHelper();
      const flow = [
        { id: "tab", type: "tab", label: "postgres tls manual ack" },
        postgresTlsQueueConfig("queue", "pgtlscasts", postgres),
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
        queue: {
          password: postgres.password,
          tlsCa: fs.readFileSync(path.join(TLS_CERTS_DIR, "ca.crt"), "utf8"),
        },
      });
      const cmd = helper.getNode("cmd");
      const addOutput = waitForInput(helper.getNode("cmd-out"));
      const completeOutput = waitForInput(helper.getNode("job-out"));
      cmd.receive({
        cmd: "add",
        payload: "postgres tls payload",
        jobopts: { removeOnComplete: true },
      });

      assert.equal((await addOutput).payload.name, "default");
      assert.equal((await completeOutput).payload, "postgres tls payload");

      const configNode = helper.getNode("queue");
      assert.equal(
        await waitForBackendSettled(configNode),
        "connected",
        "the backend must actually be connected over TLS, not merely appear to work",
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
  "PostgreSQL backend over TLS: a missing CA with tlsRejectUnauthorized on fails with a clear certificate error, not a silent plaintext downgrade",
  { skip: skipReason },
  async () => {
    const postgres = await startPostgresTls();
    let userDir;

    try {
      userDir = await startHelper();
      // tlsRejectUnauthorized defaults to true and no tlsCa credential is
      // supplied, so Node verifies the self-signed fixture cert against the
      // system trust store and must fail -- this is the negative half of
      // the quality gate: "a wrong or missing CA with tlsRejectUnauthorized
      // on fails to connect with a clear error rather than silently
      // downgrading".
      const flow = [
        { id: "tab", type: "tab", label: "postgres tls missing ca" },
        postgresTlsQueueConfig("queue", "pgtlsbadcacasts", postgres),
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

      await helper.load(bullNodes, flow, {
        queue: { password: postgres.password },
      });

      const configNode = helper.getNode("queue");
      assert.equal(
        await waitForBackendSettled(configNode),
        "disconnected",
        "an unverifiable self-signed cert must never settle as connected",
      );

      const errors = errorLogEntries();
      assert.equal(
        errors.length,
        1,
        "exactly one actionable report, not a stack trace",
      );
      assert.equal(errors[0].id, configNode.id);
      // The real message node-postgres/OpenSSL produce for this exact
      // fixture, reproduced verbatim by manually connecting a bare pg.Client
      // with { rejectUnauthorized: true } and no ca against this same
      // container -- not hand-written. Proves a genuine TLS handshake was
      // attempted and rejected, which rules out a silent plaintext fallback:
      // a plaintext connection would never reach certificate verification
      // at all.
      assert.match(
        errors[0].msg,
        /unable to verify the first certificate/,
        "must fail on certificate verification, not merely 'unreachable'",
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

// OPEN QUESTION, answered: does node-postgres overwrite ssl.servername with
// the connection host when host is a hostname, meaning tlsServerName only
// survives when host (this package's `address` field) is a literal IP?
//
// Read directly from the installed package (node_modules/pg/lib/connection.js,
// Connection.prototype.upgradeToSSL, pg@8.23.0):
//
//   if (self.ssl !== true) {
//     Object.assign(options, self.ssl)      // <- our ssl.servername lands here
//     ...
//   }
//   ...
//   const net = require('net')
//   if (net.isIP && net.isIP(host) === 0) { // <- true when `host` is NOT an IP
//     options.servername = host             // <- clobbers whatever Object.assign set
//   }
//
// `host` here is `connectionParameters.host` (client.js), i.e. exactly the
// `host` this package's normalizePostgresConfig puts on the pg pool config
// from the `address` field -- confirmed unchanged by BullMQ too:
// PostgresConnection's constructor (node_modules/bullmq/dist/cjs/postgres/
// postgres-connection.js) destructures off only schema/skipVersionCheck/
// migrate/skipMigrations and spreads the rest, host and ssl included,
// straight into `new pg.Pool(...)`.
//
// ANSWER: CONFIRMED TRUE. Whenever `address` is a hostname (net.isIP returns
// 0), node-postgres overwrites ssl.servername with that hostname regardless
// of what this package's tlsServerName set it to. tlsServerName only
// survives -- takes effect as configured -- when `address` is a literal IP
// address. For managed PostgreSQL reached through a hostname (the normal
// case for RDS/Azure/Supabase, not merely "behind a proxy"), tlsServerName
// is silently discarded and pg substitutes the connection hostname as SNI
// instead. It is usable only in the IP-address-host scenario the plan
// documents (MemoryDB-style: connecting via a literal IP but needing SNI/
// cert verification to name a different hostname).
//
// Demonstrated live below with a minimal fake PostgreSQL-over-TLS server: it
// answers the client's SSLRequest with a plain 'S' (exactly what a real
// server sends before the TLS handshake begins) and then wraps the raw
// socket in a real TLS server socket via SNICallback, which fires as soon as
// the ClientHello's SNI extension is parsed -- before certificate
// validation, so no real PostgreSQL and no valid handshake completion is
// needed to observe it. This exercises pg's real Connection/upgradeToSSL
// code path, not a reimplementation of it. No Docker required.
async function captureClientSni(host, servernameOverride) {
  const key = fs.readFileSync(path.join(TLS_CERTS_DIR, "redis.key"));
  const cert = fs.readFileSync(path.join(TLS_CERTS_DIR, "redis.crt"));
  const secureContext = tls.createSecureContext({ key, cert });

  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // The client's first bytes are always the 8-byte SSLRequest packet
    // (length=8, code=80877103); a bare 'S' is the real server's "yes,
    // upgrade to TLS" reply.
    socket.once("data", () => {
      socket.write(Buffer.from("S"));
      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
        SNICallback(servername, cb) {
          server.emit("sni", servername);
          cb(null, secureContext);
        },
      });
      tlsSocket.on("error", () => {});
    });
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: AbortSignal.timeout(3000) });
    const port = server.address().port;

    const client = new PgClient({
      host,
      port,
      user: "probe",
      password: "probe",
      database: "probe",
      // No real handshake completes past ClientHello (this fixture never
      // speaks the rest of the PostgreSQL protocol), so verification must be
      // off -- irrelevant to what is being measured, which is only the SNI
      // extension the client sends.
      ssl: { rejectUnauthorized: false, servername: servernameOverride },
    });
    client.on("error", () => {});
    const captured = once(server, "sni", {
      signal: AbortSignal.timeout(3000),
    });
    void ignoreFailure(client.connect());
    const [result] = await captured;
    // Not awaited: this fixture never speaks the rest of the PostgreSQL
    // protocol past the TLS ClientHello, so pg's Client.end() -- which
    // waits for a graceful protocol-level end -- would hang forever.
    void ignoreFailure(client.end());
    return result;
  } finally {
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
  }
}

test("open question: ssl.servername survives only when the connection host is a literal IP, not a hostname", async () => {
  const overrideName = "custom-sni.internal.example";

  const withIpHost = await captureClientSni("127.0.0.1", overrideName);
  assert.equal(
    withIpHost,
    overrideName,
    "tlsServerName must be honoured when the connection host is a literal IP",
  );

  const withHostnameHost = await captureClientSni("localhost", overrideName);
  assert.equal(
    withHostnameHost,
    "localhost",
    "node-postgres must overwrite ssl.servername with the connection host " +
      "when host is a hostname -- proving tlsServerName is silently " +
      "discarded in that case, not honoured",
  );
});
