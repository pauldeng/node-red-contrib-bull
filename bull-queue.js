"use strict";

const {
  FlowProducer,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
} = require("bullmq");
const IORedis = require("ioredis");
const { setTimeout: sleep } = require("node:timers/promises");

const {
  AcknowledgementRegistry,
  parseAckTimeoutMs,
} = require("./lib/acknowledgements");
const { dispatchCommand } = require("./lib/commands");
const {
  buildBullMQOptions,
  buildRedisDescriptor,
  createRedisConnection,
  normalizeQueueConfig,
} = require("./lib/connections");
const { serializeFlowJob, serializeJob } = require("./lib/serialization");

const DEFAULT_EVENTS = [
  "active",
  "added",
  "cleaned",
  "completed",
  "deduplicated",
  "delayed",
  "drained",
  "duplicated",
  "failed",
  "paused",
  "progress",
  "removed",
  "resumed",
  "stalled",
  "waiting",
  "waiting-children",
];

// How long a graceful close may take before the underlying sockets are
// force-disconnected so Node-RED shutdown and redeploy are never blocked by
// an unreachable Redis server.
const CLOSE_GRACE_MS = 1000;

async function settled(promise) {
  try {
    await promise;
  } catch (err) {
    // a failed graceful close still counts as settled
  }
  return "settled";
}

async function timedOut(ms) {
  await sleep(ms);
  return "timeout";
}

async function settleWithin(promise, ms) {
  return await Promise.race([settled(promise), timedOut(ms)]);
}

function disconnectClient(client) {
  if (client && typeof client.disconnect === "function") {
    try {
      client.disconnect(false);
    } catch (err) {
      // best effort: the socket may already be gone
    }
  }
}

function forceDisconnect(resource) {
  if (!resource) {
    return;
  }
  if (typeof resource.status === "string") {
    // Raw ioredis connection.
    disconnectClient(resource);
    return;
  }
  // BullMQ resource. Its public disconnect() awaits a connection promise that
  // never settles while Redis is unreachable, so reach for the underlying
  // ioredis clients directly (BullMQ is pinned to exactly 5.80.6).
  if (resource.connection) {
    disconnectClient(resource.connection._client);
  }
  if (resource.blockingConnection) {
    disconnectClient(resource.blockingConnection._client);
  }
}

async function closeResource(resource) {
  if (!resource) {
    return;
  }

  if (typeof resource.close !== "function") {
    // Raw ioredis connection: quit() never settles (or leaves a reconnect
    // loop running) while the server is unreachable, so only quit ready
    // connections and force-disconnect everything else.
    if (resource.status === "ready" && typeof resource.quit === "function") {
      if ((await settleWithin(resource.quit(), CLOSE_GRACE_MS)) === "timeout") {
        forceDisconnect(resource);
      }
    } else {
      forceDisconnect(resource);
    }
    return;
  }

  // BullMQ resource: QueueEvents.close() blocks forever on a connection that
  // never became ready, so cap the graceful close and force-disconnect the
  // sockets when it does not settle in time.
  if ((await settleWithin(resource.close(), CLOSE_GRACE_MS)) === "timeout") {
    forceDisconnect(resource);
  }
}

async function closeResourcePair(owner, connection) {
  let firstError;
  try {
    await closeResource(owner);
  } catch (err) {
    firstError = err;
  }
  try {
    await closeResource(connection);
  } catch (err) {
    firstError ||= err;
  }
  if (firstError) {
    throw firstError;
  }
}

function nodeSend(node, send, msg) {
  (send || node.send).call(node, msg);
}

function nodeDone(node, done, err, msg) {
  if (done) {
    done(err);
  } else if (err) {
    node.error(err, msg);
  }
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseEventFilter(value) {
  if (!value) {
    return DEFAULT_EVENTS;
  }
  return String(value)
    .split(/[\n,]+/)
    .map((event) => event.trim())
    .filter(Boolean);
}

// One status vocabulary for every queue-backed node: connecting (yellow),
// connected (green), disconnected (red).
function setConnecting(node) {
  node.status({ fill: "yellow", shape: "ring", text: "connecting" });
}

function setConnected(node) {
  node.status({ fill: "green", shape: "dot", text: "connected" });
}

function setDisconnected(node) {
  node.status({ fill: "red", shape: "ring", text: "disconnected" });
}

function attachErrorListener(resource, node) {
  if (!resource || typeof resource.on !== "function") {
    return;
  }
  resource.on("error", (err) => {
    setDisconnected(node);
    node.error(err);
  });
}

function createJobMessage(job, queueName, extraBull = {}) {
  const data = job.data || {};
  return {
    payload:
      data && Object.prototype.hasOwnProperty.call(data, "payload")
        ? data.payload
        : data,
    job: serializeJob(job),
    bull: {
      queue: queueName,
      jobId: job.id,
      ...extraBull,
    },
  };
}

module.exports = function registerBullMQNodes(RED) {
  const acknowledgements = new AcknowledgementRegistry();

  function BullQueueServerSetup(n) {
    RED.nodes.createNode(this, n);
    const node = this;

    node.users = {};
    node.resources = new Map();
    node.config = normalizeQueueConfig(n, node.credentials || {});
    node.queue = null;
    node.producerConnection = null;

    node.register = function register(bullNode) {
      node.users[bullNode.id] = bullNode;
      bullNode.status({
        fill: "grey",
        shape: "ring",
        text: "configured",
      });
    };

    node.deregister = function deregister(bullNode, done) {
      delete node.users[bullNode.id];
      done();
    };

    // owner is the node whose status should reflect connection errors. It
    // defaults to the config node (shared producer/queue), but runtime nodes
    // pass themselves so errors surface on their own visible status.
    node.createConnection = function createConnection(role, owner = node) {
      const descriptor = buildRedisDescriptor(node.config, role);
      const connection = createRedisConnection(descriptor, IORedis);
      attachErrorListener(connection, owner);
      return connection;
    };

    node.releaseResource = async function releaseResource(owner) {
      if (!node.resources.has(owner)) {
        return;
      }
      const connection = node.resources.get(owner);
      node.resources.delete(owner);
      await closeResourcePair(owner, connection);
    };

    node.getQueue = function getQueue() {
      if (!node.queue) {
        node.producerConnection = node.createConnection("producer");
        node.producerConnection.setMaxListeners(0);
        node.queue = new Queue(
          node.config.queueName,
          buildBullMQOptions(node.config, node.producerConnection)
        );
        node.resources.set(node.queue, node.producerConnection);
        attachErrorListener(node.queue, node);
      }
      return node.queue;
    };

    // The producer connection backs the shared queue used by bull cmd nodes;
    // exposing it lets those nodes mirror the real connection state.
    node.getProducerConnection = function getProducerConnection() {
      node.getQueue();
      return node.producerConnection;
    };

    // Runtime nodes pass themselves as owner and attach their own resource
    // error listener, so worker/events/flow errors surface on the visible
    // runtime node rather than the hidden config node.
    node.createWorker = function createWorker(processor, options, owner = node) {
      const connection = node.createConnection("worker", owner);
      const worker = new Worker(node.config.queueName, processor, {
        ...buildBullMQOptions(node.config, connection),
        ...options,
      });
      node.resources.set(worker, connection);
      return worker;
    };

    node.createQueueEvents = function createQueueEvents(owner = node) {
      const connection = node.createConnection("events", owner);
      const queueEvents = new QueueEvents(
        node.config.queueName,
        buildBullMQOptions(node.config, connection)
      );
      node.resources.set(queueEvents, connection);
      return queueEvents;
    };

    node.createFlowProducer = function createFlowProducer(owner = node) {
      const connection = node.createConnection("producer", owner);
      const flowProducer = new FlowProducer(
        buildBullMQOptions(node.config, connection)
      );
      node.resources.set(flowProducer, connection);
      return flowProducer;
    };

    node.on("close", async function onClose(removed, done) {
      try {
        const resources = Array.from(node.resources.entries()).reverse();
        node.resources.clear();
        await Promise.all(
          resources.map(([owner, connection]) =>
            closeResourcePair(owner, connection)
          )
        );
        node.status({});
        done();
      } catch (err) {
        done(err);
      }
    });
  }

  RED.nodes.registerType("bull-queue-server", BullQueueServerSetup, {
    credentials: {
      password: { type: "password" },
      sentinelPassword: { type: "password" },
      tlsCa: { type: "password" },
      tlsCert: { type: "password" },
      tlsKey: { type: "password" },
    },
  });

  function BullQueueCmdNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.queue = n.queue;
    node.bullConn = RED.nodes.getNode(node.queue);

    if (!node.bullConn) {
      node.status({ fill: "red", shape: "ring", text: "missing queue" });
      node.error("Missing bull-queue-server config node");
      return;
    }

    node.bullConn.register(node);

    // Watch the shared producer connection so the visible status reflects
    // whether Redis is actually reachable instead of a static "configured".
    const connection = node.bullConn.getProducerConnection();
    const connectionListeners = {
      ready: () => setConnected(node),
      error: () => setDisconnected(node),
      close: () => setDisconnected(node),
    };
    for (const [event, listener] of Object.entries(connectionListeners)) {
      connection.on(event, listener);
    }
    if (connection.status === "ready") {
      setConnected(node);
    } else {
      setConnecting(node);
    }

    node.on("input", async function onInput(msg, send, done) {
      try {
        const result = await dispatchCommand(node.bullConn.getQueue(), msg);
        msg.payload = result;
        nodeSend(node, send, msg);
        nodeDone(node, done);
      } catch (err) {
        nodeDone(node, done, err, msg);
      }
    });

    node.on("close", function onClose(removed, done) {
      for (const [event, listener] of Object.entries(connectionListeners)) {
        connection.removeListener(event, listener);
      }
      node.bullConn.deregister(node, done);
    });
  }

  function BullQueueRunNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.queue = n.queue;
    node.bullQueue = RED.nodes.getNode(node.queue);
    node.completionMode = n.completionMode || "immediate";

    if (!node.bullQueue) {
      node.status({ fill: "red", shape: "ring", text: "missing queue" });
      node.error("Missing bull-queue-server config node");
      return;
    }

    node.bullQueue.register(node);

    const workerOptions = {
      concurrency: parsePositiveInteger(n.concurrency, 1),
    };
    if (n.limiterMax && n.limiterDuration) {
      workerOptions.limiter = {
        max: parsePositiveInteger(n.limiterMax),
        duration: parsePositiveInteger(n.limiterDuration),
      };
    }

    const processor = async (job) => {
      if (node.completionMode === "manual") {
        const timeoutMs = parseAckTimeoutMs(n.ackTimeout);
        const acknowledgement = acknowledgements.create(
          {
            job,
            queue: node.bullQueue.getQueue(),
            queueName: node.bullQueue.config.queueName,
            runNodeId: node.id,
          },
          timeoutMs
        );
        node.send(
          createJobMessage(job, node.bullQueue.config.queueName, {
            ackId: acknowledgement.ackId,
            runNodeId: node.id,
          })
        );
        return await acknowledgement.entry.wait();
      }

      const msg = createJobMessage(job, node.bullQueue.config.queueName);
      node.send(msg);
      return msg.payload;
    };

    node.worker = node.bullQueue.createWorker(processor, workerOptions, node);
    attachErrorListener(node.worker, node);
    node.worker.on("ready", () => setConnected(node));
    node.worker.on("closed", () => setDisconnected(node));
    setConnecting(node);

    node.on("close", async function onClose(removed, done) {
      acknowledgements.rejectByRunNode(
        node.id,
        new Error("BullMQ run node closed before acknowledgement")
      );
      try {
        await node.bullQueue.releaseResource(node.worker);
        node.bullQueue.deregister(node, () => {});
        done();
      } catch (err) {
        done(err);
      }
    });
  }

  function BullJobNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.action = n.action || "complete";

    node.on("input", async function onInput(msg, send, done) {
      try {
        const ackId = msg.bull && msg.bull.ackId;
        const context = acknowledgements.get(ackId);
        const action = msg.cmd || node.action;

        switch (action) {
          case "progress":
            await context.job.updateProgress(
              msg.progress !== undefined ? msg.progress : msg.payload
            );
            msg.payload = serializeJob(context.job);
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          case "removeDeduplicationKey":
            msg.payload = await context.job.removeDeduplicationKey();
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          case "getChildrenValues":
            msg.payload = await context.job.getChildrenValues();
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          case "getFailedChildrenValues":
            msg.payload = await context.job.getFailedChildrenValues();
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          case "removeUnprocessedChildren":
            msg.payload = await context.job.removeUnprocessedChildren();
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          case "complete": {
            const result = msg.result !== undefined ? msg.result : msg.payload;
            context.complete(result);
            msg.payload = result;
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          }
          case "fail": {
            const error =
              msg.error instanceof Error
                ? msg.error
                : new Error(String(msg.error || msg.payload));
            context.fail(error);
            nodeDone(node, done);
            return;
          }
          case "failUnrecoverable": {
            const errorText = String(
              msg.error || msg.payload || "Unrecoverable BullMQ job failure"
            );
            context.fail(new UnrecoverableError(errorText));
            nodeDone(node, done);
            return;
          }
          case "rateLimit":
            await context.queue.rateLimit(msg.duration);
            context.fail(Worker.RateLimitError());
            nodeDone(node, done);
            return;
          default:
            throw new Error(`Unsupported bull job action: ${action}`);
        }
      } catch (err) {
        nodeDone(node, done, err, msg);
      }
    });
  }

  function BullEventsNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.queue = n.queue;
    node.bullConn = RED.nodes.getNode(node.queue);

    if (!node.bullConn) {
      node.status({ fill: "red", shape: "ring", text: "missing queue" });
      node.error("Missing bull-queue-server config node");
      return;
    }

    node.bullConn.register(node);
    node.queueEvents = node.bullConn.createQueueEvents(node);
    attachErrorListener(node.queueEvents, node);
    const events = parseEventFilter(n.events);
    for (const event of events) {
      node.queueEvents.on(event, (payload, eventId) => {
        node.send({
          topic: event,
          payload,
          bull: {
            queue: node.bullConn.config.queueName,
            event,
            eventId,
          },
        });
      });
    }
    async function updateReadyStatus() {
      try {
        setConnecting(node);
        await node.queueEvents.waitUntilReady();
        setConnected(node);
      } catch (err) {
        setDisconnected(node);
        node.error(err);
      }
    }
    updateReadyStatus();

    node.on("close", async function onClose(removed, done) {
      try {
        await node.bullConn.releaseResource(node.queueEvents);
        node.bullConn.deregister(node, () => {});
        done();
      } catch (err) {
        done(err);
      }
    });
  }

  function BullFlowNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.queue = n.queue;
    node.bullConn = RED.nodes.getNode(node.queue);

    if (!node.bullConn) {
      node.status({ fill: "red", shape: "ring", text: "missing queue" });
      node.error("Missing bull-queue-server config node");
      return;
    }

    node.bullConn.register(node);
    node.flowProducer = node.bullConn.createFlowProducer(node);
    attachErrorListener(node.flowProducer, node);
    async function updateReadyStatus() {
      try {
        setConnecting(node);
        await node.flowProducer.waitUntilReady();
        setConnected(node);
      } catch (err) {
        setDisconnected(node);
        node.error(err);
      }
    }
    updateReadyStatus();

    node.on("input", async function onInput(msg, send, done) {
      try {
        if (!msg.payload || typeof msg.payload !== "object") {
          throw new Error("bull flow requires msg.payload to contain a flow tree");
        }
        msg.payload = serializeFlowJob(
          await node.flowProducer.add(msg.payload, msg.flowopts)
        );
        nodeSend(node, send, msg);
        nodeDone(node, done);
      } catch (err) {
        nodeDone(node, done, err, msg);
      }
    });

    node.on("close", async function onClose(removed, done) {
      try {
        await node.bullConn.releaseResource(node.flowProducer);
        node.bullConn.deregister(node, () => {});
        done();
      } catch (err) {
        done(err);
      }
    });
  }

  RED.nodes.registerType("bull cmd", BullQueueCmdNode);
  RED.nodes.registerType("bull run", BullQueueRunNode);
  RED.nodes.registerType("bull job", BullJobNode);
  RED.nodes.registerType("bull events", BullEventsNode);
  RED.nodes.registerType("bull flow", BullFlowNode);
};
