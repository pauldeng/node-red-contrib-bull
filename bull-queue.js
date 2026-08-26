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
const { version: PACKAGE_VERSION } = require("./package.json");

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
  "retries-exhausted",
  "stalled",
  "waiting",
  "waiting-children",
];

// How long a graceful close may take before the underlying sockets are
// force-disconnected so Node-RED shutdown and redeploy are never blocked by
// an unreachable Redis server.
const CLOSE_GRACE_MS = 1000;

// A connection that is actually ready gets a longer budget: Worker.close()
// waits for in-flight jobs, and cutting that off abandons a running job to the
// stalled checker, which re-runs it and can eventually fail it for exceeding
// maxStalledCount. The ceiling stays well under Node-RED's own ~15s node close
// timeout, and resources close concurrently, so this bounds one resource, not
// the sum.
const GRACEFUL_CLOSE_MS = 10000;

// Shared producer connection listener budget: every bullmq cmd node adds
// ready/error/close listeners to it, and BullMQ adds its own on top.
const PRODUCER_MAX_LISTENERS = 1000;

function closeBudgetFor(connection) {
  return connection && connection.status === "ready"
    ? GRACEFUL_CLOSE_MS
    : CLOSE_GRACE_MS;
}

async function settled(promise) {
  try {
    await promise;
  } catch (err) {
    // a failed graceful close still counts as settled
  }
  return "settled";
}

async function settleWithin(promise, ms) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      settled(promise),
      sleep(ms, "timeout", { signal: controller.signal }),
    ]);
  } finally {
    controller.abort();
  }
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

async function forceDisconnect(resource) {
  if (!resource) {
    return;
  }
  if (typeof resource.status === "string") {
    // Raw ioredis connection.
    disconnectClient(resource);
    return;
  }
  // BullMQ 6.2.1's public disconnect() can await the same never-ready promise
  // as close(), which would spend a second shutdown budget after the first one
  // already expired. The exact BullMQ pin makes this one backend escape hatch
  // deliberate and testable until upstream disconnect becomes bounded.
  if (typeof resource.getBackend !== "function") {
    return;
  }
  const backend = resource.getBackend();
  disconnectClient(backend && backend.connection && backend.connection._client);
  disconnectClient(
    backend && backend.blockingConnection && backend.blockingConnection._client,
  );
  // Measured on installed BullMQ 6.2.1: a Worker's close() never reaches this
  // point on its own here, because its very first cleanup step awaits the
  // same stuck connection above. That means the lock-renewal timer it starts
  // on construction (independent of connection state) is never cancelled by
  // Worker's own close() -- stop it here directly so it cannot outlive the
  // resource and keep the process alive.
  if (resource.lockManager && typeof resource.lockManager.close === "function") {
    await resource.lockManager.close();
  }
  // Same reasoning for the stalled-job checker: Worker.close() only stops it
  // after the cleanup step that hung above, and each check reschedules its own
  // timer. This one is only live if the worker processed at least once before
  // Redis went away -- the common production case, unlike a connection that was
  // never reachable at all.
  if (typeof resource.stalledCheckStopper === "function") {
    resource.stalledCheckStopper();
  }
}

async function closeResource(resource, connection) {
  if (!resource) {
    return;
  }

  if (typeof resource.close !== "function") {
    // Raw ioredis connection: quit() never settles (or leaves a reconnect
    // loop running) while the server is unreachable, so only quit ready
    // connections and force-disconnect everything else.
    if (resource.status === "ready" && typeof resource.quit === "function") {
      if ((await settleWithin(resource.quit(), CLOSE_GRACE_MS)) === "timeout") {
        await forceDisconnect(resource);
      }
    } else {
      await forceDisconnect(resource);
    }
    return;
  }

  // BullMQ resource: QueueEvents.close() blocks forever on a connection that
  // never became ready, so cap the graceful close and force-disconnect when
  // it does not settle in time (see forceDisconnect for the fallback chain).
  if (
    (await settleWithin(resource.close(), closeBudgetFor(connection))) ===
    "timeout"
  ) {
    await forceDisconnect(resource);
  }
}

async function closeResourcePair(owner, connection) {
  let firstError;
  try {
    await closeResource(owner, connection);
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

function withFlowJobDefaults(flow, flowOptions, defaultJobOptions) {
  if (!defaultJobOptions) {
    return flowOptions;
  }

  const options =
    flowOptions && typeof flowOptions === "object" ? flowOptions : {};
  let queuesOptions = { ...options.queuesOptions };
  const pending = [flow];

  while (pending.length > 0) {
    const job = pending.pop();
    if (!job || typeof job !== "object") {
      continue;
    }
    if (typeof job.queueName === "string" && job.queueName) {
      const queueOptions = queuesOptions[job.queueName] || {};
      queuesOptions = {
        ...queuesOptions,
        [job.queueName]: {
          ...queueOptions,
          defaultJobOptions: {
            ...defaultJobOptions,
            ...queueOptions.defaultJobOptions,
          },
        },
      };
    }
    if (Array.isArray(job.children)) {
      pending.push(...job.children);
    }
  }

  return { ...options, queuesOptions };
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function parsePositiveInteger(value, defaultValue, field = "Value") {
  if (!isPresent(value)) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`);
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
    node.telemetry = undefined;
    node.telemetryUnavailable = false;

    // Lazily constructs (and caches) the one BullMQOtel instance shared by
    // this config node's Queue/Worker/FlowProducer. Deferred until first
    // resource creation rather than built in the constructor above: Node-RED
    // builds config nodes at deploy time, which can precede the host's
    // OpenTelemetry bootstrap, and enableMetrics needs a MeterProvider
    // registered before BullMQOtel is constructed.
    node.getTelemetry = function getTelemetry() {
      if (!node.config.telemetry) {
        return undefined;
      }
      if (node.telemetry || node.telemetryUnavailable) {
        return node.telemetry;
      }
      let BullMQOtel;
      try {
        ({ BullMQOtel } = require("bullmq-otel"));
      } catch (err) {
        node.telemetryUnavailable = true;
        node.error(
          "BullMQ telemetry is enabled but bullmq-otel is not installed; run npm install bullmq-otel",
        );
        return undefined;
      }
      const serviceName =
        node.config.telemetryServiceName || node.config.queueName;
      node.telemetry = new BullMQOtel({
        tracerName: serviceName,
        meterName: serviceName,
        version: PACKAGE_VERSION,
        enableMetrics: node.config.telemetryMetrics,
      });
      return node.telemetry;
    };

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
        // A generous finite limit, deliberately not 0. Node treats 0 as
        // unlimited, but BullMQ's increaseMaxListeners() does
        // getMaxListeners() + n, so 0 becomes a hard cap of 3 and every
        // bullmq cmd node sharing this connection then trips a
        // MaxListenersExceededWarning.
        node.producerConnection.setMaxListeners(PRODUCER_MAX_LISTENERS);
        const queueOptions = buildBullMQOptions(
          node.config,
          node.producerConnection,
          node.getTelemetry(),
          "producer",
        );
        // Queue-level auto-removal. Without it BullMQ keeps every completed and
        // failed job forever, which is the unbounded growth its production
        // guide warns about. Per-job msg.jobopts still wins.
        if (node.config.defaultJobOptions) {
          queueOptions.defaultJobOptions = node.config.defaultJobOptions;
        }
        node.queue = new Queue(node.config.queueName, queueOptions);
        node.resources.set(node.queue, node.producerConnection);
        attachErrorListener(node.queue, node);
      }
      return node.queue;
    };

    // The producer connection backs the shared queue used by bullmq cmd nodes;
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
        ...buildBullMQOptions(
          node.config,
          connection,
          node.getTelemetry(),
          "worker",
        ),
        ...options,
      });
      node.resources.set(worker, connection);
      return worker;
    };

    node.createQueueEvents = function createQueueEvents(owner = node) {
      const connection = node.createConnection("events", owner);
      const queueEvents = new QueueEvents(
        node.config.queueName,
        buildBullMQOptions(node.config, connection, undefined, "events")
      );
      node.resources.set(queueEvents, connection);
      return queueEvents;
    };

    node.createFlowProducer = function createFlowProducer(owner = node) {
      const connection = node.createConnection("producer", owner);
      const flowProducer = new FlowProducer(
        buildBullMQOptions(
          node.config,
          connection,
          node.getTelemetry(),
          "producer",
        )
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

  RED.nodes.registerType("bullmq-queue-server", BullQueueServerSetup, {
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
      node.error("Missing bullmq-queue-server config node");
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
      node.error("Missing bullmq-queue-server config node");
      return;
    }

    node.bullQueue.register(node);

    const workerOptions = {
      concurrency: parsePositiveInteger(n.concurrency, 1, "Concurrency"),
    };
    const hasLimiterMax = isPresent(n.limiterMax);
    const hasLimiterDuration = isPresent(n.limiterDuration);
    if (hasLimiterMax !== hasLimiterDuration) {
      throw new Error("Limiter Max and Limiter Duration must be set together");
    }
    if (hasLimiterMax) {
      workerOptions.limiter = {
        max: parsePositiveInteger(n.limiterMax, undefined, "Limiter Max"),
        duration: parsePositiveInteger(
          n.limiterDuration,
          undefined,
          "Limiter Duration"
        ),
      };
    }

    // Arity 3 tells BullMQ to create and track a per-job AbortController
    // (worker.js: processorAcceptsSignal = processor.length >= 3), which is
    // what makes cancelJob/cancelAllJobs able to reach this job at all.
    const processor = async (job, _token, signal) => {
      if (node.completionMode === "manual") {
        const timeoutMs = parseAckTimeoutMs(n.ackTimeout);
        const acknowledgement = acknowledgements.create(
          {
            job,
            queue: node.bullQueue.getQueue(),
            queueName: node.bullQueue.config.queueName,
            runNodeId: node.id,
            worker: node.worker,
            signal,
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
          case "cancelJob": {
            const reason = msg.reason || "BullMQ job cancelled";
            const cancelled = context.worker.cancelJob(context.job.id, reason);
            if (!cancelled) {
              throw new Error(
                `BullMQ found no cancellable processor for job ${context.job.id}`
              );
            }
            msg.payload = cancelled;
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          }
          case "cancelAllJobs": {
            const reason = msg.reason || "BullMQ job cancelled";
            context.worker.cancelAllJobs(reason);
            msg.payload = true;
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          }
          default:
            throw new Error(`Unsupported bullmq job action: ${action}`);
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
      node.error("Missing bullmq-queue-server config node");
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
      node.error("Missing bullmq-queue-server config node");
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
          throw new Error("bullmq flow requires msg.payload to contain a flow tree");
        }
        msg.payload = serializeFlowJob(
          await node.flowProducer.add(
            msg.payload,
            withFlowJobDefaults(
              msg.payload,
              msg.flowopts,
              node.bullConn.config.defaultJobOptions,
            ),
          )
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

  RED.nodes.registerType("bullmq cmd", BullQueueCmdNode);
  RED.nodes.registerType("bullmq run", BullQueueRunNode);
  RED.nodes.registerType("bullmq job", BullJobNode);
  RED.nodes.registerType("bullmq events", BullEventsNode);
  RED.nodes.registerType("bullmq flow", BullFlowNode);
};
