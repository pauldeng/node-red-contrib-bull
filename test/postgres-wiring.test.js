// Phase 3 of the PostgreSQL backend work: getQueue/createWorker/
// createQueueEvents/createFlowProducer dispatch to BullMQ's
// createPostgresBackend when the config node's backend is "postgres". This
// file is unit level -- no live database, and it must never open a real
// socket.
//
// A resource's own constructor (Queue, Worker, QueueEvents) unconditionally
// calls the backend's waitUntilReady() before this file's test code gets a
// chance to observe anything, so a real pg pool config here would attempt a
// genuine TCP connect the moment the resource is built. FakePgPool sidesteps
// that: BullMQ's isPgPool() duck-types on connect/query/end and, when they
// are present, wraps the value directly instead of building `new pg.Pool()`
// -- so a synchronously-throwing connect() means PostgresConnection.
// bootstrap() rejects immediately, with no socket, no timer, and nothing
// left running once the test returns.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const registerBullMQNodes = require("../bull-queue");
const { PostgresQueueBackend, RedisQueueBackend } = require("bullmq");
const {
  buildBullMQOptions,
  normalizePostgresConfig,
} = require("../lib/connections");

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
      registerType(type, constructor, registerOptions) {
        registered.set(type, { constructor, options: registerOptions });
      },
    },
  };
}

function buildConfigNode(config) {
  const RED = createRED();
  registerBullMQNodes(RED);
  const Server = RED.registered.get("bullmq-queue-server").constructor;
  const node = {};
  Server.call(node, config);
  return node;
}

// Duck-typed pg.Pool: isPgPool() in bullmq/dist/cjs/postgres/pg-types.js only
// checks that connect/query/end are functions. Must extend EventEmitter --
// PostgresConnection unconditionally does `this.pool.on("error", ...)` in its
// constructor.
class FakePgPool extends EventEmitter {
  connect() {
    throw new Error("no live database in this unit test");
  }
  query() {
    throw new Error("no live database in this unit test");
  }
  async end() {}
}

// The fake pool throws on every operation, so a graceful close always rejects
// here. Swallow it in one place rather than tacking .catch(() => {}) onto each
// teardown.
async function closeQuietly(resource) {
  try {
    await resource.close();
  } catch {
    // teardown only: there is no live database behind any of these resources
  }
}

function postgresConfig(overrides = {}) {
  return {
    backend: "postgres",
    name: "pgcasts",
    address: "127.0.0.1",
    port: "5432",
    database: "bullmq",
    username: "bullmq",
    schema: "bullmq",
    max: "1",
    migrate: false,
    ...overrides,
  };
}

// Must run before any resource is constructed: the swap has to land before
// getQueue()/createWorker()/createQueueEvents()/createFlowProducer() ever
// hand node.config.postgres to createPostgresBackend.
function usePostgresFakePool(node) {
  node.config.postgres = new FakePgPool();
}

function throwOnCreateConnection(node) {
  node.createConnection = () => {
    throw new Error("must not create a Redis connection on the postgres path");
  };
}

test("postgres getQueue builds a PostgresQueueBackend and never creates a Redis connection", async () => {
  const node = buildConfigNode(postgresConfig());
  usePostgresFakePool(node);
  throwOnCreateConnection(node);

  const queue = node.getQueue();
  try {
    assert.ok(
      queue.getBackend() instanceof PostgresQueueBackend,
      "queue backend must be the PostgreSQL adapter",
    );
    assert.ok(
      node.resources.has(queue),
      "the owner must be tracked so redeploy releases it",
    );
    assert.equal(
      node.resources.get(queue),
      undefined,
      "the queue owner must be tracked with no raw connection",
    );
    assert.equal(
      node.producerConnection,
      null,
      "no producer connection is created on the postgres path",
    );
    assert.equal(
      node.getProducerConnection(),
      null,
      "getProducerConnection has nothing to return on postgres",
    );
  } finally {
    await closeQuietly(queue);
  }
});

test("postgres createWorker builds a PostgresQueueBackend at the worker factory position", async () => {
  const node = buildConfigNode(postgresConfig());
  usePostgresFakePool(node);
  throwOnCreateConnection(node);

  // autorun:false, exactly as the existing Redis unit test for createWorker
  // does, so BullMQ's own run loop never starts.
  const worker = node.createWorker(async () => {}, { autorun: false });
  try {
    assert.ok(
      worker.getBackend() instanceof PostgresQueueBackend,
      "worker backend must be the PostgreSQL adapter",
    );
    assert.ok(
      node.resources.has(worker),
      "the owner must be tracked so redeploy releases it",
    );
    assert.equal(
      node.resources.get(worker),
      undefined,
      "the worker owner must be tracked with no raw connection",
    );
  } finally {
    await closeQuietly(worker);
  }
});

test("postgres createQueueEvents builds a PostgresQueueBackend", async () => {
  const node = buildConfigNode(postgresConfig());
  usePostgresFakePool(node);
  throwOnCreateConnection(node);

  const queueEvents = node.createQueueEvents();
  // createQueueEvents (unlike createWorker) takes no options, so autorun
  // stays on and its run().catch(error => this.emit('error', error)) will
  // eventually fire once the fake pool's rejection surfaces. Attach the
  // listener synchronously, before returning to the event loop, so that
  // later emission is swallowed instead of crashing the process.
  queueEvents.on("error", () => {});
  try {
    assert.ok(
      queueEvents.getBackend() instanceof PostgresQueueBackend,
      "queueEvents backend must be the PostgreSQL adapter",
    );
    assert.ok(
      node.resources.has(queueEvents),
      "the owner must be tracked so redeploy releases it",
    );
    assert.equal(
      node.resources.get(queueEvents),
      undefined,
      "the queueEvents owner must be tracked with no raw connection",
    );
  } finally {
    await closeQuietly(queueEvents);
  }
});

test("postgres createFlowProducer builds a PostgresQueueBackend", async () => {
  const node = buildConfigNode(postgresConfig());
  usePostgresFakePool(node);
  throwOnCreateConnection(node);

  const flowProducer = node.createFlowProducer();
  try {
    assert.ok(
      flowProducer.getBackend() instanceof PostgresQueueBackend,
      "flowProducer backend must be the PostgreSQL adapter",
    );
    assert.ok(
      node.resources.has(flowProducer),
      "the owner must be tracked so redeploy releases it",
    );
    assert.equal(
      node.resources.get(flowProducer),
      undefined,
      "the flowProducer owner must be tracked with no raw connection",
    );
  } finally {
    await closeQuietly(flowProducer);
  }
});

test("a redis config still builds the Redis backend and still creates a connection", async () => {
  const node = buildConfigNode({ name: "rediscasts" });

  let createConnectionCalls = 0;
  node.createConnection = function createConnection() {
    createConnectionCalls += 1;
    const connection = new EventEmitter();
    connection.options = {};
    connection.status = "ready";
    return connection;
  };

  const queue = node.getQueue();
  try {
    assert.equal(
      createConnectionCalls,
      1,
      "the redis path must still build its own connection",
    );
    assert.ok(
      queue.getBackend() instanceof RedisQueueBackend,
      "queue backend must be the Redis adapter when backend is unset",
    );
    assert.equal(
      node.resources.get(queue),
      node.producerConnection,
      "the redis path still tracks the connection it created",
    );
  } finally {
    await closeQuietly(queue);
  }
});

test("prefix is not passed on the postgres path even when a switched flow still carries one", () => {
  // A flow switched from Redis to PostgreSQL keeps its stale `prefix` field
  // in the saved JSON (PLAN-postgresql-backend.md, "two backends, one config
  // object"). normalizePostgresConfig must not surface it, and
  // buildBullMQOptions -- the same helper every one of the four factories
  // calls -- must not add a prefix option from it either.
  const config = normalizePostgresConfig(
    { name: "pgcasts", address: "127.0.0.1", prefix: "{bull}" },
    {},
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(config, "prefix"),
    false,
    "normalizePostgresConfig must not surface the stale Redis-only field",
  );

  const options = buildBullMQOptions(
    config,
    config.postgres,
    undefined,
    "producer",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(options, "prefix"),
    false,
    "postgres BullMQ options must never carry a prefix",
  );
  assert.equal(options.connection, config.postgres);
});

test("the shared pool config survives being handed to four backends", async () => {
  // Every resource gets its own PostgresConnection built from the *same*
  // node.config.postgres object (buildBullMQOptions passes it by reference,
  // pinned above). BullMQ strips schema/skipVersionCheck/migrate/skipMigrations
  // before forwarding the rest to `new pg.Pool`, so if it ever did that by
  // mutation instead of by copy, the first resource would silently steal the
  // schema and migrate settings and the other three would run against
  // PostgreSQL's default schema. That is a wrong-data failure, not a crash,
  // so it is pinned against the installed BullMQ rather than assumed.
  //
  // Socket-free by construction: pg.Pool opens nothing until a client is
  // checked out, and nothing here checks one out.
  const { PostgresConnection } = require("bullmq");
  const { postgres } = normalizePostgresConfig(
    {
      name: "pgcasts",
      address: "127.0.0.1",
      database: "bullmq",
      username: "bullmq",
      schema: "custom_schema",
      max: "3",
      migrate: true,
    },
    {},
  );
  const before = { ...postgres };

  const connections = [];
  try {
    for (let resource = 0; resource < 4; resource += 1) {
      const connection = new PostgresConnection(postgres);
      connections.push(connection);
      assert.equal(
        connection.schema,
        "custom_schema",
        `resource ${resource} must still see the configured schema`,
      );
      assert.equal(
        connection.migrateOnConnect,
        true,
        `resource ${resource} must still run migrations`,
      );
    }
  } finally {
    for (const connection of connections) {
      await closeQuietly(connection);
    }
  }

  assert.deepEqual(
    postgres,
    before,
    "BullMQ must not mutate the config object shared by every resource",
  );
});
