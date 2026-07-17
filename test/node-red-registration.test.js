const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { setImmediate: tick } = require("node:timers/promises");
const { promisify } = require("node:util");
const test = require("node:test");

const registerBullMQNodes = require("../bull-queue");

function createRED(options = {}) {
  const registered = new Map();
  return {
    registered,
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = "node-under-test";
        node.status = options.status || (() => {});
        node.error = options.error || (() => {});
        node.send = () => {};
      },
      getNode() {
        return options.getNode ? options.getNode() : null;
      },
      registerType(type, constructor, options) {
        registered.set(type, { constructor, options });
      },
    },
  };
}

test("registers the legacy and BullMQ node types", () => {
  const RED = createRED();

  registerBullMQNodes(RED);

  assert.deepEqual(Array.from(RED.registered.keys()).sort(), [
    "bull cmd",
    "bull events",
    "bull flow",
    "bull job",
    "bull run",
    "bull-queue-server",
  ]);
});

test("config node declares credential-backed secret fields", () => {
  const RED = createRED();

  registerBullMQNodes(RED);

  const configNode = RED.registered.get("bull-queue-server");
  assert.deepEqual(Object.keys(configNode.options.credentials).sort(), [
    "password",
    "sentinelPassword",
    "tlsCa",
    "tlsCert",
    "tlsKey",
  ]);
});

test("bull flow reports Redis connection status when FlowProducer is ready", async () => {
  const statuses = [];
  let readyCalls = 0;
  const flowProducer = {
    async waitUntilReady() {
      readyCalls += 1;
    },
    async close() {},
    on() {},
  };
  const queueConfig = {
    config: { queueName: "flowcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createFlowProducer() {
      return flowProducer;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
  });

  registerBullMQNodes(RED);
  const FlowNode = RED.registered.get("bull flow").constructor;
  const node = {};
  FlowNode.call(node, { queue: "queue" });

  await tick();

  assert.equal(readyCalls, 1);
  assert.deepEqual(statuses.at(-2), {
    fill: "yellow",
    shape: "ring",
    text: "connecting",
  });
  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });
});

test("bull flow reports FlowProducer errors on its own node status", async () => {
  const statuses = [];
  const errors = [];
  const flowProducer = new EventEmitter();
  flowProducer.waitUntilReady = async function waitUntilReady() {};
  flowProducer.close = async function close() {};
  const queueConfig = {
    config: { queueName: "flowcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createFlowProducer() {
      return flowProducer;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
    error(err) {
      errors.push(err);
    },
  });

  registerBullMQNodes(RED);
  const FlowNode = RED.registered.get("bull flow").constructor;
  FlowNode.call({}, { queue: "queue" });
  await tick();

  // Exactly one error listener: the flow node owns error reporting, and the
  // config node's createFlowProducer must not attach a duplicate listener.
  assert.equal(flowProducer.listenerCount("error"), 1);

  flowProducer.emit("error", new Error("connection lost"));

  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
  assert.equal(errors.length, 1, "a single error must be reported once");
});

test("config node createFlowProducer does not attach its own error listener", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bull-queue-server").constructor;

  const node = {};
  Server.call(node, { name: "flowcasts" });
  // Avoid opening a real Redis connection.
  node.createConnection = function createConnection() {
    const connection = new EventEmitter();
    connection.options = {};
    return connection;
  };

  const flowProducer = node.createFlowProducer();
  try {
    // The flow node owns error reporting; the shared factory must not add a
    // second listener that would double-report flow errors.
    assert.equal(flowProducer.listenerCount("error"), 0);
  } finally {
    await flowProducer.close().catch(() => {});
  }
});

test("bull run reports worker errors on its own node status", () => {
  const statuses = [];
  const errors = [];
  const worker = new EventEmitter();
  worker.close = async function close() {};
  const queueConfig = {
    config: { queueName: "runcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createWorker() {
      return worker;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
    error(err) {
      errors.push(err);
    },
  });

  registerBullMQNodes(RED);
  const RunNode = RED.registered.get("bull run").constructor;
  RunNode.call({}, { queue: "queue", completionMode: "immediate" });

  assert.equal(worker.listenerCount("error"), 1);
  worker.emit("error", new Error("worker connection lost"));

  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
  assert.equal(errors.length, 1);
});

test("bull events reports QueueEvents errors on its own node status", async () => {
  const statuses = [];
  const errors = [];
  const queueEvents = new EventEmitter();
  queueEvents.waitUntilReady = async function waitUntilReady() {};
  queueEvents.close = async function close() {};
  const queueConfig = {
    config: { queueName: "eventcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createQueueEvents() {
      return queueEvents;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
    error(err) {
      errors.push(err);
    },
  });

  registerBullMQNodes(RED);
  const EventsNode = RED.registered.get("bull events").constructor;
  EventsNode.call({}, { queue: "queue" });
  await tick();

  assert.equal(queueEvents.listenerCount("error"), 1);
  queueEvents.emit("error", new Error("events connection lost"));

  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
  assert.equal(errors.length, 1);
});

function createCmdQueueConfig(connection) {
  return {
    config: { queueName: "cmdcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    getQueue() {
      return {};
    },
    getProducerConnection() {
      return connection;
    },
    deregister(node, done) {
      done();
    },
  };
}

test("bull cmd reflects the shared producer connection state", () => {
  const statuses = [];
  const connection = new EventEmitter();
  connection.status = "connecting";
  const RED = createRED({
    getNode() {
      return createCmdQueueConfig(connection);
    },
    status(status) {
      statuses.push(status);
    },
  });

  registerBullMQNodes(RED);
  const CmdNode = RED.registered.get("bull cmd").constructor;
  CmdNode.call({}, { queue: "queue" });

  assert.ok(
    !statuses.some(
      (status) => status.fill === "green" && status.text === "configured",
    ),
    "must not show a green configured dot while Redis is not connected",
  );
  assert.deepEqual(statuses.at(-1), {
    fill: "yellow",
    shape: "ring",
    text: "connecting",
  });

  connection.emit("ready");
  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });

  connection.emit("close");
  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
});

test("bull cmd shows connected immediately when the connection is already ready", () => {
  const statuses = [];
  const connection = new EventEmitter();
  connection.status = "ready";
  const RED = createRED({
    getNode() {
      return createCmdQueueConfig(connection);
    },
    status(status) {
      statuses.push(status);
    },
  });

  registerBullMQNodes(RED);
  const CmdNode = RED.registered.get("bull cmd").constructor;
  CmdNode.call({}, { queue: "queue" });

  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });
});

test("bull cmd removes its connection listeners on close", async () => {
  const connection = new EventEmitter();
  connection.status = "connecting";
  const RED = createRED({
    getNode() {
      return createCmdQueueConfig(connection);
    },
  });

  registerBullMQNodes(RED);
  const CmdNode = RED.registered.get("bull cmd").constructor;
  const node = {};
  CmdNode.call(node, { queue: "queue" });

  assert.ok(
    connection.listenerCount("ready") > 0,
    "bull cmd must watch the shared connection",
  );

  const handler = node.listeners("close")[0];
  await promisify(handler).call(node, false);

  assert.equal(connection.listenerCount("ready"), 0);
  assert.equal(connection.listenerCount("close"), 0);
  assert.equal(connection.listenerCount("error"), 0);
});

test("bull events shows connecting before the connection is ready", async () => {
  const statuses = [];
  let released = false;
  const queueEvents = new EventEmitter();
  queueEvents.waitUntilReady = async function waitUntilReady() {
    while (!released) {
      await tick();
    }
  };
  queueEvents.close = async function close() {};
  const queueConfig = {
    config: { queueName: "eventcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createQueueEvents() {
      return queueEvents;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
  });

  registerBullMQNodes(RED);
  const EventsNode = RED.registered.get("bull events").constructor;
  EventsNode.call({}, { queue: "queue" });

  assert.deepEqual(statuses.at(-1), {
    fill: "yellow",
    shape: "ring",
    text: "connecting",
  });

  released = true;
  await tick();
  await tick();

  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });
});

test("bull flow shows disconnected when the initial connection fails", async () => {
  const statuses = [];
  const errors = [];
  const flowProducer = new EventEmitter();
  flowProducer.waitUntilReady = async function waitUntilReady() {
    throw new Error("connect ECONNREFUSED");
  };
  flowProducer.close = async function close() {};
  const queueConfig = {
    config: { queueName: "flowcasts" },
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    createFlowProducer() {
      return flowProducer;
    },
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
    error(err) {
      errors.push(err);
    },
  });

  registerBullMQNodes(RED);
  const FlowNode = RED.registered.get("bull flow").constructor;
  FlowNode.call({}, { queue: "queue" });
  await tick();

  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
  assert.equal(errors.length, 1);
});

test("config node exposes the shared producer connection", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bull-queue-server").constructor;

  const node = {};
  Server.call(node, { name: "cmdcasts" });
  // Avoid opening a real Redis connection.
  node.createConnection = function createConnection() {
    const connection = new EventEmitter();
    connection.options = {};
    connection.status = "ready";
    return connection;
  };

  const connection = node.getProducerConnection();
  try {
    assert.ok(connection, "producer connection must be created on demand");
    assert.equal(connection, node.producerConnection);
    assert.equal(connection.getMaxListeners(), 0);
    assert.ok(node.queue, "the shared queue must be created with it");
    assert.equal(node.getProducerConnection(), connection);
  } finally {
    try {
      await node.queue.close();
    } catch (err) {
      // best-effort cleanup
    }
  }
});

test("config node createWorker does not attach its own error listener", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bull-queue-server").constructor;

  const node = {};
  Server.call(node, { name: "runcasts" });
  node.createConnection = function createConnection() {
    const connection = new EventEmitter();
    connection.options = {};
    connection.status = "ready";
    return connection;
  };

  // autorun:false keeps the worker from starting its Redis polling loop.
  const worker = node.createWorker(async () => {}, { autorun: false });
  try {
    assert.equal(worker.listenerCount("error"), 0);
  } finally {
    await worker.close().catch(() => {});
  }
});
