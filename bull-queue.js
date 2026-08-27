"use strict";

const {
  createPostgresBackend,
  DelayedError,
  FlowProducer,
  MINIMUM_POSTGRES_VERSION,
  Queue,
  QueueEvents,
  RECOMMENDED_POSTGRES_VERSION,
  SchemaMigrationRequiredError,
  SchemaVersionMismatchError,
  UnrecoverableError,
  UnsupportedPostgresVersionError,
  WaitingError,
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
  POSTGRES_CONNECTION_TIMEOUT_MS,
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

// PostgreSQL's connection timeout is its only way to stop an outstanding
// connect. Unlike Redis, it has no raw client that we can force closed, so its
// close budget needs scheduling margin beyond that timeout. Derived from the
// timeout it has to outlast rather than written as a literal, so raising
// POSTGRES_CONNECTION_TIMEOUT_MS cannot silently leave the budget short. It
// has a ceiling as well as a floor: Node-RED gives each node ~15s to close, so
// POSTGRES_CONNECTION_TIMEOUT_MS must stay well under 14s or this budget stops
// bounding anything and Node-RED's own timeout cuts the close off instead.
const POSTGRES_CLOSE_MS = POSTGRES_CONNECTION_TIMEOUT_MS + CLOSE_GRACE_MS;

function closeBudgetFor(connection) {
  // PostgreSQL owners have no companion connection in node.resources because
  // BullMQ owns their pool. Redis owners retain the live ioredis status that
  // distinguishes a healthy worker drain from an unreachable fast close.
  if (!connection) {
    return POSTGRES_CLOSE_MS;
  }
  return connection.status === "ready" ? GRACEFUL_CLOSE_MS : CLOSE_GRACE_MS;
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
  // BullMQ 6.3.1's public disconnect() can await the same never-ready promise
  // as close(), which would spend a second shutdown budget after the first one
  // already expired. The exact BullMQ pin makes this one backend escape hatch
  // deliberate and testable until upstream disconnect becomes bounded.
  if (typeof resource.getBackend !== "function") {
    return;
  }
  const backend = resource.getBackend();
  // RedisQueueBackend is the only installed backend exposing raw `_client`
  // handles. PostgreSQL deliberately skips this branch.
  if (backend && backend.connection && backend.connection._client) {
    disconnectClient(backend.connection._client);
    disconnectClient(
      backend.blockingConnection && backend.blockingConnection._client,
    );
  }
  // Measured on installed BullMQ 6.3.1: a Worker's close() never reaches this
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
  // PostgreSQL has no raw force-disconnect branch. closeBudgetFor therefore
  // lets its own connection timeout settle close() before Node-RED calls done.
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

// FlowProducer.addBulk(flows) accepts no options argument, so the queuesOptions
// route withFlowJobDefaults() uses for add() is unavailable here. Stamp the
// retention onto each job's own opts instead; anything the caller set wins.
function withBulkFlowJobDefaults(flow, defaultJobOptions) {
  if (!defaultJobOptions || !flow || typeof flow !== "object") {
    return flow;
  }

  const children = Array.isArray(flow.children)
    ? flow.children.map((child) =>
        withBulkFlowJobDefaults(child, defaultJobOptions),
      )
    : flow.children;

  return {
    ...flow,
    opts: { ...defaultJobOptions, ...flow.opts },
    ...(children === undefined ? {} : { children }),
  };
}

function withFlowJobDefaults(flow, flowOptions, defaultJobOptions) {
  if (!defaultJobOptions) {
    return flowOptions;
  }

  const options =
    flowOptions && typeof flowOptions === "object" ? flowOptions : {};
  // Already a fresh copy, so later queues are assigned into it rather than
  // re-spreading the whole map per queue name.
  const queuesOptions = { ...options.queuesOptions };
  const pending = [flow];

  while (pending.length > 0) {
    const job = pending.pop();
    if (!job || typeof job !== "object") {
      continue;
    }
    if (typeof job.queueName === "string" && job.queueName) {
      const queueOptions = queuesOptions[job.queueName] || {};
      queuesOptions[job.queueName] = {
        ...queueOptions,
        defaultJobOptions: {
          ...defaultJobOptions,
          ...queueOptions.defaultJobOptions,
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

function attachErrorListener(resource, node, startupFailureOwner) {
  if (!resource || typeof resource.on !== "function") {
    return () => {};
  }
  let ready = false;
  resource.on("error", (err) => {
    setDisconnected(node);
    if (startupFailureOwner && !ready) {
      startupFailureOwner.reportBackendFailure(err);
    } else {
      node.error(err);
    }
  });
  return function markReady() {
    ready = true;
  };
}

// Turns a rejected backend readiness promise -- or a synchronous resource
// construction failure, since BullMQ's postgres factory validates and loads
// its optional `pg` dependency before any I/O -- into one of a handful of
// actionable categories, so a Node-RED user is told what to DO rather than
// just that the backend is unavailable. The category string is also the
// dedup key each config node latches on; see node.reportBackendFailure.
function describeBackendFailure(err) {
  const message = err && err.message ? err.message : String(err);
  if (err instanceof SchemaMigrationRequiredError) {
    return {
      category: "schema-migration-required",
      message: `${message} Set the queue configuration node's "migrate" property to true so this node initialises the schema, or run BullMQ's PostgreSQL migrations against the database yourself before deploying.`,
    };
  }
  if (err instanceof SchemaVersionMismatchError) {
    return {
      category: "schema-version-mismatch",
      message: `${message} Upgrade this Node-RED package to a release that uses the required BullMQ major; PostgreSQL schema downgrades are not supported.`,
    };
  }
  if (err instanceof UnsupportedPostgresVersionError) {
    return {
      category: "unsupported-postgres-version",
      message: `${message} BullMQ's PostgreSQL backend requires server version ${MINIMUM_POSTGRES_VERSION} or newer (${RECOMMENDED_POSTGRES_VERSION}+ recommended).`,
    };
  }
  // BullMQ lazily requires the optional `pg` package and, when it cannot be
  // resolved, throws its own actionable error rather than a raw
  // MODULE_NOT_FOUND -- reuse that message instead of wrapping it again.
  if (message.includes("npm install pg")) {
    return { category: "pg-missing", message };
  }
  return {
    category: "generic",
    message: `BullMQ backend is unavailable: ${message}`,
  };
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

    node.resources = new Map();
    node.config = normalizeQueueConfig(n, node.credentials || {});
    node.queue = null;
    node.producerConnection = null;
    node.telemetry = undefined;
    node.telemetryUnavailable = false;

    // Categories already reported for this config node. BullMQ builds one
    // backend per resource (Queue/Worker/QueueEvents/FlowProducer each get
    // their own pool), so the same misconfiguration can be observed from
    // more than one of them -- this latch is what keeps one deploy at one
    // report per distinct failure instead of one per resource that hit it.
    node.backendFailures = new Set();
    node.reportBackendFailure = function reportBackendFailure(err) {
      const { category, message } = describeBackendFailure(err);
      if (node.backendFailures.has(category)) {
        return;
      }
      node.backendFailures.add(category);
      node.error(message);
    };

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

    // The four BullMQ owners differ only in which constructor they call and
    // where that constructor takes the backend factory: Queue and QueueEvents
    // take it 3rd, Worker 4th, FlowProducer 2nd. Everything around that is the
    // same work, so `construct` receives the built options plus the factory to
    // pass on -- undefined on Redis, where every one of those constructors
    // defaults the parameter to BullMQ's own Redis factory.
    //
    // On PostgreSQL, BullMQ's factory validates the schema name and
    // synchronously loads the optional `pg` module (createPostgresBackend ->
    // new PostgresConnection) before any resource exists, so a bad schema name
    // or a missing `pg` install throws out of `new Queue/Worker/QueueEvents/
    // FlowProducer(...)` itself rather than through waitUntilReady(). Catch it
    // here instead of crashing the owning node's constructor.
    function createResource(role, owner, telemetry, construct, extraOptions) {
      // BullMQ owns every PostgreSQL connection (a pool plus a dedicated
      // LISTEN client per backend); this package builds none of its own on
      // that path, so createConnection is skipped entirely.
      const isPostgres = node.config.backend === "postgres";
      const connection = isPostgres
        ? undefined
        : node.createConnection(role, owner);
      const options = {
        ...buildBullMQOptions(
          node.config,
          isPostgres ? node.config.postgres : connection,
          telemetry,
          role,
        ),
        ...extraOptions,
      };

      let resource;
      if (isPostgres) {
        try {
          resource = construct(options, createPostgresBackend);
        } catch (err) {
          publishBackendStatus("disconnected");
          node.reportBackendFailure(err);
          return { resource: undefined, connection };
        }
      } else {
        resource = construct(options);
      }

      // On postgres there is no connection of our own -- the owner is tracked
      // with no value so close/redeploy still walks it, but has nothing raw to
      // close.
      node.resources.set(resource, connection);
      return { resource, connection };
    }

    node.getQueue = function getQueue() {
      if (!node.queue) {
        const { resource, connection } = createResource(
          "producer",
          node,
          node.getTelemetry(),
          (options, factory) =>
            new Queue(node.config.queueName, options, factory),
          // Queue-level auto-removal. Without it BullMQ keeps every completed
          // and failed job forever, which is the unbounded growth its
          // production guide warns about. Per-job msg.jobopts still wins.
          node.config.defaultJobOptions
            ? { defaultJobOptions: node.config.defaultJobOptions }
            : undefined,
        );
        if (!resource) {
          return null;
        }
        node.queue = resource;
        node.producerConnection = connection || null;
        node.watchBackend(node.queue.getBackend());
        attachErrorListener(node.queue, node);
      }
      return node.queue;
    };

    // Live reachability of the shared backend, owned here rather than read by
    // each bullmq cmd node. waitUntilReady() cannot answer "is it reachable
    // now": RedisQueueBackend awaits connection.client, which returns the
    // promise built once in the constructor, and PostgresConnection memoizes
    // readyPromise the same way. So a node deployed after an outage began would
    // see that resolved promise and paint a false "connected". The backend's
    // ready/error/close events are live, so they own the state after the first
    // observation and every reader sees the current value.
    node.backendStatus = "connecting";
    node.backendReaders = new Set();

    function publishBackendStatus(status) {
      node.backendStatus = status;
      for (const read of node.backendReaders) {
        read(status);
      }
    }

    node.watchBackend = function watchBackend(backend) {
      backend.on("ready", () => publishBackendStatus("connected"));
      backend.on("error", () => publishBackendStatus("disconnected"));
      backend.on("close", () => publishBackendStatus("disconnected"));
      // Seed the first observation once, for the whole config node. An async
      // IIFE rather than a promise chain (forbidden in this file) so it never
      // blocks deploy, and it must not overwrite a live event that already
      // told us more than this memoized promise can.
      (async () => {
        try {
          await backend.waitUntilReady();
          if (node.backendStatus === "connecting") {
            publishBackendStatus("connected");
          }
        } catch (err) {
          // Do NOT assume an event already covered this. PostgresConnection's
          // bootstrap() rejects on connect, auth, migration, or schema failure
          // and emits nothing (its emitError only forwards idle-pool and LISTEN
          // errors, and only when a listener is already attached), and Queue's
          // constructor swallows the same rejection. Without this the node
          // would sit on "connecting" forever with nothing reported. The
          // sibling bullmq events and bullmq flow nodes handle their own
          // waitUntilReady() rejection through node.reportBackendFailure too,
          // so the same failure seen from more than one resource still lands
          // as one report.
          if (node.backendStatus === "connecting") {
            publishBackendStatus("disconnected");
            node.reportBackendFailure(err);
          }
        }
      })();
    };

    // Readers get the current status immediately, which is what makes a
    // late-deployed node correct: the shared state is live, unlike the
    // already-fired "ready" event it would otherwise have missed.
    node.readBackendStatus = function readBackendStatus(read) {
      node.backendReaders.add(read);
      read(node.backendStatus);
      return function stopReading() {
        node.backendReaders.delete(read);
      };
    };

    // Runtime nodes pass themselves as owner and attach their own resource
    // error listener, so worker/events/flow errors surface on the visible
    // runtime node rather than the hidden config node.
    node.createWorker = function createWorker(processor, options, owner = node) {
      return createResource(
        "worker",
        owner,
        node.getTelemetry(),
        (workerOptions, factory) =>
          new Worker(node.config.queueName, processor, workerOptions, factory),
        options,
      ).resource;
    };

    node.createQueueEvents = function createQueueEvents(owner = node) {
      // QueueEvents deliberately gets no telemetry instance; see docs/TELEMETRY.md.
      return createResource(
        "events",
        owner,
        undefined,
        (options, factory) =>
          new QueueEvents(node.config.queueName, options, factory),
      ).resource;
    };

    node.createFlowProducer = function createFlowProducer(owner = node) {
      return createResource(
        "producer",
        owner,
        node.getTelemetry(),
        (options, factory) => new FlowProducer(options, factory),
      ).resource;
    };

    node.on("close", async function onClose(removed, done) {
      try {
        node.backendFailures.clear();
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

    // Mirror the config node's live view of the shared backend. Reading the
    // shared state rather than subscribing to the backend directly keeps the
    // listener count on the backend constant no matter how many bullmq cmd
    // nodes a flow has, and gives a node deployed mid-outage the current
    // status instead of a stale one.
    const applyBackendStatus = (status) => {
      if (status === "connected") {
        setConnected(node);
      } else if (status === "disconnected") {
        setDisconnected(node);
      } else {
        setConnecting(node);
      }
    };
    // Create the shared queue up front, as this node has always done, so the
    // status reflects real reachability instead of a static "configured" the
    // moment the flow deploys. This is the call that builds the queue, its
    // connection, and (once PostgreSQL is wired) its pool; reading the status
    // afterwards only subscribes.
    node.bullConn.getQueue();
    const stopReadingBackend =
      node.bullConn.readBackendStatus(applyBackendStatus);
    node.on("input", async function onInput(msg, send, done) {
      try {
        const queue = node.bullConn.getQueue();
        if (!queue) {
          // Construction failed synchronously (missing pg, bad schema name).
          // The config node already reported why; say something useful here
          // rather than letting queue.add() throw a bare TypeError per message.
          throw new Error(
            "BullMQ queue is unavailable; see the queue configuration node's error",
          );
        }
        const result = await dispatchCommand(queue, msg);
        msg.payload = result;
        nodeSend(node, send, msg);
        nodeDone(node, done);
      } catch (err) {
        nodeDone(node, done, err, msg);
      }
    });

    node.on("close", function onClose(removed, done) {
      stopReadingBackend();
      done();
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

    const workerOptions = {
      concurrency: parsePositiveInteger(n.concurrency, 1, "Concurrency"),
      maxStartedAttempts: parsePositiveInteger(
        n.maxStartedAttempts,
        100,
        "Max Started Attempts"
      ),
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
    if (node.bullQueue.config.backend === "postgres") {
      // A permanent readiness error (for example an unmigrated schema) makes
      // BullMQ's autorun loop retry without delay. Start only after the one
      // readiness promise succeeds so a configuration error cannot spin the
      // Node-RED runtime.
      workerOptions.autorun = false;
    }

    // Arity 3 tells BullMQ to create and track a per-job AbortController
    // (worker.js: processorAcceptsSignal = processor.length >= 3), which is
    // what makes cancelJob/cancelAllJobs able to reach this job at all.
    // The token is the job's lock: bullmq job needs it for moveToWait and
    // moveToDelayed, and it stays in the acknowledgement registry -- never in
    // a message.
    const processor = async (job, token, signal) => {
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
            token,
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
    // createWorker reports and returns undefined on a synchronous backend
    // construction failure (e.g. postgres selected with pg not installed);
    // nothing was created, so there is nothing to close on this node's own
    // close, and no listener setup below would have anything to attach to.
    if (!node.worker) {
      setDisconnected(node);
      return;
    }
    const workerStartupFailureOwner =
      node.bullQueue.config.backend === "postgres" ? node.bullQueue : undefined;
    const markWorkerReady = attachErrorListener(
      node.worker,
      node,
      workerStartupFailureOwner,
    );
    if (workerStartupFailureOwner) {
      let workerReady = false;
      async function startPostgresWorker() {
        try {
          await node.worker.waitUntilReady();
          if (node.worker.closing) {
            return;
          }
          workerReady = true;
          markWorkerReady();
          setConnected(node);
          await node.worker.run();
        } catch (err) {
          if (node.worker.closing) {
            return;
          }
          setDisconnected(node);
          if (workerReady) {
            node.error(err);
          } else {
            workerStartupFailureOwner.reportBackendFailure(err);
          }
        }
      }
      void startPostgresWorker();
    } else {
      node.worker.on("ready", () => {
        markWorkerReady();
        setConnected(node);
      });
    }
    node.worker.on("closed", () => setDisconnected(node));
    setConnecting(node);

    node.on("close", async function onClose(removed, done) {
      acknowledgements.rejectByRunNode(
        node.id,
        new Error("BullMQ run node closed before acknowledgement")
      );
      try {
        await node.bullQueue.releaseResource(node.worker);
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
          // Step/retry transitions. Each hands the job's lock token back to
          // BullMQ and then settles the acknowledgement with the error class
          // the worker special-cases, so the job is NOT moved to failed
          // (worker.js checks DelayedError and WaitingError).
          case "moveToWait": {
            await context.job.moveToWait(context.token);
            context.fail(new WaitingError());
            msg.payload = true;
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          }
          case "moveToDelayed": {
            const delay = Number(msg.delay);
            if (!Number.isFinite(delay) || delay < 0) {
              throw new Error(
                "moveToDelayed requires msg.delay in milliseconds"
              );
            }
            await context.job.moveToDelayed(Date.now() + delay, context.token);
            context.fail(new DelayedError());
            msg.payload = true;
            nodeSend(node, send, msg);
            nodeDone(node, done);
            return;
          }
          case "updateData":
            await context.job.updateData(
              Object.hasOwn(msg, "jobData") ? msg.jobData : msg.payload
            );
            msg.payload = serializeJob(context.job);
            nodeSend(node, send, msg);
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

    node.queueEvents = node.bullConn.createQueueEvents(node);
    if (!node.queueEvents) {
      // Construction failed synchronously and already reported why.
      setDisconnected(node);
      return;
    }
    const eventsStartupFailureOwner =
      node.bullConn.config.backend === "postgres" ? node.bullConn : undefined;
    const markQueueEventsReady = attachErrorListener(
      node.queueEvents,
      node,
      eventsStartupFailureOwner,
    );
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
        markQueueEventsReady();
        setConnected(node);
      } catch (err) {
        setDisconnected(node);
        if (eventsStartupFailureOwner) {
          eventsStartupFailureOwner.reportBackendFailure(err);
        } else {
          node.error(err);
        }
      }
    }
    updateReadyStatus();

    node.on("close", async function onClose(removed, done) {
      try {
        await node.bullConn.releaseResource(node.queueEvents);
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

    node.flowProducer = node.bullConn.createFlowProducer(node);
    if (!node.flowProducer) {
      // Construction failed synchronously and already reported why.
      setDisconnected(node);
      return;
    }
    const flowStartupFailureOwner =
      node.bullConn.config.backend === "postgres" ? node.bullConn : undefined;
    const markFlowProducerReady = attachErrorListener(
      node.flowProducer,
      node,
      flowStartupFailureOwner,
    );
    async function updateReadyStatus() {
      try {
        setConnecting(node);
        await node.flowProducer.waitUntilReady();
        markFlowProducerReady();
        setConnected(node);
      } catch (err) {
        setDisconnected(node);
        if (flowStartupFailureOwner) {
          flowStartupFailureOwner.reportBackendFailure(err);
        } else {
          node.error(err);
        }
      }
    }
    updateReadyStatus();

    node.on("input", async function onInput(msg, send, done) {
      try {
        if (!msg.payload || typeof msg.payload !== "object") {
          throw new Error(
            "bullmq flow requires msg.payload to contain a flow tree, or an array of flow trees"
          );
        }
        const retention = node.bullConn.config.defaultJobOptions;
        if (Array.isArray(msg.payload)) {
          // addBulk creates every tree or none of them, which is the whole
          // reason to use it instead of one add() per tree.
          if (msg.payload.length === 0) {
            throw new Error("bullmq flow requires at least one flow tree");
          }
          const trees = await node.flowProducer.addBulk(
            msg.payload.map((flow) => withBulkFlowJobDefaults(flow, retention))
          );
          msg.payload = trees.map(serializeFlowJob);
        } else {
          msg.payload = serializeFlowJob(
            await node.flowProducer.add(
              msg.payload,
              withFlowJobDefaults(msg.payload, msg.flowopts, retention)
            )
          );
        }
        nodeSend(node, send, msg);
        nodeDone(node, done);
      } catch (err) {
        nodeDone(node, done, err, msg);
      }
    });

    node.on("close", async function onClose(removed, done) {
      try {
        await node.bullConn.releaseResource(node.flowProducer);
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
