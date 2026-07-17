# Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade to BullMQ `5.80.6` and ioredis `5.11.1`, then fix the verified lifecycle, endpoint, limiter, editor, help, and documentation defects from the 2026-07-16 review.

**Architecture:** Keep the existing CommonJS and Node-RED node boundaries. Track each BullMQ owner with its injected ioredis connection in one `Map`, parse endpoint lists once in `lib/connections.js` with Node's URL/IP primitives, and keep editor behavior inside the existing HTML registrations.

**Tech Stack:** CommonJS, Node.js `node:test`, Node-RED 4.1/5.x, BullMQ `5.80.6`, ioredis `5.11.1`, Playwright, npm lockfile v3.

## Global Constraints

- Keep `bullmq` pinned to exactly `5.80.6` and `ioredis` pinned to exactly `5.11.1`.
- Keep the legacy node types `bull-queue-server`, `bull cmd`, and `bull run`.
- Do not reintroduce `bull`, `sprintf-js`, or any new dependency.
- Keep secrets in Node-RED credentials or environment variables and never expose BullMQ lock tokens.
- Keep exact scheduler-id matching and the Cluster/MemoryDB hash-tag prefix rule.
- Use failing tests before every runtime or editor behavior change.
- Do not modify the completed 2026-07-12 historical design or plan.

---

### Task 1: Pin BullMQ And ioredis Exactly

**Files:**
- Modify: `test/package-contract.test.js`
- Modify: `test/docs-contract.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `bull-queue.js`
- Modify: `README.md`
- Modify: `CLAUDE.md` through its `AGENTS.md` symlink
- Modify: `CONTRIBUTING.md`
- Modify: `docs/MIGRATION.md`
- Modify: `docs/RELEASE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: npm's exact `bullmq@5.80.6` package, whose exact ioredis dependency is `5.11.1`.
- Produces: one deduplicated `node_modules/ioredis` lockfile entry and maintained text that names `5.80.6`.

- [ ] **Step 1: Change dependency contract expectations first**

Use these assertions in `test/package-contract.test.js`:

```js
assert.equal(packageJson.dependencies?.bullmq, "5.80.6");
assert.equal(packageJson.dependencies?.ioredis, "5.11.1");
assert.equal(packageLock.packages?.["node_modules/bullmq"]?.version, "5.80.6");
assert.equal(
  packageLock.packages?.["node_modules/bullmq"]?.dependencies?.ioredis,
  "5.11.1",
);
assert.equal(packageLock.packages?.["node_modules/ioredis"]?.version, "5.11.1");
assert.equal(
  packageLock.packages?.["node_modules/bullmq/node_modules/ioredis"],
  undefined,
);
```

Change the README contract string in `test/docs-contract.test.js` to:

```js
"BullMQ 5.80.6",
```

- [ ] **Step 2: Verify RED**

Run:

```sh
node --test test/package-contract.test.js test/docs-contract.test.js
```

Expected: dependency assertions report `5.80.2`/`5.10.1`, and the README assertion cannot find `BullMQ 5.80.6`.

- [ ] **Step 3: Install the exact dependency versions**

Run:

```sh
npm install --save-exact bullmq@5.80.6 ioredis@5.11.1
```

This is the only dependency operation; do not add an override or a second lockfile entry.

- [ ] **Step 4: Update maintained version text**

Replace `5.80.2` with `5.80.6` in `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/MIGRATION.md`, and `docs/RELEASE.md`. Change the private-API comment in `bull-queue.js` to:

```js
// ioredis clients directly (BullMQ is pinned to exactly 5.80.6).
```

Start `CHANGELOG.md` with:

```md
## Unreleased

- Updated BullMQ to 5.80.6 and aligned the exact ioredis pin with BullMQ's 5.11.1 dependency.
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```sh
node --test test/package-contract.test.js test/docs-contract.test.js
npm ls bullmq ioredis
```

Expected: tests pass and `npm ls` shows `bullmq@5.80.6` with one deduplicated `ioredis@5.11.1`.

Commit:

```sh
git add package.json package-lock.json bull-queue.js test/package-contract.test.js test/docs-contract.test.js README.md CLAUDE.md CONTRIBUTING.md docs/MIGRATION.md docs/RELEASE.md CHANGELOG.md
git commit -m "build: update BullMQ and ioredis"
```

---

### Task 2: Parse Redis Endpoints Without Losing Security Intent

**Files:**
- Modify: `test/connections.test.js`
- Modify: `lib/connections.js`

**Interfaces:**
- Consumes: `parseEndpointList(value, defaultPort = 6379, tls, tlsName = "TLS")` and topology TLS booleans.
- Produces: `{ host, port }[]`; rejects URL credentials and explicit scheme/TLS contradictions.

- [ ] **Step 1: Add endpoint parser tests**

Append to `test/connections.test.js`:

```js
test("parses hostnames, IPv6, and credential-free Redis URLs", () => {
  assert.deepEqual(
    parseEndpointList(
      "host-a,host-b:6380,::1,[2001:db8::2]:6381,redis://host-c:6382,rediss://[2001:db8::3]:6383",
    ),
    [
      { host: "host-a", port: 6379 },
      { host: "host-b", port: 6380 },
      { host: "::1", port: 6379 },
      { host: "2001:db8::2", port: 6381 },
      { host: "host-c", port: 6382 },
      { host: "2001:db8::3", port: 6383 },
    ],
  );
});

test("rejects credentials embedded in Redis endpoint URLs", () => {
  assert.throws(
    () => parseEndpointList("redis://user:secret@redis.example.test:6379"),
    /endpoint URLs cannot include credentials/i,
  );
});

test("rejects endpoint URL schemes that contradict topology TLS", () => {
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "clustered",
        deployment: "cluster",
        clusterNodes: "rediss://redis.example.test:6379",
        tls: false,
      }),
    /rediss:\/\/.*TLS.*enabled/i,
  );
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "clustered",
        deployment: "cluster",
        clusterNodes: "redis://redis.example.test:6379",
        tls: true,
      }),
    /redis:\/\/.*TLS.*disabled/i,
  );
  assert.throws(
    () =>
      normalizeQueueConfig({
        name: "sentinel",
        deployment: "sentinel",
        sentinelMasterName: "mymaster",
        sentinels: "rediss://sentinel.example.test:26379",
        sentinelTls: false,
      }),
    /rediss:\/\/.*Sentinel TLS.*enabled/i,
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```sh
node --test test/connections.test.js
```

Expected: IPv6 parsing and both rejection behaviors fail against the regular-expression parser.

- [ ] **Step 3: Replace only the shared endpoint parser**

Add the standard-library import:

```js
const { isIP } = require("node:net");
```

Replace `parseEndpoint` with:

```js
function parseEndpoint(endpoint, defaultPort = DEFAULT_REDIS_PORT, tls, tlsName = "TLS") {
  if (typeof endpoint === "object" && endpoint !== null) {
    const host = endpoint.host || endpoint.address;
    if (!isPresent(host)) {
      throw new Error("Redis endpoint requires a host");
    }
    return {
      host: String(host).trim(),
      port: toPort(endpoint.port, defaultPort),
    };
  }

  const text = String(endpoint || "").trim();
  if (!text) {
    throw new Error("Redis endpoint cannot be empty");
  }
  if (isIP(text)) {
    return { host: text, port: defaultPort };
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `redis://${text}`);
  } catch {
    throw new Error(`Invalid Redis endpoint: ${text}`);
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis endpoint protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      "Redis endpoint URLs cannot include credentials; use the config node credential fields",
    );
  }
  if (hasScheme && tls !== undefined) {
    const secure = url.protocol === "rediss:";
    if (secure !== tls) {
      throw new Error(
        `${url.protocol}// endpoint requires ${tlsName} to be ${secure ? "enabled" : "disabled"}`,
      );
    }
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new Error(`Redis endpoint requires a host: ${text}`);
  }
  return { host, port: toPort(url.port, defaultPort) };
}
```

Pass the extra arguments through `parseEndpointList` with these exact signatures and calls:

```js
function parseEndpointList(
  value,
  defaultPort = DEFAULT_REDIS_PORT,
  tls,
  tlsName = "TLS",
) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        typeof item === "string" ? item.split(/[\n,]+/) : [item],
      )
      .filter((item) => isPresent(item))
      .map((item) => parseEndpoint(item, defaultPort, tls, tlsName));
  }

  if (!isPresent(value)) {
    return [];
  }

  return String(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseEndpoint(item, defaultPort, tls, tlsName));
}
```

Before constructing `normalized`, compute:

```js
const tls = toBoolean(config.tls, false);
const sentinelTls = toBoolean(config.sentinelTls, false);
```

Use `tls` and `sentinelTls` as the normalized properties, and call:

```js
clusterNodes: parseEndpointList(
  config.clusterNodes || config.startupNodes,
  DEFAULT_REDIS_PORT,
  tls,
  "TLS",
),
sentinels: parseEndpointList(
  config.sentinels,
  26379,
  sentinelTls,
  "Sentinel TLS",
),
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```sh
node --test test/connections.test.js
```

Expected: all connection tests pass.

Commit:

```sh
git add lib/connections.js test/connections.test.js
git commit -m "fix: validate Redis endpoint URLs"
```

---

### Task 3: Release BullMQ Owners With Their Redis Connections

**Files:**
- Modify: `test/async-style.test.js`
- Modify: `test/shutdown.test.js`
- Modify: `test/node-red-registration.test.js`
- Modify: `bull-queue.js`

**Interfaces:**
- Produces: `node.resources: Map<BullMQOwner, IORedis>`.
- Produces: `node.releaseResource(owner) -> Promise<void>`.
- Preserves: owner closes before its raw connection; independent pairs start closing concurrently.

- [ ] **Step 1: Narrow the async-style contract**

Replace the blanket `Promise.*` assertion in `test/async-style.test.js` with:

```js
assert.doesNotMatch(
  source,
  /\bPromise\.(?!all\b|race\b)/,
  `${file} calls a Promise combinator other than all/race`,
);
```

- [ ] **Step 2: Add lifecycle tests**

First make `forceCleanup` work during both the RED run and the final `Map` implementation:

```js
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
```

Add this partial-redeploy test to `test/shutdown.test.js`:

```js
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
    RED.registered
      .get("bull run")
      .constructor.call(runNode, {
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
      { owner: runNode.worker, connection: server.resources.get(runNode.worker) },
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
```

Add this deterministic config-close test:

```js
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
```

In `test/node-red-registration.test.js`, extend the shared-producer test with:

```js
assert.equal(connection.getMaxListeners(), 0);
```

- [ ] **Step 3: Verify RED**

Run:

```sh
node --test test/async-style.test.js test/shutdown.test.js test/node-red-registration.test.js
```

Expected: the lifecycle test reports that `resources` is not a `Map`, the close-concurrency test starts only one owner, and the producer listener limit remains 10.

- [ ] **Step 4: Use native race/all and ownership pairs**

Replace the polling `settleWithin` implementation with two async helpers and the allowed native combinator:

```js
async function settled(promise) {
  try {
    await promise;
  } catch {
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
```

Add one pair closer that always attempts the raw connection and reports the first error:

```js
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
```

In `BullQueueServerSetup`, use `new Map()`, stop tracking inside `createConnection`, track each factory result with its connection, and expose:

```js
node.releaseResource = async function releaseResource(owner) {
  if (!node.resources.has(owner)) {
    return;
  }
  const connection = node.resources.get(owner);
  node.resources.delete(owner);
  await closeResourcePair(owner, connection);
};
```

When the shared Queue is created, call:

```js
node.producerConnection.setMaxListeners(0);
node.resources.set(node.queue, node.producerConnection);
```

Each Worker, QueueEvents, and FlowProducer factory must call `node.resources.set(owner, connection)`. Runtime close handlers must call `releaseResource(node.worker)`, `releaseResource(node.queueEvents)`, or `releaseResource(node.flowProducer)` instead of `closeResource(owner)`.

Replace config-node sequential shutdown with:

```js
const resources = Array.from(node.resources.entries()).reverse();
node.resources.clear();
await Promise.all(
  resources.map(([owner, connection]) =>
    closeResourcePair(owner, connection),
  ),
);
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```sh
node --test test/async-style.test.js test/shutdown.test.js test/node-red-registration.test.js
```

Expected: all focused tests pass, partial closes stop retries, and config-close pairs begin concurrently.

Commit:

```sh
git add bull-queue.js test/async-style.test.js test/shutdown.test.js test/node-red-registration.test.js
git commit -m "fix: release owned Redis connections"
```

---

### Task 4: Validate Worker Limits At Runtime And In The Editor

**Files:**
- Modify: `test/node-red-registration.test.js`
- Modify: `test/editor-contract.test.js`
- Modify: `bull-queue.js`
- Modify: `bull-queue.html`

**Interfaces:**
- Consumes: optional `concurrency`, `limiterMax`, and `limiterDuration` node properties.
- Produces: no limiter when both limiter fields are blank; a limiter only when both are positive integers.

- [ ] **Step 1: Add runtime validation tests**

Add this recording helper and tests to `test/node-red-registration.test.js`:

```js
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
  RED.registered.get("bull run").constructor.call(node, {
    queue: "queue",
    completionMode: "immediate",
    ...config,
  });
  return { createdOptions, node };
}

test("bull run applies only a complete positive limiter pair", () => {
  assert.equal(constructRunNode({}).createdOptions[0].limiter, undefined);
  assert.deepEqual(
    constructRunNode({ limiterMax: "2", limiterDuration: "1000" })
      .createdOptions[0].limiter,
    { max: 2, duration: 1000 },
  );
});

test("bull run rejects invalid concurrency and limiter values", () => {
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
  ];
  for (const [config, error] of cases) {
    assert.throws(() => constructRunNode(config), error);
  }
});
```

Add these static editor assertions:

```js
assert.match(html, /function positiveInteger\(value\)/);
assert.match(html, /function optionalPositivePair\(value, otherProperty\)/);
assert.match(html, /concurrency:\s*\{[^}]*validate: positiveInteger/);
assert.match(html, /limiterMax:\s*\{[^}]*validate:/);
assert.match(html, /limiterDuration:\s*\{[^}]*validate:/);
```

- [ ] **Step 2: Verify RED**

Run:

```sh
node --test test/node-red-registration.test.js test/editor-contract.test.js
```

Expected: incomplete limiters are silently omitted, zero is not field-specific, and editor validators are absent.

- [ ] **Step 3: Implement the minimal shared checks**

In `bull-queue.js`, reuse one presence helper and name each integer field:

```js
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
```

Build worker options with:

```js
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
      "Limiter Duration",
    ),
  };
}
```

In the `bull run` editor registration IIFE, add:

```js
function positiveInteger(value) {
  var parsed = Number(value);
  return value !== "" && Number.isInteger(parsed) && parsed > 0;
}

function optionalPositivePair(value, otherProperty) {
  var input = $("#node-input-" + otherProperty);
  var other = input.length ? input.val() : this[otherProperty];
  return (
    (value === "" && (other === "" || other == null)) ||
    (positiveInteger(value) && positiveInteger(other))
  );
}
```

Use these exact defaults:

```js
concurrency: { value: 1, validate: positiveInteger },
limiterMax: {
  value: "",
  validate: function(value) {
    return optionalPositivePair.call(this, value, "limiterDuration");
  }
},
limiterDuration: {
  value: "",
  validate: function(value) {
    return optionalPositivePair.call(this, value, "limiterMax");
  }
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```sh
node --test test/node-red-registration.test.js test/editor-contract.test.js
```

Expected: all focused tests pass.

Commit:

```sh
git add bull-queue.js bull-queue.html test/node-red-registration.test.js test/editor-contract.test.js
git commit -m "fix: validate worker limiter fields"
```

---

### Task 5: Correct Editor Visibility And Help

**Files:**
- Modify: `test/editor-contract.test.js`
- Modify: `test/playwright/editor.spec.js`
- Modify: `bull-queue.html`

**Interfaces:**
- Produces: `.bull-db-row` hidden only in Cluster mode.
- Produces: `.bull-ack-timeout-row` visible only for manual completion.
- Preserves: configured `bull job` Action precedence unless `msg.cmd` is explicitly present.

- [ ] **Step 1: Add static and browser behavior tests**

Add this static test to `test/editor-contract.test.js`:

```js
test("editor hides irrelevant rows and teaches configured completion", () => {
  assert.match(
    html,
    /id="node-config-input-name" placeholder="email-jobs"/,
  );
  assert.match(html, /class="form-row bull-db-row"/);
  assert.match(html, /class="form-row bull-ack-timeout-row"/);
  assert.match(helpBlock("bull job"), /delete msg\.cmd;/);
});
```

Add this real-dialog test to `test/playwright/editor.spec.js`:

```js
test("toggles deployment and completion-specific rows", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => window.RED && RED.nodes.getType("bull run"),
  );

  await page.evaluate(() => {
    const definition = RED.nodes.getType("bull run");
    const node = {
      id: RED.nodes.id(),
      type: "bull run",
      z: RED.workspaces.active(),
      _def: definition,
      name: "",
      queue: "",
      completionMode: "immediate",
      ackTimeout: 300000,
      concurrency: 1,
      limiterMax: "",
      limiterDuration: "",
      inputs: definition.inputs,
      outputs: definition.outputs,
      x: 100,
      y: 100,
      wires: [[]],
    };
    RED.nodes.add(node);
    RED.editor.edit(node);
  });
  await expect(page.locator("#node-input-completionMode")).toBeVisible();
  await expect(page.locator(".bull-ack-timeout-row")).toBeHidden();
  await page.locator("#node-input-completionMode").selectOption("manual");
  await expect(page.locator(".bull-ack-timeout-row")).toBeVisible();
  await page.locator("#node-dialog-cancel").click();

  await page.evaluate(() => {
    RED.editor.editConfig("", "bull-queue-server", "_ADD_");
  });
  await expect(page.locator("#node-config-input-deployment")).toBeVisible();
  await page.locator("#node-config-input-deployment").selectOption("cluster");
  await expect(page.locator(".bull-db-row")).toBeHidden();
  await page.locator("#node-config-input-deployment").selectOption("sentinel");
  await expect(page.locator(".bull-db-row")).toBeVisible();
  await page.locator("#node-config-dialog-cancel").click();
});
```

- [ ] **Step 2: Verify RED**

Run:

```sh
node --test test/editor-contract.test.js
npm run test:playwright
```

Expected: static class/help assertions fail and the real dialogs keep both rows visible.

- [ ] **Step 3: Add the two existing-style toggles and fix the example**

Change the queue placeholder to `email-jobs`. Add `bull-db-row` to the Database row and this line to `updateBullQueueServerRows`:

```js
$(".bull-db-row").toggle(deployment !== "cluster");
```

Add `bull-ack-timeout-row` to the Ack Timeout row. In the `bull run` registration IIFE, define and register:

```js
function updateBullRunRows() {
  $(".bull-ack-timeout-row").toggle(
    $("#node-input-completionMode").val() === "manual",
  );
}

oneditprepare: function() {
  $("#node-input-completionMode").on("change", updateBullRunRows);
  updateBullRunRows();
},
```

Change the progress-to-configured-complete help path to show a Function node containing:

```js
delete msg.cmd;
msg.payload = { ok: true };
return msg;
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```sh
node --test test/editor-contract.test.js
npm run test:playwright
```

Expected: static and real-dialog tests pass.

Commit:

```sh
git add bull-queue.html test/editor-contract.test.js test/playwright/editor.spec.js
git commit -m "fix: clarify BullMQ editor fields"
```

---

### Task 6: Correct Maintained Documentation Contracts

**Files:**
- Modify: `test/docs-contract.test.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/REFERENCE_MAP.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/NODE_GUIDE.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/COMMANDS.md`
- Modify: `docs/CONNECTIONS.md`
- Modify: `docs/RELEASE.md`

**Interfaces:**
- Documents only verified public behavior; internal retry constants remain undocumented.
- Keeps plaintext secret fallback as migration-only compatibility.

- [ ] **Step 1: Add one focused documentation contract test**

In `test/docs-contract.test.js`, read the affected files and assert:

```js
assert.doesNotMatch(release, /\.github\/workflows\/codeql\.yml/);
assert.match(release, /Code scanning.*default setup/i);
assert.match(referenceMap, /test\/shutdown\.test\.js/);
assert.match(referenceMap, /test\/async-style\.test\.js/);
assert.match(testing, /shutdown.*async-style/i);
assert.doesNotMatch(testing, /required `basecasts`/);
assert.doesNotMatch(readme, /required `basecasts`/);
assert.match(readme, /bullmq_features\.json/);
assert.match(readme, /repeatable_jobs\.json/);
assert.match(connections, /rejects unauthorized certificates by default/i);
assert.match(connections, /redis:\/\//);
assert.match(connections, /rediss:\/\//);
assert.match(connections, /`memorydb`.*compatibility alias/i);
assert.match(connections, /plaintext.*migration-only/i);
assert.match(commands, /msg\.command.*legacy alias/i);
assert.match(nodeGuide, /msg\.command.*legacy alias/i);
assert.match(architecture, /bull cmd.*shared producer connection/i);
assert.doesNotMatch(troubleshooting, /msg\.jobopts\.jobId/);
```

Also assert all 16 default event names from `DEFAULT_EVENTS` occur in the `bull events` section of `docs/NODE_GUIDE.md`.

- [ ] **Step 2: Verify RED**

Run:

```sh
node --test test/docs-contract.test.js
```

Expected: the new contract reports each documented drift item.

- [ ] **Step 3: Apply the exact documentation corrections**

Make these minimal text changes:

```md
- `docs/REFERENCE_MAP.md` and `docs/TESTING.md`: name `test/shutdown.test.js` and `test/async-style.test.js`.
- `docs/NODE_GUIDE.md`: list active, added, cleaned, completed, deduplicated, delayed, drained, duplicated, failed, paused, progress, removed, resumed, stalled, waiting, and waiting-children as defaults.
- `docs/CONNECTIONS.md`: document host/port, IPv6, redis/rediss URL formats, URL credential rejection, scheme/TLS agreement, unconditional cluster DNS passthrough, the `memorydb` compatibility alias, certificate rejection by default, and plaintext secret fields as migration-only.
- `docs/RELEASE.md`: require GitHub Code scanning default setup without naming a nonexistent workflow.
- `README.md` and `docs/TESTING.md`: call the basecasts scheduler a legacy scheduler compatibility case.
- `README.md`: link example_flow.json, bullmq_features.json, and repeatable_jobs.json.
- `docs/TROUBLESHOOTING.md`: limit lookup IDs to msg.schedulerId, msg.jobid, and msg.jobId.
- `docs/ARCHITECTURE.md`: say bull cmd mirrors the shared producer connection while runtime nodes report their own connections.
- `docs/COMMANDS.md` and `docs/NODE_GUIDE.md`: describe msg.command as a legacy alias and recommend msg.cmd.
```

Add these compatibility bullets under `CHANGELOG.md`'s Unreleased section:

```md
- Fixed partial redeploy connection leaks, concurrent shutdown, Redis endpoint parsing, worker limiter validation, and editor field visibility.
- Redis endpoint URLs that contain credentials are now rejected; move authentication into the config node's credential fields.
- Corrected the manual-progress help example and maintained connection, testing, release, and command documentation.
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```sh
node --test test/docs-contract.test.js
```

Expected: all documentation contracts pass.

Commit:

```sh
git add test/docs-contract.test.js README.md CHANGELOG.md docs/REFERENCE_MAP.md docs/ARCHITECTURE.md docs/NODE_GUIDE.md docs/TESTING.md docs/TROUBLESHOOTING.md docs/COMMANDS.md docs/CONNECTIONS.md docs/RELEASE.md
git commit -m "docs: correct BullMQ runtime contracts"
```

---

### Task 7: Run Mandatory Verification

**Files:**
- Modify only files required by failures caused by Tasks 1-6.

**Interfaces:**
- Produces: evidence that unit, editor, integration, deployment, formatting, package, and audit gates pass.

- [ ] **Step 1: Run local gates**

Run:

```sh
npm test
npm run test:playwright
npm run format:check
npm run validate
npm audit --omit=dev --audit-level=moderate
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 2: Run Redis behavior gates**

Run:

```sh
npm run test:integration
npm run test:deployments
```

Expected: standalone integration and every available Docker topology pass. MemoryDB remains skipped unless `MEMORYDB_ENABLED=1` and all credentials are supplied through environment variables.

- [ ] **Step 3: Inspect scope and commit any verification-only correction**

Run:

```sh
git status --short
git diff --stat
git log --oneline -8
```

Expected: only planned files changed, review documents remain untracked and untouched, and no correction commit is needed. If a planned regression required a correction, rerun its focused RED/GREEN test and commit only that correction.
