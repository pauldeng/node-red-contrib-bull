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

test("registers only BullMQ v6 node types", () => {
  const RED = createRED();

  registerBullMQNodes(RED);

  assert.deepEqual(Array.from(RED.registered.keys()).sort(), [
    "bullmq cmd",
    "bullmq events",
    "bullmq flow",
    "bullmq job",
    "bullmq run",
    "bullmq-queue-server",
  ]);
});

test("config node declares credential-backed secret fields", () => {
  const RED = createRED();

  registerBullMQNodes(RED);

  const configNode = RED.registered.get("bullmq-queue-server");
  assert.deepEqual(Object.keys(configNode.options.credentials).sort(), [
    "password",
    "sentinelPassword",
    "tlsCa",
    "tlsCert",
    "tlsKey",
  ]);
});

test("bullmq flow reports Redis connection status when FlowProducer is ready", async () => {
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
  const FlowNode = RED.registered.get("bullmq flow").constructor;
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

test("bullmq flow reports FlowProducer errors on its own node status", async () => {
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
  const FlowNode = RED.registered.get("bullmq flow").constructor;
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

test("bullmq flow applies config retention below flow and job overrides", async () => {
  let addCall;
  const flowProducer = new EventEmitter();
  flowProducer.waitUntilReady = async function waitUntilReady() {};
  flowProducer.close = async function close() {};
  flowProducer.add = async function add(flow, options) {
    addCall = { flow, options };
    return { job: { id: "flow-job", name: flow.name } };
  };
  const queueConfig = {
    config: {
      queueName: "flowcasts",
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    },
    register() {},
    createFlowProducer() {
      return flowProducer;
    },
    async releaseResource() {},
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({ getNode: () => queueConfig });
  registerBullMQNodes(RED);
  const FlowNode = RED.registered.get("bullmq flow").constructor;
  const node = {};
  FlowNode.call(node, { queue: "queue" });

  const payload = {
    name: "parent",
    queueName: "alpha",
    data: {},
    children: [
      {
        name: "child",
        queueName: "beta",
        data: {},
        opts: { removeOnFail: false },
      },
    ],
  };
  const flowopts = {
    queuesOptions: {
      alpha: {
        defaultJobOptions: { removeOnComplete: 25 },
      },
    },
  };

  await new Promise((resolve, reject) => {
    node.emit(
      "input",
      { payload, flowopts },
      () => {},
      (err) => (err ? reject(err) : resolve()),
    );
  });

  assert.equal(addCall.flow, payload);
  assert.deepEqual(addCall.options, {
    queuesOptions: {
      alpha: {
        defaultJobOptions: { removeOnComplete: 25, removeOnFail: 5000 },
      },
      beta: {
        defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
      },
    },
  });
  assert.deepEqual(payload.children[0].opts, { removeOnFail: false });
});

test("config node createFlowProducer does not attach its own error listener", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bullmq-queue-server").constructor;

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

test("bullmq run reports worker errors on its own node status", () => {
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
  const RunNode = RED.registered.get("bullmq run").constructor;
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

test("bullmq events reports QueueEvents errors on its own node status", async () => {
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
  const EventsNode = RED.registered.get("bullmq events").constructor;
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

test("bullmq cmd reflects the shared producer connection state", () => {
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
  const CmdNode = RED.registered.get("bullmq cmd").constructor;
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

test("bullmq cmd shows connected immediately when the connection is already ready", () => {
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
  const CmdNode = RED.registered.get("bullmq cmd").constructor;
  CmdNode.call({}, { queue: "queue" });

  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });
});

test("bullmq cmd removes its connection listeners on close", async () => {
  const connection = new EventEmitter();
  connection.status = "connecting";
  const RED = createRED({
    getNode() {
      return createCmdQueueConfig(connection);
    },
  });

  registerBullMQNodes(RED);
  const CmdNode = RED.registered.get("bullmq cmd").constructor;
  const node = {};
  CmdNode.call(node, { queue: "queue" });

  assert.ok(
    connection.listenerCount("ready") > 0,
    "bullmq cmd must watch the shared connection",
  );

  const handler = node.listeners("close")[0];
  await promisify(handler).call(node, false);

  assert.equal(connection.listenerCount("ready"), 0);
  assert.equal(connection.listenerCount("close"), 0);
  assert.equal(connection.listenerCount("error"), 0);
});

test("bullmq events shows connecting before the connection is ready", async () => {
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
  const EventsNode = RED.registered.get("bullmq events").constructor;
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

test("bullmq flow shows disconnected when the initial connection fails", async () => {
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
  const FlowNode = RED.registered.get("bullmq flow").constructor;
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
  const Server = RED.registered.get("bullmq-queue-server").constructor;

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
    // Never 0: Node reads 0 as unlimited, but BullMQ's increaseMaxListeners
    // computes getMaxListeners() + n, which turns 0 into a cap of 3.
    assert.notEqual(connection.getMaxListeners(), 0);
    assert.ok(
      connection.getMaxListeners() >= 100,
      `producer connection listener budget too small: ${connection.getMaxListeners()}`,
    );
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
  const Server = RED.registered.get("bullmq-queue-server").constructor;

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

function constructRunNode(config) {
  const createdOptions = [];
  const worker = new EventEmitter();
  worker.close = async function close() {};
  const queueConfig = {
    config: { queueName: "runcasts" },
    register() {},
    createWorker(processor, options) {
      createdOptions.push(options);
      return worker;
    },
    getQueue() {
      return {};
    },
    async releaseResource() {},
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({ getNode: () => queueConfig });
  registerBullMQNodes(RED);
  const node = {};
  RED.registered.get("bullmq run").constructor.call(node, {
    queue: "queue",
    completionMode: "immediate",
    ...config,
  });
  return { createdOptions, node };
}

test("bullmq run applies only a complete positive limiter pair", () => {
  const defaults = constructRunNode({}).createdOptions[0];
  assert.equal(defaults.maxStartedAttempts, 100);
  assert.equal(defaults.limiter, undefined);
  assert.equal(
    constructRunNode({ maxStartedAttempts: "12" }).createdOptions[0]
      .maxStartedAttempts,
    12,
  );
  assert.deepEqual(
    constructRunNode({ limiterMax: "2", limiterDuration: "1000" })
      .createdOptions[0].limiter,
    { max: 2, duration: 1000 },
  );
});

test("bullmq run rejects invalid concurrency and limiter values", () => {
  const cases = [
    [{ limiterMax: "2", limiterDuration: "" }, /set together/i],
    [{ limiterMax: "", limiterDuration: "1000" }, /set together/i],
    [
      { limiterMax: "0", limiterDuration: "1000" },
      /Limiter Max.*positive integer/i,
    ],
    [
      { limiterMax: "2.5", limiterDuration: "1000" },
      /Limiter Max.*positive integer/i,
    ],
    [
      { limiterMax: "2", limiterDuration: "-1" },
      /Limiter Duration.*positive integer/i,
    ],
    [{ concurrency: "0" }, /Concurrency.*positive integer/i],
    [{ maxStartedAttempts: "0" }, /Max Started Attempts.*positive integer/i],
    [{ maxStartedAttempts: "1.5" }, /Max Started Attempts.*positive integer/i],
  ];
  for (const [config, error] of cases) {
    assert.throws(() => constructRunNode(config), error);
  }
});

test("bullmq flow adds an array of trees atomically through addBulk", async () => {
  const calls = [];
  const flowProducer = {
    async waitUntilReady() {},
    async add(flow, opts) {
      calls.push({ method: "add", flow, opts });
      return { job: { id: "1" }, children: [] };
    },
    async addBulk(flows) {
      calls.push({ method: "addBulk", flows });
      return flows.map((flow, index) => ({
        job: { id: String(index + 1), queueName: flow.queueName },
        children: [],
      }));
    },
    on() {},
  };
  const queueConfig = {
    // Queue-level retention must reach bulk jobs too, even though
    // FlowProducer.addBulk takes no options argument.
    config: { queueName: "flowcasts", defaultJobOptions: { removeOnFail: 7 } },
    register() {},
    createFlowProducer: () => flowProducer,
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({ getNode: () => queueConfig });
  registerBullMQNodes(RED);

  const node = {};
  RED.registered.get("bullmq flow").constructor.call(node, { queue: "queue" });

  const outputs = [];
  const trees = [
    { name: "a", queueName: "queue-a", data: {} },
    {
      name: "b",
      queueName: "queue-b",
      data: {},
      opts: { removeOnFail: 99 },
      children: [{ name: "b-child", queueName: "queue-c", data: {} }],
    },
  ];
  await new Promise((resolve) => {
    node.emit(
      "input",
      { payload: trees },
      (msg) => outputs.push(msg),
      () => resolve(),
    );
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "addBulk", "an array must use addBulk");
  assert.equal(calls[0].flows.length, 2);
  // Retention applied where absent, caller's own opts left alone, children too.
  assert.deepEqual(calls[0].flows[0].opts, { removeOnFail: 7 });
  assert.deepEqual(calls[0].flows[1].opts, { removeOnFail: 99 });
  assert.deepEqual(calls[0].flows[1].children[0].opts, { removeOnFail: 7 });
  assert.equal(outputs[0].payload.length, 2);
  assert.equal(outputs[0].payload[1].job.queueName, "queue-b");
});

test("bullmq flow rejects an empty array of trees", async () => {
  const flowProducer = {
    async waitUntilReady() {},
    async addBulk() {
      throw new Error("addBulk must not be called for an empty array");
    },
    on() {},
  };
  const queueConfig = {
    config: { queueName: "flowcasts" },
    register() {},
    createFlowProducer: () => flowProducer,
    deregister(node, done) {
      done();
    },
  };
  const RED = createRED({ getNode: () => queueConfig });
  registerBullMQNodes(RED);

  const node = {};
  RED.registered.get("bullmq flow").constructor.call(node, { queue: "queue" });

  const err = await new Promise((resolve) => {
    node.emit(
      "input",
      { payload: [] },
      () => {},
      (error) => resolve(error),
    );
  });
  assert.match(String(err), /at least one flow tree/);
});
