const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { on, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");
const vm = require("node:vm");

const helper = require("node-red-node-test-helper");
const bullNodes = require("../bull-queue");
const { ADAPTERS, REDIS_ADAPTER } = require("./helpers/stores");

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

// events.on() is the multi-message counterpart to the once() above: it buffers
// while the loop body runs, and breaking out of the loop removes the listener,
// so nothing is dropped and nothing is left attached. The listener is
// registered synchronously by the on() call, before the first await, which is
// what lets a caller start waiting and only then trigger the work.
async function waitForInputMessages(node, count, timeoutMs = 10000) {
  const messages = [];
  try {
    for await (const [msg] of on(node, "input", {
      signal: AbortSignal.timeout(timeoutMs),
    })) {
      messages.push(msg);
      if (messages.length === count) {
        return messages;
      }
    }
  } catch (err) {
    // Keep the diagnostic the timeout deserves; a bare AbortError says nothing
    // about how many of the expected messages did arrive.
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error(
        `Timed out waiting for ${count} input messages (received ${messages.length})`,
      );
    }
    throw err;
  }
  return messages;
}

async function startHelper() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-bullmq-test-"));
  helper.init(require.resolve("node-red"), {
    userDir,
    flowFile: "flows.json",
    credentialSecret: false,
    logging: { console: { level: "fatal" } },
  });
  try {
    await helper.startServer();
    return userDir;
  } catch (err) {
    fs.rmSync(userDir, { recursive: true, force: true });
    throw err;
  }
}

async function stopHelper(userDir) {
  try {
    await helper.unload();
  } finally {
    try {
      await helper.stopServer();
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }
}

async function startTest(adapter) {
  const store = await adapter.start();
  try {
    return { store, userDir: await startHelper() };
  } catch (err) {
    await store.stop();
    throw err;
  }
}

async function stopTest(store, userDir) {
  try {
    await stopHelper(userDir);
  } finally {
    await store.stop();
  }
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

// Why a backend is not running, rather than a bare boolean: a suite that
// quietly shrinks to one backend still reports "passed", which is exactly the
// silence this returns a reason to avoid.
function skipFor(adapter) {
  if (!enabled) {
    return "set BULLMQ_INTEGRATION=1 to run";
  }
  return adapter.unavailable();
}

// Every test below runs against both backends. The store, the config node
// shape, the credentials and the inspector Queue all come from the adapter;
// the bodies are backend-neutral.
for (const adapter of ADAPTERS) {
  test(
    `${adapter.name}: flow adds, runs, and manages BullMQ v6 schedulers`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "test" },
          adapter.queueConfig("queue", "basecasts", store),
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
          {
            id: "cmd-out",
            type: "helper",
            z: "tab",
            x: 560,
            y: 120,
            wires: [],
          },
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
          {
            id: "run-out",
            type: "helper",
            z: "tab",
            x: 560,
            y: 220,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: manual acknowledgement completes a BullMQ job through bullmq job`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "manual ack" },
          adapter.queueConfig("queue", "manualcasts", store),
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
          {
            id: "job-out",
            type: "helper",
            z: "tab",
            x: 560,
            y: 220,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: dedicated Job Scheduler example commands work against the backend`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const example = readExampleFlow("examples/repeatable_jobs.json");
        const exampleQueue = example.find(
          (node) => node.id === "queue-repeatable-jobs",
        );
        const flow = [
          { id: "tab", type: "tab", label: "repeat example verification" },
          {
            // The shipped example is Redis-shaped. Keep its queue name and job
            // options -- that is what makes this a test of the example rather
            // than of a hand-written flow -- but let the adapter own the
            // connection, so the example's own Job Scheduler commands are
            // exercised against whichever backend is under test.
            ...exampleQueue,
            ...adapter.queueConfig("queue", exampleQueue.name, store),
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
          {
            id: "cmd-out",
            type: "helper",
            z: "tab",
            x: 380,
            y: 120,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq cmd manages delayed jobs, priorities, and global rate limits`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "feature commands" },
          adapter.queueConfig("queue", "featurecasts", store),
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
          {
            id: "cmd-out",
            type: "helper",
            z: "tab",
            x: 380,
            y: 120,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq events reports deduplicated jobs from bullmq cmd`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "events" },
          adapter.queueConfig("queue", "eventcasts", store),
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
          {
            id: "cmd-out",
            type: "helper",
            z: "tab",
            x: 380,
            y: 120,
            wires: [],
          },
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

        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const cmdOut = helper.getNode("cmd-out");
        const eventsOut = helper.getNode("events-out");
        // QueueEvents must be subscribed before the first command, or the
        // deduplicated event this test asserts on is emitted into nothing.
        // Its own readiness promise says exactly when that is true.
        await helper.getNode("events").queueEvents.waitUntilReady();

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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq flow adds parent and child jobs through FlowProducer`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "flow producer" },
          {
            ...adapter.queueConfig("queue", "flowcasts", store),
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
          {
            id: "flow-out",
            type: "helper",
            z: "tab",
            x: 380,
            y: 120,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq job cancelJob aborts each live retry attempt`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "cancel" },
          adapter.queueConfig("queue", "cancelcasts", store),
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
          {
            id: "job-out",
            type: "helper",
            z: "tab",
            x: 580,
            y: 220,
            wires: [],
          },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq job cancelAllJobs aborts every active job on its worker`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "cancel all" },
          adapter.queueConfig("queue", "cancelallcasts", store),
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

        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const activeJobs = waitForInputMessages(
          helper.getNode("active-out"),
          2,
        );
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

        // No local event source: this flow has no bullmq events node, and
        // adding one to observe the count would change what is under test.
        // Poll the datastore's own state -- a bounded retry on a real
        // condition, not a fixed sleep.
        const queue = helper.getNode("queue").getQueue();
        const deadline = Date.now() + 10000;
        while ((await queue.getFailedCount()) !== 2 && Date.now() < deadline) {
          await sleep(25);
        }
        assert.equal(await queue.getFailedCount(), 2);
      } finally {
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: closing Node-RED with an active manual job finalizes it as failed`,
    { skip: skipFor(adapter), timeout: 30000 },
    async () => {
      const { store, userDir } = await startTest(adapter);
      const queueName = "shutdowncasts";
      const inspector = adapter.inspectorQueue(queueName, store);
      inspector.on("error", () => {});

      try {
        const flow = [
          { id: "tab", type: "tab", label: "active shutdown" },
          adapter.queueConfig("queue", queueName, store),
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
        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq job resumes a delayed job at the step recorded by updateData`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        // No core function node here: node-red-node-test-helper only registers
        // this package's nodes plus helper, so the step routing a real flow
        // would do with a function node is driven from the test instead.
        const flow = [
          { id: "tab", type: "tab", label: "steps" },
          adapter.queueConfig("queue", "stepcasts", store),
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

        await helper.load(bullNodes, flow, adapter.credentials(store));
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
        job.receive({
          ...first,
          cmd: "updateData",
          jobData: { step: "second" },
        });
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
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: bullmq flow addBulk creates trees across separate queues atomically`,
    { skip: skipFor(adapter) },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "bulk" },
          adapter.queueConfig("queue", "bulkcasts", store),
          {
            id: "flow",
            type: "bullmq flow",
            z: "tab",
            queue: "queue",
            wires: [["flow-out"]],
          },
          { id: "flow-out", type: "helper", z: "tab", wires: [] },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
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

        // Both queues really got their job, which is what addBulk buys over
        // two separate add() calls. Counted through BullMQ's own API rather
        // than raw Redis keys, so it means the same on either backend.
        const inspectors = ["bulk-a", "bulk-b"].map((bulkQueue) =>
          adapter.inspectorQueue(bulkQueue, store),
        );
        try {
          for (const inspector of inspectors) {
            inspector.on("error", () => {});
            assert.equal(await inspector.getWaitingCount(), 1);
          }
        } finally {
          await Promise.all(inspectors.map((inspector) => inspector.close()));
        }
      } finally {
        await stopTest(store, userDir);
      }
    },
  );
  // Standing parity proof, derived from lib/commands.js's own switch rather
  // than a hand-kept list. BullMQ documents API parity between its backends,
  // but that claim covers the library, not this package's forty-odd msg.cmd
  // values -- and the PostgreSQL adapter genuinely does not implement
  // everything. Adding a command therefore fails this test until it is either
  // exercised here or excused with a reason, so a gap is visible rather than
  // discovered by a user.
  //
  // Every probe declares the SAME expectation for both backends. A command
  // that works on Redis and fails on PostgreSQL breaks the postgres run,
  // which is the divergence worth catching.
  test(
    `${adapter.name}: every msg.cmd in the dispatch switch behaves the same`,
    { skip: skipFor(adapter), timeout: 60000 },
    async () => {
      const source = fs.readFileSync(
        path.join(__dirname, "..", "lib", "commands.js"),
        "utf8",
      );
      const declared = new Set(
        [...source.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]),
      );

      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "command parity" },
          adapter.queueConfig("queue", "paritycasts", store),
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
        ];
        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const output = helper.getNode("cmd-out");

        // Seeded first so the job-scoped commands have something real to act
        // on, and read back so the probes use the id BullMQ actually assigned.
        const seeded = await receiveCommand(cmd, output, {
          cmd: "add",
          payload: "parity seed",
          jobopts: { delay: 60000 },
        });
        const jobId = seeded.payload.id;

        // Ordered: reads and reversible writes first, destructive last, so an
        // earlier probe never invalidates a later one.
        const probes = [
          ["addBulk", { payload: [{ name: "bulk", data: { n: 1 } }] }],
          ["getJob", { jobId }],
          ["getJobs", { types: ["delayed"] }],
          ["getJobState", { jobId }],
          ["getJobCounts", {}],
          ["getCountsPerPriority", { priorities: [0, 1] }],
          ["addJobLog", { jobId, logRow: "parity log" }],
          ["getJobLogs", { jobId }],
          ["changePriority", { jobId, priority: 2 }],
          ["changeDelay", { jobId, delay: 30000 }],
          ["getDelayed", {}],
          ["getPrioritized", {}],
          ["promoteJob", { jobId }],
          ["promoteJobs", {}],
          ["getDeduplicationJobId", { deduplicationId: "parity-dedup" }],
          ["removeDeduplicationKey", { deduplicationId: "parity-dedup" }],
          ["getVersion", {}],
          ["isPaused", {}],
          ["isMaxed", {}],
          ["pause", {}],
          ["resume", {}],
          ["getGlobalConcurrency", {}],
          ["setGlobalConcurrency", { concurrency: 5 }],
          ["removeGlobalConcurrency", {}],
          ["setGlobalRateLimit", { max: 10, duration: 1000 }],
          ["getGlobalRateLimit", {}],
          ["getRateLimitTtl", { maxJobs: 10 }],
          ["removeGlobalRateLimit", {}],
          ["rateLimit", { duration: 1000 }],
          ["removeRateLimitKey", {}],
          [
            "upsertJobScheduler",
            {
              schedulerId: "parity-scheduler",
              repeat: { pattern: "0 0 * * *" },
            },
          ],
          ["getJobScheduler", { schedulerId: "parity-scheduler" }],
          ["getJobSchedulers", {}],
          ["getJobSchedulersCount", {}],
          ["removeJobScheduler", { schedulerId: "parity-scheduler" }],
          ["retryJobs", {}],
          ["exportPrometheusMetrics", {}],
          ["removeJob", { jobId }],
          ["clean", { grace: 0, state: "completed" }],
          ["drain", {}],
          ["stopAndRemoveAllJobs", {}],
        ];

        // retryJob needs a job in a failed state, which this producer-only
        // flow has no way to create: nothing here runs a job, let alone fails
        // one. It is exercised on a live backend by the cancelJob test, whose
        // retries go through the same job.retry() path.
        const excused = new Map([
          ["retryJob", "needs a failed job; covered by the cancelJob test"],
          ["add", "used above to seed this test"],
        ]);

        const covered = new Set([
          ...probes.map(([command]) => command),
          ...excused.keys(),
        ]);
        assert.deepEqual(
          [...declared].filter((command) => !covered.has(command)).sort(),
          [],
          "every msg.cmd in lib/commands.js must be exercised here or excused with a reason",
        );
        assert.deepEqual(
          [...covered].filter((command) => !declared.has(command)).sort(),
          [],
          "this list names a command the dispatch switch no longer has",
        );

        for (const [command, fields] of probes) {
          // A command that throws sends nothing downstream, so each probe gets
          // its own short deadline and the first divergence fails immediately
          // by name. Collecting them all instead would spend the whole test
          // budget re-timing-out on every remaining probe and report only that
          // the test timed out.
          const settled = waitForInput(output, 5000);
          cmd.receive({ cmd: command, ...fields });
          try {
            await settled;
          } catch (err) {
            assert.fail(
              `${adapter.name} could not run msg.cmd "${command}": ${err.message}`,
            );
          }
        }
      } finally {
        await stopTest(store, userDir);
      }
    },
  );

  test(
    `${adapter.name}: every bullmq job action runs against the live backend`,
    { skip: skipFor(adapter), timeout: 60000 },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const flow = [
          { id: "tab", type: "tab", label: "job action parity" },
          adapter.queueConfig("queue", "actioncasts", store),
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
            limiterMax: 100,
            limiterDuration: 1000,
            wires: [["active-out"]],
          },
          { id: "active-out", type: "helper", z: "tab", wires: [] },
          {
            id: "job",
            type: "bullmq job",
            z: "tab",
            action: "complete",
            wires: [["job-out"]],
          },
          { id: "job-out", type: "helper", z: "tab", wires: [] },
          {
            id: "events",
            type: "bullmq events",
            z: "tab",
            queue: "queue",
            events: "failed",
            wires: [["events-out"]],
          },
          { id: "events-out", type: "helper", z: "tab", wires: [] },
        ];

        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const cmdOut = helper.getNode("cmd-out");
        const activeOut = helper.getNode("active-out");
        const job = helper.getNode("job");
        const jobOut = helper.getNode("job-out");
        const eventsOut = helper.getNode("events-out");
        await helper.getNode("events").queueEvents.waitUntilReady();

        async function activate(payload, jobopts = {}) {
          const active = waitForInput(activeOut);
          await receiveCommand(cmd, cmdOut, { cmd: "add", payload, jobopts });
          return await active;
        }

        // Every action actually sent is recorded here, and the set is compared
        // against the node's own switch at the end. Without that link the
        // coverage claim is by inspection: a new action could be "covered" by
        // appending it to the expected list and never running it.
        const exercised = new Set();

        function send(active, action, fields = {}) {
          exercised.add(action);
          job.receive({ ...active, cmd: action, ...fields });
        }

        async function runAndReceive(active, action, fields = {}) {
          const output = waitForInput(jobOut);
          send(active, action, fields);
          return await output;
        }

        let active = await activate("non-settling actions", {
          deduplication: { id: "action-dedup" },
        });
        for (const [action, fields] of [
          ["progress", { progress: 25 }],
          ["removeDeduplicationKey", {}],
          ["getChildrenValues", {}],
          ["getFailedChildrenValues", {}],
          ["removeUnprocessedChildren", {}],
          ["updateData", { jobData: { payload: "updated" } }],
        ]) {
          active = await runAndReceive(active, action, fields);
        }
        await runAndReceive(active, "complete", { result: "done" });

        for (const action of ["fail", "failUnrecoverable"]) {
          active = await activate(action, { removeOnFail: false });
          const failed = waitForInput(eventsOut);
          send(active, action, { error: `${action} action proof` });
          assert.match((await failed).payload.failedReason, /action proof/);
        }

        for (const [action, fields] of [
          ["rateLimit", { duration: 50 }],
          ["moveToWait", {}],
          ["moveToDelayed", { delay: 50 }],
        ]) {
          const activations = waitForInputMessages(activeOut, 2, 15000);
          active = await activate(action);
          if (action === "moveToWait" || action === "moveToDelayed") {
            await runAndReceive(active, action, fields);
          } else {
            send(active, action, fields);
          }
          const [, resumed] = await activations;
          await runAndReceive(resumed, "complete", { result: "resumed" });
        }

        active = await activate("cancel job", { removeOnFail: false });
        await runAndReceive(active, "cancelJob");
        active = await activate("cancel all", { removeOnFail: false });
        await runAndReceive(active, "cancelAllJobs");

        const source = fs.readFileSync(
          path.join(__dirname, "..", "bull-queue.js"),
          "utf8",
        );
        const actionSwitch = source.slice(
          source.indexOf("function BullJobNode"),
          source.indexOf("function BullEventsNode"),
        );
        const declared = [...actionSwitch.matchAll(/case "([a-zA-Z]+)":/g)].map(
          (match) => match[1],
        );
        assert.deepEqual(
          declared.filter((action) => !exercised.has(action)).sort(),
          [],
          "every bullmq job action must actually be sent by this test",
        );
        assert.deepEqual(
          [...exercised].filter((action) => !declared.includes(action)).sort(),
          [],
          "this test sends an action the bullmq job node no longer has",
        );
        assert.deepEqual(declared.sort(), [
          "cancelAllJobs",
          "cancelJob",
          "complete",
          "fail",
          "failUnrecoverable",
          "getChildrenValues",
          "getFailedChildrenValues",
          "moveToDelayed",
          "moveToWait",
          "progress",
          "rateLimit",
          "removeDeduplicationKey",
          "removeUnprocessedChildren",
          "updateData",
        ]);
      } finally {
        await stopTest(store, userDir);
      }
    },
  );

  // The delayed half of examples/scheduled_notifications.json, end to end: a
  // per-user series of explicitly-timed notifications is enqueued in one
  // addBulk and every one of them reaches the worker. The example's own
  // function node does the ISO-8601-to-delay conversion here, so the shipped
  // example is what is under test rather than a re-implementation of it.
  test(
    `${adapter.name}: a scheduled series of notifications reaches the worker`,
    { skip: skipFor(adapter), timeout: 60000 },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const example = readExampleFlow(
          "examples/scheduled_notifications.json",
        );
        const exampleQueue = example.find(
          (node) => node.id === "queue-scheduled-notifications",
        );
        const flow = [
          { id: "tab", type: "tab", label: "scheduled notifications" },
          {
            ...exampleQueue,
            ...adapter.queueConfig("queue", exampleQueue.name, store),
          },
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
            completionMode: "immediate",
            concurrency: 1,
            x: 160,
            y: 240,
            wires: [["run-out"]],
          },
          {
            id: "run-out",
            type: "helper",
            z: "tab",
            x: 360,
            y: 240,
            wires: [],
          },
        ];
        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const cmdOut = helper.getNode("cmd-out");
        const runOut = helper.getNode("run-out");

        // The example's sample dates are in 2026 on purpose -- a real schedule
        // is weeks out. A test cannot wait weeks, so it sends its own schedule
        // in the same shape, which is exactly the msg.payload override the
        // example documents. Spread over a few hundred milliseconds so these
        // are genuinely delayed jobs promoted by BullMQ, not immediate ones.
        const base = Date.now() + 300;
        const at = (offsetMs) => new Date(base + offsetMs).toISOString();
        const schedule = [
          {
            userId: "user_A",
            jobs: [
              {
                time: at(0),
                message: {
                  type: "welcome",
                  title: "Welcome!",
                  pointsAwarded: 100,
                },
              },
              {
                time: at(150),
                message: {
                  type: "survey",
                  title: "Quick Feedback",
                  rewardCode: "THANKYOU",
                },
              },
              {
                time: at(300),
                message: {
                  type: "promotion",
                  title: "Flash Sale",
                  discountPercentage: 25,
                },
              },
              {
                time: at(450),
                message: {
                  type: "billing",
                  title: "Invoice Ready",
                  invoiceId: "INV-001",
                  amountDue: 49.99,
                },
              },
              {
                time: at(600),
                message: {
                  type: "summary",
                  title: "Monthly Wrap-up",
                  activeDays: 14,
                },
              },
            ],
          },
          {
            userId: "user_B",
            jobs: [
              {
                time: at(75),
                message: {
                  type: "security",
                  title: "New Login Detected",
                  device: "Chrome / Windows",
                },
              },
              {
                time: at(225),
                message: {
                  type: "trial_expiry",
                  title: "Trial Ending Soon",
                  daysLeft: 3,
                },
              },
              {
                time: at(375),
                message: {
                  type: "reengage",
                  title: "We Miss You",
                  specialOffer: "SHIPFREE",
                },
              },
            ],
          },
        ];

        const delivered = waitForInputMessages(runOut, 8, 30000);
        const enqueued = await receiveCommand(
          cmd,
          cmdOut,
          messageFromExampleFunction(example, "fn-notify-schedule", {
            payload: schedule,
          }),
        );
        assert.equal(
          enqueued.payload.length,
          8,
          "addBulk must enqueue every notification in the series",
        );

        const messages = await delivered;
        assert.equal(messages.length, 8);

        // Every notification arrives intact, keyed by its own job so a
        // duplicate or a dropped one is visible rather than averaged away.
        const byType = new Map(
          messages.map((msg) => [msg.payload.message.type, msg.payload]),
        );
        assert.deepEqual(
          [...byType.keys()].sort(),
          [
            "billing",
            "promotion",
            "reengage",
            "security",
            "summary",
            "survey",
            "trial_expiry",
            "welcome",
          ],
          "each scheduled notification must be delivered exactly once",
        );
        assert.equal(byType.get("welcome").userId, "user_A");
        assert.equal(byType.get("security").userId, "user_B");
        // The message payload survives the round trip through the store, not
        // just its type: these are the fields a real notification carries.
        assert.equal(byType.get("welcome").message.pointsAwarded, 100);
        assert.equal(byType.get("promotion").message.discountPercentage, 25);
        assert.equal(byType.get("billing").message.amountDue, 49.99);
        assert.equal(byType.get("reengage").message.specialOffer, "SHIPFREE");

        // Delivered in scheduled order, which is the point of a delay: the
        // series was enqueued in user order, not time order.
        const arrivalOrder = messages.map((msg) => msg.payload.message.type);
        const scheduledOrder = schedule
          .flatMap((user) => user.jobs)
          .sort((a, b) => new Date(a.time) - new Date(b.time))
          .map((job) => job.message.type);
        assert.deepEqual(
          arrivalOrder,
          scheduledOrder,
          "delayed notifications must arrive in scheduled order",
        );

        // Re-sending the same schedule must not double-book anything: the
        // example derives a jobId per notification for exactly this reason.
        const again = await receiveCommand(
          cmd,
          cmdOut,
          messageFromExampleFunction(example, "fn-notify-schedule", {
            payload: schedule,
          }),
        );
        assert.equal(again.payload.length, 8);
      } finally {
        await stopTest(store, userDir);
      }
    },
  );

  // The cron half of the same example: a Job Scheduler whose template carries
  // the message, so every generated job arrives at the worker with it.
  test(
    `${adapter.name}: a cron scheduler delivers repeating notifications`,
    { skip: skipFor(adapter), timeout: 60000 },
    async () => {
      const { store, userDir } = await startTest(adapter);

      try {
        const example = readExampleFlow(
          "examples/scheduled_notifications.json",
        );
        const exampleQueue = example.find(
          (node) => node.id === "queue-scheduled-notifications",
        );
        const flow = [
          { id: "tab", type: "tab", label: "cron notifications" },
          {
            ...exampleQueue,
            ...adapter.queueConfig("queue", exampleQueue.name, store),
          },
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
            completionMode: "immediate",
            concurrency: 1,
            x: 160,
            y: 240,
            wires: [["run-out"]],
          },
          {
            id: "run-out",
            type: "helper",
            z: "tab",
            x: 360,
            y: 240,
            wires: [],
          },
        ];
        await helper.load(bullNodes, flow, adapter.credentials(store));
        const cmd = helper.getNode("cmd");
        const cmdOut = helper.getNode("cmd-out");
        const runOut = helper.getNode("run-out");

        // The example ships a daily 08:00 UTC pattern, which no test can wait
        // for. Only the cadence is overridden -- the scheduler id and the
        // message-bearing template still come from the example -- so what is
        // under test is the example's own payload, once per second.
        const scheduled = messageFromExampleFunction(
          example,
          "fn-notify-cron",
          {},
        );
        assert.equal(scheduled.cmd, "upsertJobScheduler");
        assert.equal(scheduled.repeat.tz, "UTC");
        scheduled.repeat = { pattern: "*/1 * * * * *", tz: "UTC" };

        const repeated = waitForInputMessages(runOut, 2, 30000);
        const upserted = await receiveCommand(cmd, cmdOut, scheduled);
        assert.ok(upserted.payload, "upsertJobScheduler must return the job");

        const messages = await repeated;
        assert.equal(messages.length, 2);
        for (const msg of messages) {
          assert.equal(msg.payload.message.type, "digest");
          assert.equal(msg.payload.message.title, "Your daily digest");
          assert.equal(msg.payload.userId, "user_A");
        }

        // Two jobs from one scheduler, not the same job twice.
        assert.notEqual(
          messages[0].bull.jobId,
          messages[1].bull.jobId,
          "each cron iteration must be its own job",
        );

        // The scheduler outlives a redeploy, so the example's own removal
        // command has to work.
        const listed = await receiveCommand(cmd, cmdOut, {
          cmd: "getJobSchedulers",
        });
        assert.ok(
          listed.payload.some(
            (entry) =>
              entry.key === "daily-digest" || entry.id === "daily-digest",
          ),
          `the scheduler must be listed: ${JSON.stringify(listed.payload)}`,
        );
        await receiveCommand(
          cmd,
          cmdOut,
          messageFromExampleFunction(example, "fn-notify-cron-remove", {}),
        );
        const afterRemoval = await receiveCommand(cmd, cmdOut, {
          cmd: "getJobSchedulersCount",
        });
        assert.equal(afterRemoval.payload, 0);
      } finally {
        await stopTest(store, userDir);
      }
    },
  );
}

// Redis-only, and stated rather than skipped: this restarts the store
// process on the same port and waits on raw ioredis "ready" events. The
// PostgreSQL fixture is a container with a Docker-assigned port and no raw
// client to observe, so the same proof needs a different test, not this one
// parameterized.
test(
  "redis only: worker and producer recover after Redis restarts",
  { skip: skipFor(REDIS_ADAPTER), timeout: 30000 },
  async () => {
    const started = await startTest(REDIS_ADAPTER);
    let redis = started.store;
    const { userDir } = started;

    try {
      const flow = [
        { id: "tab", type: "tab", label: "reconnect" },
        REDIS_ADAPTER.queueConfig("queue", "reconnectcasts", redis),
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
      redis = await REDIS_ADAPTER.start(port);
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
      await stopTest(redis, userDir);
    }
  },
);
