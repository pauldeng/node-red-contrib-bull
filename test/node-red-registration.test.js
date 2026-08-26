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

// The config node owns live backend status; bullmq cmd only reads it. This
// fake stands in for that ownership so the cmd tests cover the mapping and
// the unsubscribe, while the ownership logic itself is tested directly
// against a real config node further down.
function createCmdQueueConfig(initialStatus = "connecting") {
  const readers = new Set();
  return {
    config: { queueName: "cmdcasts" },
    status: initialStatus,
    register(node) {
      node.status({ fill: "grey", shape: "ring", text: "configured" });
    },
    getQueue() {
      return { getBackend: () => new EventEmitter() };
    },
    readBackendStatus(read) {
      readers.add(read);
      read(this.status);
      return () => readers.delete(read);
    },
    publish(status) {
      this.status = status;
      for (const read of readers) {
        read(status);
      }
    },
    readerCount() {
      return readers.size;
    },
    deregister(node, done) {
      done();
    },
  };
}

test("bullmq cmd mirrors the config node's live backend status", () => {
  const statuses = [];
  const queueConfig = createCmdQueueConfig("connecting");
  const RED = createRED({
    getNode() {
      return queueConfig;
    },
    status(status) {
      statuses.push(status);
    },
  });

  registerBullMQNodes(RED);
  RED.registered.get("bullmq cmd").constructor.call({}, { queue: "queue" });

  assert.ok(
    !statuses.some(
      (status) => status.fill === "green" && status.text === "configured",
    ),
    "must not show a green configured dot while the backend is not connected",
  );
  assert.deepEqual(statuses.at(-1), {
    fill: "yellow",
    shape: "ring",
    text: "connecting",
  });

  queueConfig.publish("connected");
  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });

  queueConfig.publish("disconnected");
  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
});

test("bullmq cmd deployed against an already-connected backend shows connected at once", () => {
  const statuses = [];
  // The case a missed "ready" event would strand on yellow forever.
  const queueConfig = createCmdQueueConfig("connected");
  const RED = createRED({
    getNode: () => queueConfig,
    status: (status) => statuses.push(status),
  });

  registerBullMQNodes(RED);
  RED.registered.get("bullmq cmd").constructor.call({}, { queue: "queue" });

  assert.deepEqual(statuses.at(-1), {
    fill: "green",
    shape: "dot",
    text: "connected",
  });
});

test("bullmq cmd deployed during an outage shows disconnected, not a stale green", () => {
  const statuses = [];
  // waitUntilReady() would resolve instantly here (it is memoized from a
  // successful connect), so reading the config node's live state is the only
  // thing that keeps this from painting a false "connected".
  const queueConfig = createCmdQueueConfig("disconnected");
  const RED = createRED({
    getNode: () => queueConfig,
    status: (status) => statuses.push(status),
  });

  registerBullMQNodes(RED);
  RED.registered.get("bullmq cmd").constructor.call({}, { queue: "queue" });

  assert.deepEqual(statuses.at(-1), {
    fill: "red",
    shape: "ring",
    text: "disconnected",
  });
  assert.equal(
    statuses.some((status) => status.text === "connected"),
    false,
  );
});

test("bullmq cmd stops reading the shared status on close", async () => {
  const queueConfig = createCmdQueueConfig("connecting");
  const RED = createRED({ getNode: () => queueConfig });

  registerBullMQNodes(RED);
  const node = {};
  RED.registered.get("bullmq cmd").constructor.call(node, { queue: "queue" });
  assert.equal(queueConfig.readerCount(), 1);

  await promisify(node.listeners("close")[0]).call(node, false);
  assert.equal(
    queueConfig.readerCount(),
    0,
    "a closed node must stop reading, or every redeploy leaks a reader",
  );
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
    assert.ok(node.queue, "the shared queue must be created with it");
    // Backend listeners must not grow with the number of readers. That
    // invariant is what replaced the old listener budget: with no per-node
    // accumulation there is nothing to raise a ceiling for. BullMQ keeps its
    // own error/close listeners here too, so compare counts rather than
    // asserting an absolute number.
    const backend = node.queue.getBackend();
    const before = ["ready", "error", "close"].map((event) =>
      backend.listenerCount(event),
    );
    node.readBackendStatus(() => {});
    node.readBackendStatus(() => {});
    node.readBackendStatus(() => {});
    assert.deepEqual(
      ["ready", "error", "close"].map((event) => backend.listenerCount(event)),
      before,
      "readers must not each attach to the backend",
    );
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

test("a closed bullmq cmd is never touched by a later status change", async () => {
  const statuses = [];
  const queueConfig = createCmdQueueConfig("connecting");
  const RED = createRED({
    getNode: () => queueConfig,
    status: (status) => statuses.push(status),
  });

  registerBullMQNodes(RED);
  const node = {};
  RED.registered.get("bullmq cmd").constructor.call(node, { queue: "queue" });
  await promisify(node.listeners("close")[0]).call(node, false);
  const afterClose = statuses.length;

  // The config node keeps living and keeps publishing; a closed reader must
  // not hear it. Unsubscribing on close makes that structural rather than
  // something a flag has to remember.
  queueConfig.publish("connected");

  assert.equal(
    statuses.length,
    afterClose,
    `status must not change after close, saw ${JSON.stringify(statuses.slice(afterClose))}`,
  );
  assert.equal(
    statuses.some((status) => status.text === "connected"),
    false,
  );
});

test("config node keeps a live event over the memoized readiness promise", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bullmq-queue-server").constructor;
  const node = {};
  Server.call(node, { name: "livecasts" });

  // waitUntilReady() resolves instantly here, which is exactly what happens
  // after a successful connect: RedisQueueBackend awaits connection.client,
  // the promise built once in the constructor, and PostgresConnection memoizes
  // readyPromise the same way. It says "was ready once", never "is ready now".
  const backend = new EventEmitter();
  backend.waitUntilReady = () => Promise.resolve();

  node.watchBackend(backend);
  // The datastore drops before the seed lands. The live event must win, or the
  // node paints a green "connected" during the outage it exists to surface.
  backend.emit("error", new Error("connection lost"));
  await tick();
  await tick();

  assert.equal(node.backendStatus, "disconnected");

  // And a reader attaching mid-outage sees the outage, not the stale promise.
  const seen = [];
  node.readBackendStatus((status) => seen.push(status));
  assert.deepEqual(seen, ["disconnected"]);

  // Recovery still works, through the live event.
  backend.emit("ready");
  assert.deepEqual(seen, ["disconnected", "connected"]);
});

test("config node reports disconnected when readiness rejects with no event", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bullmq-queue-server").constructor;
  const node = {};
  Server.call(node, { name: "rejectcasts" });

  // PostgresConnection.bootstrap() rejects on connect, auth, migration, or
  // schema failure and emits nothing: its emitError only forwards idle-pool
  // and LISTEN errors, and only when a listener is already attached. So a
  // rejection with no event is the postgres failure path, not a corner case.
  const backend = new EventEmitter();
  backend.waitUntilReady = () => Promise.reject(new Error("ECONNREFUSED"));

  node.watchBackend(backend);
  await tick();
  await tick();

  assert.equal(
    node.backendStatus,
    "disconnected",
    "a rejected readiness promise must not leave the node on connecting",
  );

  const seen = [];
  node.readBackendStatus((status) => seen.push(status));
  assert.deepEqual(seen, ["disconnected"]);
});

test("config node reports why the backend is unavailable, not just that it is", async () => {
  const errors = [];
  const RED = createRED({ error: (err) => errors.push(String(err)) });
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bullmq-queue-server").constructor;
  const node = {};
  Server.call(node, { name: "whycasts" });

  // The PostgreSQL failure shape: bootstrap() rejects and emits nothing, so
  // this catch is the only place a bad password or a migration failure can
  // reach the user.
  const backend = new EventEmitter();
  backend.waitUntilReady = () =>
    Promise.reject(new Error("password authentication failed"));

  node.watchBackend(backend);
  await tick();
  await tick();

  assert.equal(node.backendStatus, "disconnected");
  assert.equal(errors.length, 1, "exactly one report, not one per retry");
  assert.match(errors[0], /password authentication failed/);
});
