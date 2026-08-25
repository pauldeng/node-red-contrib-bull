const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");

const {
  AcknowledgementRegistry,
  parseAckTimeoutMs,
} = require("../lib/acknowledgements");
const registerBullMQNodes = require("../bull-queue");

function context(overrides = {}) {
  return {
    job: { id: "job-1" },
    queue: {},
    queueName: "testcasts",
    runNodeId: "run-1",
    ...overrides,
  };
}

test("resolves the waiter with the completion value", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.complete({ ok: true });

  assert.deepEqual(await settled, { ok: true });
});

test("rejects the waiter when the job fails", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.fail(new Error("boom"));

  await assert.rejects(settled, /boom/);
});

test("returns a completion that happened before waiting", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  entry.complete({ ok: true });

  assert.deepEqual(
    await Promise.race([entry.wait(), sleep(25, "missed settlement")]),
    { ok: true },
  );
});

test("throws a failure that happened before waiting", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  entry.fail(new Error("boom"));

  await assert.rejects(
    Promise.race([entry.wait(), sleep(25, "missed settlement")]),
    /boom/,
  );
});

test("removes the entry from the registry after completion", async () => {
  const registry = new AcknowledgementRegistry();
  const { ackId, entry } = registry.create(context(), 0);

  assert.equal(registry.entries.size, 1);

  const settled = entry.wait();
  entry.complete("done");
  await settled;

  assert.equal(
    registry.entries.size,
    0,
    "settled acknowledgements must not stay in the registry",
  );
  assert.throws(() => registry.get(ackId), /Missing, stale/);
});

test("removes the entry from the registry after failure", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.fail(new Error("nope"));
  await assert.rejects(settled);

  assert.equal(registry.entries.size, 0);
});

test("removes the entry from the registry after a timeout", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 10);

  await assert.rejects(entry.wait(), /timed out/);
  assert.equal(registry.entries.size, 0);
});

test("rejectByRunNode settles and drops every entry for that run node", async () => {
  const registry = new AcknowledgementRegistry();
  const first = registry.create(context({ job: { id: "a" } }), 0);
  const second = registry.create(context({ job: { id: "b" } }), 0);
  const other = registry.create(
    context({ runNodeId: "run-2", job: { id: "c" } }),
    0,
  );

  const firstWait = first.entry.wait();
  const secondWait = second.entry.wait();

  registry.rejectByRunNode("run-1", new Error("closed"));

  await assert.rejects(firstWait, /closed/);
  await assert.rejects(secondWait, /closed/);
  assert.equal(registry.entries.size, 1, "entries for other run nodes remain");
  assert.equal(registry.get(other.ackId), other.entry);

  // Settle the survivor so the test leaves no dangling waiter.
  const otherWait = other.entry.wait();
  other.entry.complete("ok");
  await otherWait;
  assert.equal(registry.entries.size, 0);
});

test("parseAckTimeoutMs defaults empty, non-numeric, and negative values", () => {
  assert.equal(parseAckTimeoutMs(undefined), 300000);
  assert.equal(parseAckTimeoutMs(null), 300000);
  assert.equal(parseAckTimeoutMs(""), 300000);
  assert.equal(parseAckTimeoutMs("abc"), 300000);
  assert.equal(parseAckTimeoutMs(-5), 300000);
  assert.equal(parseAckTimeoutMs(undefined, 1000), 1000);
});

test("parseAckTimeoutMs keeps 0 so the timeout can be disabled", () => {
  assert.equal(parseAckTimeoutMs(0), 0);
  assert.equal(parseAckTimeoutMs("0"), 0);
});

test("parseAckTimeoutMs accepts positive millisecond values", () => {
  assert.equal(parseAckTimeoutMs(5000), 5000);
  assert.equal(parseAckTimeoutMs("60000"), 60000);
});

test("an ack timeout of 0 never settles on its own", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), parseAckTimeoutMs(0));

  let settledValue;
  let settled = false;
  const waiter = (async () => {
    settledValue = await entry.wait();
    settled = true;
  })();

  await sleep(30);
  assert.equal(settled, false, "a 0 timeout must wait indefinitely");
  assert.equal(registry.entries.size, 1);

  // Complete it so the test leaves no pending waiter.
  entry.complete("done");
  await waiter;
  assert.equal(settledValue, "done");
});

test("create returns unique ack ids", () => {
  const registry = new AcknowledgementRegistry();
  const a = registry.create(context(), 0);
  const b = registry.create(context(), 0);
  assert.notEqual(a.ackId, b.ackId);
});

test("does not leak entries under repeated completion", async () => {
  const registry = new AcknowledgementRegistry();

  for (let i = 0; i < 100; i += 1) {
    const { entry } = registry.create(context({ job: { id: `job-${i}` } }), 0);
    const settled = entry.wait();
    entry.complete(i);
    await settled;
  }

  // Give any asynchronous cleanup a chance to run.
  await sleep(0);
  assert.equal(registry.entries.size, 0);
});

// --- BullMQ v6 worker cancellation -----------------------------------------

test("aborting the tracked signal rejects the acknowledgement with the abort reason and removes the entry", async () => {
  const registry = new AcknowledgementRegistry();
  const controller = new AbortController();
  const { ackId, entry } = registry.create(
    context({ signal: controller.signal }),
    0,
  );

  const waiter = entry.wait();
  controller.abort("cancelled by operator");

  await assert.rejects(waiter, /cancelled by operator/);
  assert.equal(registry.entries.size, 0);
  assert.throws(() => registry.get(ackId), /Missing, stale/);
});

test("settling removes the abort listener so completion never leaks a listener on the signal", async () => {
  const registry = new AcknowledgementRegistry();
  const controller = new AbortController();
  const { entry } = registry.create(context({ signal: controller.signal }), 0);

  assert.equal(getEventListeners(controller.signal, "abort").length, 1);

  const settled = entry.wait();
  entry.complete("done");
  await settled;

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a completion that lands before a late abort wins the race", async () => {
  const registry = new AcknowledgementRegistry();
  const controller = new AbortController();
  const { entry } = registry.create(context({ signal: controller.signal }), 0);

  const waiter = entry.wait();
  entry.complete("done-first");
  controller.abort("too-late");

  assert.equal(await waiter, "done-first");
});

// --- "bull job" cancelJob / cancelAllJobs, wired through bull-queue.js -----

class FakeWorker {
  constructor() {
    this.tracked = new Map();
    this.cancelJobCalls = [];
    this.cancelAllJobsCalls = [];
  }

  track(jobId, controller) {
    this.tracked.set(jobId, controller);
  }

  // Mirrors bullmq's LockManager: abort the tracked controller and report
  // whether a cancellable processor was found for that job id.
  cancelJob(jobId, reason) {
    this.cancelJobCalls.push({ jobId, reason });
    const controller = this.tracked.get(jobId);
    if (!controller) {
      return false;
    }
    controller.abort(reason);
    return true;
  }

  cancelAllJobs(reason) {
    this.cancelAllJobsCalls.push(reason);
    for (const controller of this.tracked.values()) {
      controller.abort(reason);
    }
  }

  // attachErrorListener() and the run node's ready/closed status wiring
  // expect an EventEmitter-shaped worker.
  on() {}
}

function createRED(getQueueConfig) {
  const registered = new Map();
  return {
    registered,
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = "run-1";
        node.status = () => {};
        node.error = () => {};
        node.send = () => {};
      },
      getNode: () => getQueueConfig(),
      registerType(type, constructor) {
        registered.set(type, { constructor });
      },
    },
  };
}

// Builds one "bull run" (manual mode, backed by a FakeWorker) and one
// "bull job" node sharing the same acknowledgement registry that
// registerBullMQNodes(RED) closes over -- exactly how a real flow wires them.
function setupCancelHarness() {
  const worker = new FakeWorker();
  let processor;
  const queueConfig = {
    config: { queueName: "cancelcasts" },
    register() {},
    createWorker(p) {
      processor = p;
      return worker;
    },
    getQueue: () => ({}),
    async releaseResource() {},
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED(() => queueConfig);
  registerBullMQNodes(RED);

  const runNode = {};
  RED.registered.get("bull run").constructor.call(runNode, {
    queue: "queue",
    completionMode: "manual",
    ackTimeout: 0, // disable the ack timeout; tests settle explicitly
  });
  const sent = [];
  runNode.send = (msg) => sent.push(msg);

  const jobNode = {};
  RED.registered.get("bull job").constructor.call(jobNode, {});

  // Simulates BullMQ invoking the processor for a manual-mode job, tracking
  // its AbortController on the FakeWorker the same way bullmq's LockManager
  // would. Returns the ackId the run node sent downstream.
  function runJob(jobId) {
    const controller = new AbortController();
    worker.track(jobId, controller);
    const resultPromise = processor({ id: jobId }, "token", controller.signal);
    return { ackId: sent.at(-1).bull.ackId, controller, resultPromise };
  }

  function dispatch(msg) {
    const outputs = [];
    let doneErr;
    let doneCalled = false;
    jobNode.emit(
      "input",
      msg,
      (m) => outputs.push(m),
      (err) => {
        doneCalled = true;
        doneErr = err;
      },
    );
    return { outputs, doneErr, doneCalled };
  }

  return { processor, worker, runJob, dispatch };
}

test("the bull run processor declares arity 3 so BullMQ tracks a cancellable AbortController", () => {
  const { processor } = setupCancelHarness();
  assert.equal(
    processor.length,
    3,
    "processor must declare (job, token, signal) or BullMQ never creates the AbortController",
  );
});

test("cancelJob reaches the owning worker with the job id and the resolved reason", async () => {
  const harness = setupCancelHarness();
  const { ackId, resultPromise } = harness.runJob("job-1");

  const result = harness.dispatch({ cmd: "cancelJob", bull: { ackId } });

  assert.deepEqual(harness.worker.cancelJobCalls, [
    { jobId: "job-1", reason: "BullMQ job cancelled" },
  ]);
  assert.equal(result.outputs[0].payload, true);
  assert.equal(result.doneCalled, true);
  assert.equal(result.doneErr, undefined);
  await assert.rejects(resultPromise, /BullMQ job cancelled/);
});

test("cancelJob uses msg.reason when the caller provides one", async () => {
  const harness = setupCancelHarness();
  const { ackId, resultPromise } = harness.runJob("job-1");

  harness.dispatch({
    cmd: "cancelJob",
    bull: { ackId },
    reason: "operator abort",
  });

  assert.equal(harness.worker.cancelJobCalls[0].reason, "operator abort");
  await assert.rejects(resultPromise, /operator abort/);
});

test("cancelJob treats a false result from BullMQ as an error", async () => {
  const harness = setupCancelHarness();
  const { ackId, resultPromise } = harness.runJob("job-1");
  // No cancellable processor found for this job id.
  harness.worker.tracked.delete("job-1");

  const result = harness.dispatch({ cmd: "cancelJob", bull: { ackId } });

  assert.equal(result.doneCalled, true);
  assert.match(
    String(result.doneErr && result.doneErr.message),
    /no cancellable processor/,
  );

  // Settle the survivor so the test leaves no dangling waiter.
  harness.dispatch({ cmd: "complete", bull: { ackId }, payload: "done" });
  assert.equal(await resultPromise, "done");
});

test("cancelAllJobs aborts every active acknowledgement for that run node", async () => {
  const harness = setupCancelHarness();
  const first = harness.runJob("job-1");
  const second = harness.runJob("job-2");

  const result = harness.dispatch({
    cmd: "cancelAllJobs",
    bull: { ackId: first.ackId },
  });

  assert.equal(result.outputs[0].payload, true);
  assert.deepEqual(harness.worker.cancelAllJobsCalls, ["BullMQ job cancelled"]);
  await assert.rejects(first.resultPromise, /BullMQ job cancelled/);
  await assert.rejects(second.resultPromise, /BullMQ job cancelled/);

  // Both acknowledgements are gone from the registry now.
  const stale = harness.dispatch({
    cmd: "complete",
    bull: { ackId: second.ackId },
  });
  assert.match(
    String(stale.doneErr && stale.doneErr.message),
    /Missing, stale/,
  );
});

test("a cancellation and a later completion attempt on the same ack settle exactly once", async () => {
  const harness = setupCancelHarness();
  const { ackId, resultPromise } = harness.runJob("job-1");

  const cancelResult = harness.dispatch({ cmd: "cancelJob", bull: { ackId } });
  assert.equal(cancelResult.outputs[0].payload, true);
  await assert.rejects(resultPromise, /BullMQ job cancelled/);

  // A "complete" action racing in after cancellation already settled the
  // acknowledgement must not resurrect or re-settle it.
  const completeResult = harness.dispatch({
    cmd: "complete",
    bull: { ackId },
    payload: "too-late",
  });
  assert.match(
    String(completeResult.doneErr && completeResult.doneErr.message),
    /Missing, stale/,
  );
});

test("a stale/settled ackId cannot be cancelled", async () => {
  const harness = setupCancelHarness();
  const { ackId, resultPromise } = harness.runJob("job-1");

  harness.dispatch({ cmd: "complete", bull: { ackId }, payload: "done" });
  assert.equal(await resultPromise, "done");

  const cancelResult = harness.dispatch({ cmd: "cancelJob", bull: { ackId } });
  assert.match(
    String(cancelResult.doneErr && cancelResult.doneErr.message),
    /Missing, stale/,
  );
  assert.equal(harness.worker.cancelJobCalls.length, 0);
});
