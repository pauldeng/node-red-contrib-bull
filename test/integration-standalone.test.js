const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");
const vm = require("node:vm");

const { Queue } = require("bullmq");
const Redis = require("ioredis");
const helper = require("node-red-node-test-helper");
const bullNodes = require("../bull-queue");

const enabled = process.env.BULLMQ_INTEGRATION === "1";

function waitForInput(node, timeoutMs = 10000) {
  return waitForInputMessage(node, timeoutMs);
}

async function waitForInputMessage(node, timeoutMs) {
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

  await waitForRedis(port);

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

async function startHelper() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-bullmq-test-"));
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

function queueConfig(id, name, redis) {
  return {
    id,
    type: "bullmq-queue-server",
    name,
    deployment: "single",
    address: "127.0.0.1",
    port: String(redis.port),
  };
}

function readExampleFlow(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8"),
  );
}

function messageFromExampleFunction(flow, nodeId, msg) {
  const node = flow.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `missing example function node ${nodeId}`);
  const script = new vm.Script(`(function(msg) { ${node.func}\n})(msg)`);
  return script.runInNewContext({ msg: { ...msg } }, { timeout: 1000 });
}

async function receiveCommand(node, output, msg) {
  const result = waitForInput(output);
  node.receive(msg);
  return await result;
}

test(
  "standalone Redis flow adds, runs, and manages BullMQ v6 schedulers",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "test" },
        {
          id: "queue",
          type: "bullmq-queue-server",
          name: "basecasts",
          deployment: "single",
          address: "127.0.0.1",
          port: String(redis.port),
        },
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
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const runOut = helper.getNode("run-out");

      const addOutput = waitForInput(cmdOut);
      const runOutput = waitForInput(runOut);
      cmd.receive({
        cmd: "add",
        payload: "hello standalone redis",
        jobopts: { removeOnComplete: true },
      });

      assert.equal((await addOutput).payload.name, "default");
      assert.equal((await runOutput).payload, "hello standalone redis");

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

      const countOutput = waitForInput(cmdOut);
      cmd.receive({ cmd: "getJobSchedulersCount" });
      assert.equal((await countOutput).payload, 1);

      const getOutput = waitForInput(cmdOut);
      cmd.receive({
        cmd: "getJobScheduler",
        schedulerId: "gateway-FCC23DFFFE0AA2A8",
      });
      assert.equal((await getOutput).payload.key, "gateway-FCC23DFFFE0AA2A8");

      const removeOutput = waitForInput(cmdOut);
      cmd.receive({
        cmd: "removeJobScheduler",
        schedulerId: "gateway-FCC23DFFFE0AA2A8",
      });
      assert.equal((await removeOutput).payload, true);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "manual acknowledgement completes a BullMQ job through bullmq job",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "manual ack" },
        {
          id: "queue",
          type: "bullmq-queue-server",
          name: "manualcasts",
          deployment: "single",
          address: "127.0.0.1",
          port: String(redis.port),
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
        { id: "cmd-out", type: "helper", z: "tab", x: 360, y: 120, wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          name: "manual worker",
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
        { id: "job-out", type: "helper", z: "tab", x: 560, y: 220, wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const jobOut = helper.getNode("job-out");

      const addOutput = waitForInput(cmdOut);
      const completeOutput = waitForInput(jobOut);
      cmd.receive({
        cmd: "add",
        payload: "manual ack payload",
        jobopts: { removeOnComplete: true },
      });

      assert.equal((await addOutput).payload.name, "default");
      assert.equal((await completeOutput).payload, "manual ack payload");
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "dedicated Job Scheduler example commands work against Redis",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const example = readExampleFlow("examples/repeatable_jobs.json");
      const flow = [
        { id: "tab", type: "tab", label: "repeat example verification" },
        {
          ...example.find((node) => node.id === "queue-repeatable-jobs"),
          id: "queue",
          address: "127.0.0.1",
          port: String(redis.port),
        },
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 180,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 380, y: 120, wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const output = helper.getNode("cmd-out");

      const schedulerId = "gateway-FCC23DFFFE0AA2A8";
      const addResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-add", {
          payload: schedulerId,
        }),
      );
      assert.equal(addResult.payload.name, "default");
      assert.equal(addResult.payload.data.payload, schedulerId);

      const listResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-get-all", {}),
      );
      assert.deepEqual(
        listResult.payload.map((scheduler) => scheduler.key),
        [schedulerId],
      );

      const countResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-count", {}),
      );
      assert.equal(countResult.payload, 1);

      const getResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-get-by-key", {
          payload: schedulerId,
        }),
      );
      assert.equal(getResult.payload.key, schedulerId);
      assert.equal(getResult.payload.pattern, "30 9,19,29,39,49,59 * * * *");

      const removeResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-remove-by-key", {
          payload: schedulerId,
        }),
      );
      assert.equal(removeResult.payload, true);

      const emptyCount = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-count", {}),
      );
      assert.equal(emptyCount.payload, 0);

      await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-add", {
          payload: schedulerId,
        }),
      );
      const stopResult = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-stop-all", {}),
      );
      assert.deepEqual(stopResult.payload.removedSchedulers, [schedulerId]);
      const finalCount = await receiveCommand(
        cmd,
        output,
        messageFromExampleFunction(example, "fn-repeat-count", {}),
      );
      assert.equal(finalCount.payload, 0);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq cmd manages delayed jobs, priorities, and global rate limits",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "feature commands" },
        queueConfig("queue", "featurecasts", redis),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 180,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 380, y: 120, wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");

      const delayed = await receiveCommand(cmd, cmdOut, {
        cmd: "add",
        payload: "delayed payload",
        jobopts: { jobId: "delayed-1", delay: 60000 },
      });
      assert.equal(delayed.payload.id, "delayed-1");

      const delayedJobs = await receiveCommand(cmd, cmdOut, {
        cmd: "getDelayed",
      });
      assert.deepEqual(
        delayedJobs.payload.map((job) => job.id),
        ["delayed-1"],
      );

      const promoted = await receiveCommand(cmd, cmdOut, {
        cmd: "promoteJob",
        jobId: "delayed-1",
      });
      assert.equal(promoted.payload.id, "delayed-1");

      await receiveCommand(cmd, cmdOut, {
        cmd: "add",
        payload: "low priority",
        jobopts: { jobId: "priority-low", priority: 10 },
      });
      await receiveCommand(cmd, cmdOut, {
        cmd: "add",
        payload: "high priority",
        jobopts: { jobId: "priority-high", priority: 1 },
      });

      const prioritized = await receiveCommand(cmd, cmdOut, {
        cmd: "getPrioritized",
      });
      assert.deepEqual(prioritized.payload.map((job) => job.id).sort(), [
        "priority-high",
        "priority-low",
      ]);

      const priorityCounts = await receiveCommand(cmd, cmdOut, {
        cmd: "getCountsPerPriority",
        priorities: [1, 10],
      });
      assert.deepEqual(priorityCounts.payload, { 1: 1, 10: 1 });

      assert.equal(
        (
          await receiveCommand(cmd, cmdOut, {
            cmd: "setGlobalRateLimit",
            max: 2,
            duration: 1000,
          })
        ).payload,
        true,
      );
      assert.deepEqual(
        (
          await receiveCommand(cmd, cmdOut, {
            cmd: "getGlobalRateLimit",
          })
        ).payload,
        { max: 2, duration: 1000 },
      );
      assert.equal(
        (
          await receiveCommand(cmd, cmdOut, {
            cmd: "removeGlobalRateLimit",
          })
        ).payload,
        2,
      );
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq events reports deduplicated jobs from bullmq cmd",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "events" },
        queueConfig("queue", "eventcasts", redis),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 180,
          y: 120,
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", x: 380, y: 120, wires: [] },
        {
          id: "events",
          type: "bullmq events",
          z: "tab",
          name: "events",
          queue: "queue",
          events: "deduplicated",
          x: 180,
          y: 220,
          wires: [["events-out"]],
        },
        {
          id: "events-out",
          type: "helper",
          z: "tab",
          x: 380,
          y: 220,
          wires: [],
        },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const eventsOut = helper.getNode("events-out");
      await sleep(250);

      await receiveCommand(cmd, cmdOut, {
        cmd: "add",
        payload: "first dedupe",
        jobopts: {
          jobId: "dedupe-source",
          deduplication: { id: "dedupe-key" },
        },
      });

      const deduplicatedEvent = waitForInput(eventsOut);
      await receiveCommand(cmd, cmdOut, {
        cmd: "add",
        payload: "second dedupe",
        jobopts: {
          jobId: "dedupe-duplicate",
          deduplication: { id: "dedupe-key" },
        },
      });

      const retainedJobId = await receiveCommand(cmd, cmdOut, {
        cmd: "getDeduplicationJobId",
        deduplicationId: "dedupe-key",
      });
      assert.equal(retainedJobId.payload, "dedupe-source");

      const eventMsg = await deduplicatedEvent;
      assert.equal(eventMsg.topic, "deduplicated");
      assert.equal(eventMsg.bull.queue, "eventcasts");
      assert.equal(eventMsg.payload.deduplicationId, "dedupe-key");

      const removed = await receiveCommand(cmd, cmdOut, {
        cmd: "removeDeduplicationKey",
        deduplicationId: "dedupe-key",
      });
      assert.equal(removed.payload, 1);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq flow adds parent and child jobs through FlowProducer",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "flow producer" },
        {
          ...queueConfig("queue", "flowcasts", redis),
          removeOnComplete: "100",
          removeOnFail: "500",
        },
        {
          id: "flow",
          type: "bullmq flow",
          z: "tab",
          name: "flow",
          queue: "queue",
          x: 180,
          y: 120,
          wires: [["flow-out"]],
        },
        { id: "flow-out", type: "helper", z: "tab", x: 380, y: 120, wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const flowNode = helper.getNode("flow");
      const flowOut = helper.getNode("flow-out");

      const result = waitForInput(flowOut);
      flowNode.receive({
        payload: {
          name: "parent",
          queueName: "flowcasts",
          data: { payload: "parent payload" },
          children: [
            {
              name: "child",
              queueName: "flowcasts",
              data: { payload: "child payload" },
              opts: { removeOnFail: false },
            },
          ],
        },
        flowopts: {
          queuesOptions: {
            flowcasts: {
              defaultJobOptions: { removeOnComplete: 25 },
            },
          },
        },
      });

      const msg = await result;
      assert.equal(msg.payload.job.name, "parent");
      assert.equal(msg.payload.job.queueName, "flowcasts");
      assert.equal(msg.payload.job.opts.removeOnComplete, 25);
      assert.equal(msg.payload.job.opts.removeOnFail, 500);
      assert.equal(msg.payload.children[0].job.name, "child");
      assert.equal(msg.payload.children[0].job.queueName, "flowcasts");
      assert.equal(msg.payload.children[0].job.opts.removeOnComplete, 25);
      assert.equal(msg.payload.children[0].job.opts.removeOnFail, false);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq job cancelJob aborts each live retry attempt",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "cancel" },
        queueConfig("queue", "cancelcasts", redis),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          name: "cmd",
          queue: "queue",
          x: 180,
          y: 120,
          wires: [[]],
        },
        {
          id: "events",
          type: "bullmq events",
          z: "tab",
          name: "events",
          queue: "queue",
          events: "failed",
          x: 180,
          y: 320,
          wires: [["events-out"]],
        },
        {
          id: "events-out",
          type: "helper",
          z: "tab",
          x: 380,
          y: 320,
          wires: [],
        },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          name: "cancel worker",
          queue: "queue",
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 1,
          x: 180,
          y: 220,
          wires: [["cancel"]],
        },
        {
          id: "cancel",
          type: "bullmq job",
          z: "tab",
          name: "cancel",
          action: "cancelJob",
          x: 380,
          y: 220,
          wires: [["job-out"]],
        },
        { id: "job-out", type: "helper", z: "tab", x: 580, y: 220, wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const jobOut = helper.getNode("job-out");
      const eventsOut = helper.getNode("events-out");

      const cancelOutputs = waitForInputMessages(jobOut, 2);
      // Only ONE failed event, even though both attempts are cancelled: BullMQ
      // emits "failed" from moveToFinished, which a retryable failure never
      // reaches -- Job.moveToFailed branches to moveToDelayed/retryJob while
      // attempts remain (see node_modules/bullmq/dist/cjs/classes/job.js,
      // "Only record failed metrics when job is not retrying").
      const failedEvent = waitForInput(eventsOut);
      cmd.receive({
        cmd: "add",
        payload: "cancel me",
        jobopts: { attempts: 2, removeOnFail: false },
      });

      // Proves the arity-3 processor really did make BullMQ create and track an
      // AbortController for this job: cancelJob returns false when no
      // cancellable processor is registered.
      assert.deepEqual(
        (await cancelOutputs).map((msg) => msg.payload),
        [true, true],
      );

      // Aborting the signal does not settle the acknowledgement on its own, so
      // this event only arrives if the abort listener failed the job.
      const failed = await failedEvent;
      assert.equal(failed.topic, "failed");
      assert.match(failed.payload.failedReason, /BullMQ job cancelled/);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq job cancelAllJobs aborts every active job on its worker",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "cancel all" },
        queueConfig("queue", "cancelallcasts", redis),
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
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 2,
          wires: [["active-out"]],
        },
        {
          id: "active-out",
          type: "helper",
          z: "tab",
          wires: [],
        },
        {
          id: "cancel-all",
          type: "bullmq job",
          z: "tab",
          action: "cancelAllJobs",
          wires: [["cancel-out"]],
        },
        {
          id: "cancel-out",
          type: "helper",
          z: "tab",
          wires: [],
        },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const activeJobs = waitForInputMessages(helper.getNode("active-out"), 2);
      const cancelOutput = waitForInput(helper.getNode("cancel-out"));

      cmd.receive({
        cmd: "addBulk",
        payload: [
          { name: "first", data: { payload: "first" } },
          { name: "second", data: { payload: "second" } },
        ],
      });

      const [first] = await activeJobs;
      helper.getNode("cancel-all").receive(first);
      assert.equal((await cancelOutput).payload, true);

      const queue = helper.getNode("queue").getQueue();
      const deadline = Date.now() + 10000;
      while ((await queue.getFailedCount()) !== 2 && Date.now() < deadline) {
        await sleep(25);
      }
      assert.equal(await queue.getFailedCount(), 2);
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "worker and producer recover after Redis restarts",
  { skip: !enabled, timeout: 30000 },
  async () => {
    let redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "reconnect" },
        queueConfig("queue", "reconnectcasts", redis),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          queue: "queue",
          completionMode: "immediate",
          concurrency: 1,
          wires: [["run-out"]],
        },
        { id: "run-out", type: "helper", z: "tab", wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const cmdOut = helper.getNode("cmd-out");
      const run = helper.getNode("run");
      const runOut = helper.getNode("run-out");

      const firstAdded = waitForInput(cmdOut);
      const firstRun = waitForInput(runOut);
      cmd.receive({
        cmd: "add",
        payload: "before restart",
        jobopts: { removeOnComplete: true },
      });
      await firstAdded;
      assert.equal((await firstRun).payload, "before restart");

      const configNode = helper.getNode("queue");
      const producerConnection = configNode.getProducerConnection();
      const workerConnection = configNode.resources.get(run.worker);
      const producerClosed = once(producerConnection, "close", {
        signal: AbortSignal.timeout(5000),
      });
      const workerClosed = once(workerConnection, "close", {
        signal: AbortSignal.timeout(5000),
      });
      const port = redis.port;
      await redis.stop();
      await Promise.all([producerClosed, workerClosed]);

      const producerReady = once(producerConnection, "ready", {
        signal: AbortSignal.timeout(15000),
      });
      const workerReady = once(workerConnection, "ready", {
        signal: AbortSignal.timeout(15000),
      });
      redis = await startRedis(port);
      await Promise.all([producerReady, workerReady]);

      const secondAdded = waitForInput(cmdOut);
      const secondRun = waitForInput(runOut);
      cmd.receive({
        cmd: "add",
        payload: "after restart",
        jobopts: { removeOnComplete: true },
      });
      await secondAdded;
      assert.equal((await secondRun).payload, "after restart");
    } finally {
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "closing Node-RED with an active manual job finalizes it as failed",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();
    const queueName = "shutdowncasts";
    const inspector = new Queue(queueName, {
      connection: { host: "127.0.0.1", port: redis.port },
    });
    inspector.on("error", () => {});

    try {
      const flow = [
        { id: "tab", type: "tab", label: "active shutdown" },
        queueConfig("queue", queueName, redis),
        {
          id: "cmd",
          type: "bullmq cmd",
          z: "tab",
          queue: "queue",
          wires: [["cmd-out"]],
        },
        { id: "cmd-out", type: "helper", z: "tab", wires: [] },
        {
          id: "run",
          type: "bullmq run",
          z: "tab",
          queue: "queue",
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 1,
          wires: [["active-out"]],
        },
        { id: "active-out", type: "helper", z: "tab", wires: [] },
      ];

      await inspector.waitUntilReady();
      await helper.load(bullNodes, flow);
      const added = waitForInput(helper.getNode("cmd-out"));
      const active = waitForInput(helper.getNode("active-out"));
      helper.getNode("cmd").receive({
        cmd: "add",
        payload: "still active",
        jobopts: { removeOnFail: false },
      });
      const jobId = (await added).payload.id;
      await active;

      await helper.unload();

      const job = await inspector.getJob(jobId);
      assert.equal(await job.getState(), "failed");
      assert.match(
        job.failedReason,
        /BullMQ run node closed before acknowledgement/,
      );
    } finally {
      await inspector.close();
      await stopHelper(userDir);
      await redis.stop();
    }
  },
);

test(
  "bullmq job resumes a delayed job at the step recorded by updateData",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      // No core function node here: node-red-node-test-helper only registers
      // this package's nodes plus helper, so the step routing a real flow
      // would do with a function node is driven from the test instead.
      const flow = [
        { id: "tab", type: "tab", label: "steps" },
        queueConfig("queue", "stepcasts", redis),
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
          name: "step worker",
          queue: "queue",
          completionMode: "manual",
          ackTimeout: 300000,
          concurrency: 1,
          wires: [["activations"]],
        },
        { id: "activations", type: "helper", z: "tab", wires: [] },
        {
          id: "job",
          type: "bullmq job",
          z: "tab",
          action: "complete",
          wires: [[]],
        },
      ];

      await helper.load(bullNodes, flow);
      const cmd = helper.getNode("cmd");
      const activations = helper.getNode("activations");
      const job = helper.getNode("job");

      const bothActivations = waitForInputMessages(activations, 2);
      cmd.receive({
        cmd: "add",
        jobData: { step: "first" },
        jobopts: { attempts: 1, removeOnComplete: false },
      });

      const [first] = await waitForInputMessages(activations, 1);
      assert.equal(first.job.data.step, "first");

      // Record the next step, then delay the job instead of failing it.
      job.receive({ ...first, cmd: "updateData", jobData: { step: "second" } });
      job.receive({ ...first, cmd: "moveToDelayed", delay: 50 });

      const [, second] = await bothActivations;
      // Only reachable if the lock token really moved the job to delayed
      // rather than failing it, and updateData survived the transition.
      assert.equal(second.job.data.step, "second");
      assert.equal(
        second.job.attemptsMade,
        0,
        "a step transition must not count as a retry",
      );

      job.receive({ ...second, cmd: "complete", payload: "done" });
    } finally {
      await stopHelper(userDir);
      redis.stop();
    }
  },
);

test(
  "bullmq flow addBulk creates trees across separate queues atomically",
  { skip: !enabled },
  async () => {
    const redis = await startRedis();
    const userDir = await startHelper();

    try {
      const flow = [
        { id: "tab", type: "tab", label: "bulk" },
        queueConfig("queue", "bulkcasts", redis),
        {
          id: "flow",
          type: "bullmq flow",
          z: "tab",
          queue: "queue",
          wires: [["flow-out"]],
        },
        { id: "flow-out", type: "helper", z: "tab", wires: [] },
      ];

      await helper.load(bullNodes, flow);
      const flowNode = helper.getNode("flow");
      const flowOut = helper.getNode("flow-out");

      const added = waitForInput(flowOut);
      flowNode.receive({
        payload: [
          { name: "one", queueName: "bulk-a", data: { n: 1 } },
          { name: "two", queueName: "bulk-b", data: { n: 2 } },
        ],
      });

      const msg = await added;
      assert.equal(msg.payload.length, 2);

      // Both queues really got their job, which is what addBulk buys over two
      // separate add() calls.
      const client = new Redis({
        host: "127.0.0.1",
        port: redis.port,
        maxRetriesPerRequest: null,
      });
      client.on("error", () => {});
      try {
        assert.equal(await client.llen("bull:bulk-a:wait"), 1);
        assert.equal(await client.llen("bull:bulk-b:wait"), 1);
      } finally {
        client.disconnect();
      }
    } finally {
      await stopHelper(userDir);
      redis.stop();
    }
  },
);
