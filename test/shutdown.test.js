const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");

const registerBullMQNodes = require("../bull-queue");

// Nothing listens on this port: every connection attempt fails immediately
// and ioredis keeps retrying, which is exactly the state a Node-RED user is
// in when Redis is down and they press Ctrl-C.
const DEAD_REDIS = {
  name: "shutdowncasts",
  address: "127.0.0.1",
  port: "6399",
};

const CLOSE_DEADLINE_MS = 4000;

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

function buildServerNode(RED) {
  const Server = RED.registered.get("bull-queue-server").constructor;
  const server = {};
  Server.call(server, DEAD_REDIS);
  return server;
}

async function invokeClose(node) {
  const handler = node.listeners("close")[0];
  assert.ok(handler, "node must register a close handler");
  const signal = new EventEmitter();
  handler.call(node, false, (err) => signal.emit("done", err));
  const [err] = await once(signal, "done");
  if (err) {
    throw err;
  }
}

async function settleWithin(promise, ms) {
  let outcome = "pending";
  (async () => {
    try {
      await promise;
      outcome = "closed";
    } catch (err) {
      outcome = "rejected";
    }
  })();

  const deadline = Date.now() + ms;
  while (outcome === "pending" && Date.now() < deadline) {
    await delay(25);
  }
  return outcome === "pending" ? "timed out" : outcome;
}

function forceCleanup(server) {
  const resources =
    server.resources instanceof Map
      ? Array.from(server.resources.entries()).flat()
      : Array.from(server.resources || []);
  for (const resource of resources) {
    try {
      if (resource.blockingConnection) {
        resource.blockingConnection.disconnect();
      }
      resource.disconnect();
    } catch {
      // best-effort cleanup so the test process can exit
    }
  }
}

test("bull-queue-server close settles promptly when Redis is unreachable", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const server = buildServerNode(RED);

  try {
    server.getQueue();
    await delay(200);

    const result = await settleWithin(invokeClose(server), CLOSE_DEADLINE_MS);
    assert.equal(
      result,
      "closed",
      "config node close must settle while Redis is unreachable",
    );

    // ioredis keeps reporting status "reconnecting" after a disconnect, so
    // assert the meaningful invariant instead: no reconnection attempt fires
    // after close. The default retry backoff is capped at 2000ms, so a quiet
    // 2200ms window proves the retry timer is gone and the process can exit.
    let attemptsAfterClose = 0;
    const countAttempt = () => {
      attemptsAfterClose += 1;
    };
    for (const resource of server.resources) {
      if (typeof resource.status === "string") {
        resource.on("reconnecting", countAttempt);
        resource.on("connect", countAttempt);
      }
    }
    await delay(2200);
    assert.equal(
      attemptsAfterClose,
      0,
      "raw Redis connections must stop reconnecting after close",
    );
  } finally {
    forceCleanup(server);
  }
});

test("bull run close settles promptly when Redis is unreachable", async () => {
  let server;
  const RED = createRED({
    getNode() {
      return server;
    },
  });
  registerBullMQNodes(RED);
  server = buildServerNode(RED);
  const RunNode = RED.registered.get("bull run").constructor;
  const runNode = {};

  try {
    RunNode.call(runNode, { queue: "queue", completionMode: "immediate" });
    await delay(200);

    const result = await settleWithin(invokeClose(runNode), CLOSE_DEADLINE_MS);
    assert.equal(
      result,
      "closed",
      "bull run close must settle while Redis is unreachable",
    );

    const serverResult = await settleWithin(
      invokeClose(server),
      CLOSE_DEADLINE_MS,
    );
    assert.equal(serverResult, "closed");
  } finally {
    forceCleanup(server);
  }
});

test("bull events close settles promptly when Redis is unreachable", async () => {
  let server;
  const RED = createRED({
    getNode() {
      return server;
    },
  });
  registerBullMQNodes(RED);
  server = buildServerNode(RED);
  const EventsNode = RED.registered.get("bull events").constructor;
  const eventsNode = {};

  try {
    EventsNode.call(eventsNode, { queue: "queue" });
    await delay(200);

    const result = await settleWithin(
      invokeClose(eventsNode),
      CLOSE_DEADLINE_MS,
    );
    assert.equal(
      result,
      "closed",
      "bull events close must settle while Redis is unreachable",
    );

    const serverResult = await settleWithin(
      invokeClose(server),
      CLOSE_DEADLINE_MS,
    );
    assert.equal(serverResult, "closed");
  } finally {
    forceCleanup(server);
  }
});

test("bull flow close settles promptly when Redis is unreachable", async () => {
  let server;
  const RED = createRED({
    getNode() {
      return server;
    },
  });
  registerBullMQNodes(RED);
  server = buildServerNode(RED);
  const FlowNode = RED.registered.get("bull flow").constructor;
  const flowNode = {};

  try {
    FlowNode.call(flowNode, { queue: "queue" });
    await delay(200);

    const result = await settleWithin(invokeClose(flowNode), CLOSE_DEADLINE_MS);
    assert.equal(
      result,
      "closed",
      "bull flow close must settle while Redis is unreachable",
    );

    const serverResult = await settleWithin(
      invokeClose(server),
      CLOSE_DEADLINE_MS,
    );
    assert.equal(serverResult, "closed");
  } finally {
    forceCleanup(server);
  }
});

test("runtime partial closes release raw Redis connections", async () => {
  let server;
  const RED = createRED({ getNode: () => server });
  registerBullMQNodes(RED);
  server = buildServerNode(RED);
  const runNode = {};
  const eventsNode = {};
  const flowNode = {};
  const runtimeNodes = [runNode, eventsNode, flowNode];

  try {
    RED.registered.get("bull run").constructor.call(runNode, {
      queue: "queue",
      completionMode: "immediate",
    });
    RED.registered
      .get("bull events")
      .constructor.call(eventsNode, { queue: "queue" });
    RED.registered
      .get("bull flow")
      .constructor.call(flowNode, { queue: "queue" });
    await delay(200);

    assert.ok(server.resources instanceof Map);
    const ownedResources = [
      {
        owner: runNode.worker,
        connection: server.resources.get(runNode.worker),
      },
      {
        owner: eventsNode.queueEvents,
        connection: server.resources.get(eventsNode.queueEvents),
      },
      {
        owner: flowNode.flowProducer,
        connection: server.resources.get(flowNode.flowProducer),
      },
    ];
    for (const { connection } of ownedResources) {
      assert.ok(connection, "factory must track the owner's raw connection");
    }

    await Promise.all(runtimeNodes.map(invokeClose));
    for (const { owner } of ownedResources) {
      assert.equal(server.resources.has(owner), false);
    }

    let attemptsAfterClose = 0;
    for (const { connection } of ownedResources) {
      connection.on("reconnecting", () => {
        attemptsAfterClose += 1;
      });
      connection.on("connect", () => {
        attemptsAfterClose += 1;
      });
    }
    await delay(2200);
    assert.equal(attemptsAfterClose, 0);
  } finally {
    for (const runtimeNode of runtimeNodes) {
      await settleWithin(invokeClose(runtimeNode), CLOSE_DEADLINE_MS);
    }
    await settleWithin(invokeClose(server), CLOSE_DEADLINE_MS);
    forceCleanup(server);
  }
});

test("config close starts independent resource pairs concurrently", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const server = buildServerNode(RED);
  const started = [];
  const ownerGate = new EventEmitter();
  const connectionGate = new EventEmitter();
  const resource = (name, gate) => ({
    async close() {
      started.push(name);
      await once(gate, "release");
    },
  });
  server.resources = new Map([
    [resource("owner-a", ownerGate), resource("connection-a", connectionGate)],
    [resource("owner-b", ownerGate), resource("connection-b", connectionGate)],
  ]);

  const closing = invokeClose(server);
  try {
    await delay(0);
    assert.deepEqual(started.slice().sort(), ["owner-a", "owner-b"]);
    ownerGate.emit("release");
    await delay(0);
    assert.deepEqual(started.slice().sort(), [
      "connection-a",
      "connection-b",
      "owner-a",
      "owner-b",
    ]);
    connectionGate.emit("release");
    await closing;
  } finally {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ownerGate.emit("release");
      connectionGate.emit("release");
      await delay(0);
    }
    await closing;
  }
});

test("config close force-disconnects by awaiting the public disconnect() API", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const server = buildServerNode(RED);

  const neverGate = new EventEmitter();
  const events = [];
  const owner = {
    async close() {
      // Never settles, forcing the CLOSE_GRACE_MS fallback to fire.
      await once(neverGate, "release");
    },
    async disconnect() {
      events.push("disconnect-start");
      await delay(30);
      events.push("disconnect-end");
    },
    get connection() {
      throw new Error("must not read resource.connection");
    },
    get blockingConnection() {
      throw new Error("must not read resource.blockingConnection");
    },
    get _client() {
      throw new Error("must not read resource._client");
    },
    getBackend() {
      throw new Error("must not call resource.getBackend()");
    },
  };
  const connection = { async close() {} };
  server.resources = new Map([[owner, connection]]);

  try {
    const result = await settleWithin(invokeClose(server), CLOSE_DEADLINE_MS);
    assert.equal(
      result,
      "closed",
      "config close must settle by force-disconnecting through disconnect()",
    );
    assert.deepEqual(
      events,
      ["disconnect-start", "disconnect-end"],
      "close must call and fully await resource.disconnect(), not fire-and-forget it",
    );
  } finally {
    neverGate.emit("release");
    forceCleanup(server);
  }
});

// Measured against installed BullMQ 6.2.1: when the connection never became
// ready (e.g. Redis unreachable), disconnect() itself awaits the same
// ready-promise as close() and never settles either -- confirmed with a
// direct QueueEvents.disconnect() run against a dead Redis (see report). So
// the fallback below is required, not optional: when disconnect() ALSO times
// out, forceDisconnect must escalate to the backend's raw clients so the
// process can still exit.
test("config close escalates to the backend's raw clients when disconnect() also hangs", async () => {
  const RED = createRED();
  registerBullMQNodes(RED);
  const server = buildServerNode(RED);

  const neverGate = new EventEmitter();
  const rawDisconnectCalls = [];
  const fakeClient = (name) => ({
    disconnect(wait) {
      rawDisconnectCalls.push({ name, wait });
    },
  });
  const stopped = [];
  const owner = {
    async close() {
      await once(neverGate, "release");
    },
    async disconnect() {
      await once(neverGate, "release");
    },
    getBackend() {
      return {
        connection: { _client: fakeClient("connection") },
        blockingConnection: { _client: fakeClient("blockingConnection") },
      };
    },
    // A Worker keeps two self-rescheduling timers that only its own close()
    // clears, and that close() is exactly what hung above.
    lockManager: {
      async close() {
        stopped.push("lockManager");
      },
    },
    stalledCheckStopper() {
      stopped.push("stalledChecker");
    },
  };
  const connection = { async close() {} };
  server.resources = new Map([[owner, connection]]);

  try {
    const result = await settleWithin(invokeClose(server), CLOSE_DEADLINE_MS);
    assert.equal(
      result,
      "closed",
      "config close must settle even when both close() and disconnect() hang",
    );
    assert.deepEqual(
      rawDisconnectCalls.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "blockingConnection", wait: false },
        { name: "connection", wait: false },
      ],
      "forceDisconnect must fall back to disconnecting the backend's raw clients",
    );
    assert.deepEqual(
      stopped.sort(),
      ["lockManager", "stalledChecker"],
      "forceDisconnect must stop the worker timers that the hung close() never reached",
    );
  } finally {
    neverGate.emit("release");
    forceCleanup(server);
  }
});

test("bull run reports a uniform disconnected status when Redis is unreachable", async () => {
  let server;
  const statuses = [];
  const RED = createRED({
    getNode() {
      return server;
    },
    status(status) {
      statuses.push(status);
    },
  });
  registerBullMQNodes(RED);
  server = buildServerNode(RED);
  const RunNode = RED.registered.get("bull run").constructor;
  const runNode = {};

  try {
    RunNode.call(runNode, { queue: "queue", completionMode: "immediate" });

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !statuses.some((status) => status.fill === "red")
    ) {
      await delay(50);
    }

    const redStatuses = statuses.filter((status) => status.fill === "red");
    assert.ok(redStatuses.length > 0, "a red status must be reported");
    for (const status of redStatuses) {
      assert.deepEqual(status, {
        fill: "red",
        shape: "ring",
        text: "disconnected",
      });
    }
  } finally {
    try {
      await settleWithin(invokeClose(runNode), CLOSE_DEADLINE_MS);
      await settleWithin(invokeClose(server), CLOSE_DEADLINE_MS);
    } finally {
      forceCleanup(server);
    }
  }
});
