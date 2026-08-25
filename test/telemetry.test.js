"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");
const IORedis = require("ioredis");

const registerBullMQNodes = require("../bull-queue");
const { version: PACKAGE_VERSION } = require("../package.json");

// Nothing listens here: every connection attempt fails fast (ECONNREFUSED)
// instead of hanging or leaking into a real Redis -- same trick as
// test/shutdown.test.js's DEAD_REDIS.
const DEAD_PORT = 6399;

function createRED(options = {}) {
  const registered = new Map();
  return {
    registered,
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = options.id || "node-under-test";
        node.status = options.status || (() => {});
        node.error = options.error || (() => {});
        node.send = () => {};
      },
      getNode() {
        return options.getNode ? options.getNode() : null;
      },
      registerType(type, constructor, registerOptions) {
        registered.set(type, { constructor, options: registerOptions });
      },
    },
  };
}

// A real (but never-reachable) ioredis client -- not a bare EventEmitter --
// so BullMQ's isRedisInstance() check recognizes it as an already-provided
// client instead of falling back to building its own default connection to
// 127.0.0.1:6379, which could hit a real, unrelated Redis server in this
// environment. Worker/QueueEvents connections must use maxRetriesPerRequest:
// null (BullMQ enforces this for its blocking connections).
function fakeConnection(role) {
  const connection = new IORedis({
    host: "127.0.0.1",
    port: DEAD_PORT,
    maxRetriesPerRequest: role === "worker" || role === "events" ? null : 1,
    enableReadyCheck: true,
  });
  connection.on("error", () => {}); // expected: DEAD_PORT refuses every attempt
  return connection;
}

function buildServerNode(config, redOptions = {}) {
  const RED = createRED(redOptions);
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bull-queue-server").constructor;
  const node = {};
  Server.call(node, config);
  // Bypass the production connection factory (and its attachErrorListener,
  // which would otherwise report every connection retry through node.error
  // and swamp the telemetry-specific error assertions below).
  node.createConnection = (role) => fakeConnection(role);
  return node;
}

// Closes a resource the way the production node types do -- via the config
// node's own releaseResource, which bounds a stuck close() to CLOSE_GRACE_MS
// and force-disconnects the sockets rather than hanging forever (a worker's
// or QueueEvents' close() never settles on a connection that never became
// ready; see bull-queue.js's forceDisconnect).
async function release(node, ...resources) {
  await Promise.all(
    resources.map((resource) => node.releaseResource(resource)),
  );
}

// bullmq-otel is a real devDependency here (installed so the enabled path
// can be exercised), so there is no honest way to actually uninstall it for
// one test. The smallest seam that simulates its absence -- or lets a test
// see exactly what BullMQOtel was constructed with -- is Node's own module
// loader hook (node:module Module._load), scoped to the literal
// "bullmq-otel" request string and always restored in a finally block. No
// production seam or exported test hook was added for this.
function withPatchedRequire(handler, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === "bullmq-otel") {
      return handler();
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

test("telemetry default off: bullmq-otel is never required and no resource carries a telemetry key", async () => {
  const node = buildServerNode({ name: "telemetrycasts" });

  const resources = withPatchedRequire(
    () => {
      throw new Error(
        "bullmq-otel must not be required while telemetry is off",
      );
    },
    () => ({
      queue: node.getQueue(),
      worker: node.createWorker(async () => {}, { autorun: false }),
      flowProducer: node.createFlowProducer(),
      queueEvents: node.createQueueEvents(),
    }),
  );

  try {
    assert.equal(Object.hasOwn(resources.queue.opts, "telemetry"), false);
    assert.equal(Object.hasOwn(resources.worker.opts, "telemetry"), false);
    assert.equal(resources.flowProducer.telemetry, undefined);
    assert.equal(Object.hasOwn(resources.queueEvents.opts, "telemetry"), false);
  } finally {
    await release(
      node,
      resources.queue,
      resources.worker,
      resources.flowProducer,
      resources.queueEvents,
    );
  }
});

test("telemetry enabled: Queue, Worker, and FlowProducer share one cached BullMQOtel instance", async () => {
  const { BullMQOtel } = require("bullmq-otel");
  const node = buildServerNode({
    name: "telemetrycasts",
    telemetry: true,
    telemetryServiceName: "my-service",
  });

  const queue = node.getQueue();
  const worker = node.createWorker(async () => {}, { autorun: false });
  const flowProducer = node.createFlowProducer();

  try {
    assert.ok(queue.opts.telemetry instanceof BullMQOtel);
    assert.equal(queue.opts.telemetry, worker.opts.telemetry);
    assert.equal(queue.opts.telemetry, flowProducer.telemetry);
  } finally {
    await release(node, queue, worker, flowProducer);
  }
});

test("telemetry enabled: QueueEvents options never carry a telemetry key", async () => {
  const node = buildServerNode({ name: "telemetrycasts", telemetry: true });

  const queueEvents = node.createQueueEvents();
  try {
    assert.equal(Object.hasOwn(queueEvents.opts, "telemetry"), false);
  } finally {
    await release(node, queueEvents);
  }
});

test("telemetry enabled but bullmq-otel missing: reports exactly one node.error and resources still work", async () => {
  const errors = [];
  const node = buildServerNode(
    { name: "telemetrycasts", telemetry: true },
    { error: (err) => errors.push(err) },
  );

  const resources = withPatchedRequire(
    () => {
      throw new Error("Cannot find module 'bullmq-otel'");
    },
    () => ({
      queue: node.getQueue(),
      worker: node.createWorker(async () => {}, { autorun: false }),
    }),
  );

  try {
    assert.equal(Object.hasOwn(resources.queue.opts, "telemetry"), false);
    assert.equal(Object.hasOwn(resources.worker.opts, "telemetry"), false);
    assert.equal(errors.length, 1, "must report exactly one node.error");
    assert.match(String(errors[0]), /bullmq-otel/);
  } finally {
    await release(node, resources.queue, resources.worker);
  }
});

test("telemetry enabled with a blank service name falls back to the queue name", async () => {
  const calls = [];
  class RecordingBullMQOtel {
    constructor(opts) {
      calls.push(opts);
    }
  }
  const node = buildServerNode({ name: "fallback-queue", telemetry: true });

  const queue = withPatchedRequire(
    () => ({ BullMQOtel: RecordingBullMQOtel }),
    () => node.getQueue(),
  );

  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tracerName, "fallback-queue");
    assert.equal(calls[0].meterName, "fallback-queue");
    assert.equal(calls[0].version, PACKAGE_VERSION);
    assert.equal(calls[0].enableMetrics, false);
  } finally {
    await release(node, queue);
  }
});
