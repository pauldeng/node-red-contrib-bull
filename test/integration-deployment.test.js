const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");

const { metrics, trace } = require("@opentelemetry/api");
const helper = require("node-red-node-test-helper");
const bullNodes = require("../bull-queue");

const enabled = process.env.BULLMQ_EXTERNAL_REDIS === "1";

function envBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function queueName() {
  const deployment = process.env.BULLMQ_DEPLOYMENT_NAME || "external";
  return `basecasts-${deployment}-${process.pid}-${Date.now()}`;
}

function externalQueueNode(name, id = "queue") {
  const mode = process.env.BULLMQ_REDIS_MODE || "single";
  return {
    id,
    type: "bullmq-queue-server",
    name,
    deployment: mode,
    address: process.env.BULLMQ_HOST || "127.0.0.1",
    port: process.env.BULLMQ_PORT || "6379",
    clusterNodes: process.env.BULLMQ_CLUSTER_NODES || "",
    sentinels: process.env.BULLMQ_SENTINELS || "",
    sentinelMasterName: process.env.BULLMQ_SENTINEL_MASTER_NAME || "",
    username: process.env.BULLMQ_USERNAME || "",
    sentinelUsername: process.env.BULLMQ_SENTINEL_USERNAME || "",
    tls: envBoolean("BULLMQ_TLS", false),
    sentinelTls: envBoolean("BULLMQ_SENTINEL_TLS", false),
    tlsRejectUnauthorized: envBoolean("BULLMQ_TLS_REJECT_UNAUTHORIZED", true),
    prefix: process.env.BULLMQ_QUEUE_PREFIX || "",
  };
}

function externalCredentials(...ids) {
  const credentials = {
    password: process.env.BULLMQ_PASSWORD || "",
    sentinelPassword: process.env.BULLMQ_SENTINEL_PASSWORD || "",
  };
  return {
    ...Object.fromEntries(ids.map((id) => [id, credentials])),
  };
}

async function waitForInput(node, timeoutMs = 10000) {
  const [msg] = await once(node, "input", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return msg;
}

function waitForInputMessages(node, count, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timeout = setTimeout(() => {
      node.removeListener("input", receive);
      reject(new Error(`Timed out waiting for ${count} input messages`));
    }, timeoutMs);
    function receive(msg) {
      messages.push(msg);
      if (messages.length === count) {
        clearTimeout(timeout);
        node.removeListener("input", receive);
        resolve(messages);
      }
    }
    node.on("input", receive);
  });
}

async function startHelper() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-bullmq-deploy-"));
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

function installTelemetryRecorder() {
  const spans = [];
  const metricRecords = [];
  trace.setGlobalTracerProvider({
    getTracer() {
      return {
        startSpan(name) {
          spans.push(name);
          return {
            setAttribute() {},
            setAttributes() {},
            addEvent() {},
            recordException() {},
            end() {},
          };
        },
      };
    },
  });
  metrics.setGlobalMeterProvider({
    getMeter() {
      return {
        createCounter(name) {
          return { add: (value) => metricRecords.push([name, value]) };
        },
        createHistogram(name) {
          return { record: (value) => metricRecords.push([name, value]) };
        },
        createGauge(name) {
          return { record: (value) => metricRecords.push([name, value]) };
        },
      };
    },
  });
  return { spans, metricRecords };
}

test(
  "external Redis deployment verifies scheduling, cancellation, and telemetry",
  { skip: !enabled },
  async () => {
    const telemetry = installTelemetryRecorder();
    const name = queueName();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "deployment" },
        { ...externalQueueNode(name), telemetry: true, telemetryMetrics: true },
        externalQueueNode(`${name}-cancel`, "cancel-queue"),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 360,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 560, y: 120, wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          name: "run",
          queue: "queue",
          completionMode: "immediate",
          ackTimeout: 300000,
          concurrency: 1,
          x: 360,
          y: 220,
          wires: [["run-out"]],
        },
        { id: "run-out", type: "helper", z: "tab", x: 560, y: 220, wires: [] },
        {
          id: "cancel-cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "cancel-queue",
          wires: [[]],
        },
        {
          id: "cancel-run",
          type: "bullmq run",
          z: "tab",
          queue: "cancel-queue",
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 2,
          wires: [["active-out"]],
        },
        { id: "active-out", type: "helper", z: "tab", wires: [] },
        {
          id: "cancel-one",
          type: "bullmq job",
          z: "tab",
          action: "cancelJob",
          wires: [["cancel-one-out"]],
        },
        { id: "cancel-one-out", type: "helper", z: "tab", wires: [] },
        {
          id: "cancel-all",
          type: "bullmq job",
          z: "tab",
          action: "cancelAllJobs",
          wires: [["cancel-all-out"]],
        },
        { id: "cancel-all-out", type: "helper", z: "tab", wires: [] },
      ];

      await helper.load(
        bullNodes,
        flow,
        externalCredentials("queue", "cancel-queue"),
      );
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const runOut = helper.getNode("run-out");

      const addOutput = waitForInput(cmdOut);
      const runOutput = waitForInput(runOut);
      cmd.receive({
        cmd: "add",
        payload: "docker deployment payload",
        jobopts: { removeOnComplete: true },
      });

      assert.equal((await addOutput).payload.name, "default");
      assert.equal((await runOutput).payload, "docker deployment payload");
      const telemetryDeadline = Date.now() + 5000;
      while (
        !telemetry.metricRecords.some(
          ([metricName]) => metricName === "bullmq.jobs.completed",
        ) &&
        Date.now() < telemetryDeadline
      ) {
        await sleep(25);
      }
      assert.ok(telemetry.spans.some((name) => name.startsWith("add ")));
      assert.ok(telemetry.spans.some((name) => name.startsWith("process ")));
      assert.ok(
        telemetry.metricRecords.some(
          ([name]) => name === "bullmq.jobs.completed",
        ),
      );
      assert.ok(
        telemetry.metricRecords.some(
          ([name]) => name === "bullmq.job.duration",
        ),
      );

      const scheduleOutput = waitForInput(cmdOut);
      cmd.receive({
        cmd: "upsertJobScheduler",
        schedulerId: "gateway-FCC23DFFFE0AA2A8",
        repeat: { pattern: "30 9,19,29,39,49,59 * * * *", tz: "UTC" },
        template: {
          name: "default",
          data: { payload: "gateway-FCC23DFFFE0AA2A8" },
          opts: { removeOnComplete: true },
        },
      });
      assert.equal((await scheduleOutput).payload.name, "default");

      const getOutput = waitForInput(cmdOut);
      cmd.receive({
        cmd: "getJobScheduler",
        schedulerId: "gateway-FCC23DFFFE0AA2A8",
      });
      const scheduler = (await getOutput).payload;
      assert.equal(scheduler.key, "gateway-FCC23DFFFE0AA2A8");
      if (scheduler.next) {
        const next = new Date(scheduler.next);
        assert.equal(next.getSeconds(), 30);
        assert.ok([9, 19, 29, 39, 49, 59].includes(next.getMinutes()));
      }

      const removeOutput = waitForInput(cmdOut);
      cmd.receive({
        cmd: "removeJobScheduler",
        schedulerId: "gateway-FCC23DFFFE0AA2A8",
      });
      assert.equal((await removeOutput).payload, true);

      const cancelCmd = helper.getNode("cancel-cmd");
      const activeOut = helper.getNode("active-out");
      const cancelOne = helper.getNode("cancel-one");
      const retryCancellations = waitForInputMessages(
        helper.getNode("cancel-one-out"),
        2,
      );
      const cancelEachAttempt = (msg) => cancelOne.receive(msg);
      activeOut.on("input", cancelEachAttempt);
      cancelCmd.receive({
        cmd: "add",
        payload: "cancel every attempt",
        jobopts: { attempts: 2, removeOnFail: false },
      });
      assert.deepEqual(
        (await retryCancellations).map((msg) => msg.payload),
        [true, true],
      );
      activeOut.removeListener("input", cancelEachAttempt);

      const activeBatch = waitForInputMessages(activeOut, 2);
      const cancelAllOutput = waitForInput(helper.getNode("cancel-all-out"));
      cancelCmd.receive({
        cmd: "addBulk",
        payload: [
          { name: "first", data: { payload: "first" } },
          { name: "second", data: { payload: "second" } },
        ],
      });
      const [firstActive] = await activeBatch;
      helper.getNode("cancel-all").receive(firstActive);
      assert.equal((await cancelAllOutput).payload, true);

      const cancelQueue = helper.getNode("cancel-queue").getQueue();
      const failedDeadline = Date.now() + 10000;
      while (
        (await cancelQueue.getFailedCount()) !== 3 &&
        Date.now() < failedDeadline
      ) {
        await sleep(25);
      }
      assert.equal(await cancelQueue.getFailedCount(), 3);
    } finally {
      await stopHelper(userDir);
    }
  },
);
