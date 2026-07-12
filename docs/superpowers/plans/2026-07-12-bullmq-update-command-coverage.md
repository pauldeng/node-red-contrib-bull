# BullMQ Update And Command Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin BullMQ to `5.80.2` and raise `lib/commands.js` line coverage to at least 90% while preserving the documented Node-RED command contract.

**Architecture:** Keep `dispatchCommand(queue, msg)` as the single explicit command boundary. Exercise it with small recording queue/job fakes in the existing `node:test` suite, fix only API mismatches exposed by those tests, then update the exact dependency pin and maintained version documentation.

**Tech Stack:** CommonJS, Node.js `node:test`, BullMQ `5.80.2`, ioredis `5.11.1`, Node-RED 4.1/5.x, npm lockfile v3.

## Global Constraints

- BullMQ must be pinned to exactly `5.80.2`; do not use a semver range.
- Keep legacy node types `bull-queue-server`, `bull cmd`, and `bull run`.
- Do not reintroduce `bull` or `sprintf-js`.
- Never expose BullMQ lock tokens in Node-RED messages.
- Scheduler lookup and removal must use exact scheduler IDs.
- Cluster and MemoryDB prefixes must contain a Redis hash tag.
- Do not add a mocking or coverage dependency.
- `lib/commands.js` line coverage must be at least 90%.

---

### Task 1: Cover Job And Listing Commands

**Files:**
- Modify: `test/commands.test.js`
- Modify: `lib/commands.js:105-112`

**Interfaces:**
- Consumes: `dispatchCommand(queue, msg = {}) -> Promise<unknown>`
- Produces: recording test fakes and verified mappings for job/list commands.

- [ ] **Step 1: Add reusable recording fakes**

Add below `createQueueStub()` in `test/commands.test.js`:

```js
function createRecordingQueue(results = {}) {
  const calls = [];
  return new Proxy(
    { calls },
    {
      get(target, method) {
        if (method in target) {
          return target[method];
        }
        return async (...args) => {
          calls.push([method, ...args]);
          return results[method];
        };
      },
    },
  );
}

function createJobStub() {
  const calls = [];
  return {
    id: "job-1",
    name: "example",
    calls,
    async getState() {
      calls.push(["getState"]);
      return "failed";
    },
    async remove() {
      calls.push(["remove"]);
    },
    async retry(...args) {
      calls.push(["retry", ...args]);
    },
    async changeDelay(...args) {
      calls.push(["changeDelay", ...args]);
    },
    async promote() {
      calls.push(["promote"]);
    },
    async changePriority(...args) {
      calls.push(["changePriority", ...args]);
    },
  };
}
```

- [ ] **Step 2: Write the failing BullMQ signature test**

Add:

```js
test("getDelayed uses the BullMQ start and end arguments", async () => {
  const queue = createRecordingQueue({
    getDelayed: [{ id: "delayed-1", name: "delayed" }],
  });

  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "getDelayed",
      start: 2,
      end: 4,
      asc: true,
    }),
    [{ id: "delayed-1", name: "delayed" }],
  );
  assert.deepEqual(queue.calls, [["getDelayed", 2, 4]]);
});
```

- [ ] **Step 3: Run the signature test and verify RED**

Run:

```sh
node --test --test-name-pattern="getDelayed uses" test/commands.test.js
```

Expected: FAIL because the recorded call is `["getDelayed", 2, 4, true]`.

- [ ] **Step 4: Remove the unsupported argument**

Change the `getDelayed` branch in `lib/commands.js` to:

```js
case "getDelayed":
  return (
    await queue.getDelayed(
      valueOrDefault(msg.start, 0),
      valueOrDefault(msg.end, -1),
    )
  ).map(serializeJob);
```

- [ ] **Step 5: Add job/list coverage**

Add tests that use the recording fakes and assert these exact mappings:

```js
test("maps job listing commands and serializes jobs", async () => {
  const jobs = [{ id: "job-1", name: "example", extra: "ignored" }];
  const bulk = [{ name: "example", data: { value: 1 } }];
  const queue = createRecordingQueue({
    addBulk: jobs,
    getJob: jobs[0],
    getJobs: jobs,
    getPrioritized: jobs,
  });

  assert.deepEqual(await dispatchCommand(queue, { cmd: "addBulk", payload: bulk }), [
    { id: "job-1", name: "example" },
  ]);
  assert.deepEqual(await dispatchCommand(queue, { cmd: "getJob", jobid: "job-1" }), {
    id: "job-1",
    name: "example",
  });
  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "getJobs",
      types: ["waiting"],
      start: 2,
      end: 3,
      asc: true,
    }),
    [{ id: "job-1", name: "example" }],
  );
  assert.deepEqual(
    await dispatchCommand(queue, { cmd: "getPrioritized", start: 1, end: 2 }),
    [{ id: "job-1", name: "example" }],
  );
  assert.deepEqual(queue.calls, [
    ["addBulk", bulk],
    ["getJob", "job-1"],
    ["getJobs", ["waiting"], 2, 3, true],
    ["getPrioritized", 1, 2],
  ]);
});

test("maps commands that require an existing job", async () => {
  const job = createJobStub();
  const queue = createRecordingQueue({ getJob: job });

  assert.equal(await dispatchCommand(queue, { cmd: "getJobState", jobId: "job-1" }), "failed");
  assert.equal(await dispatchCommand(queue, { cmd: "removeJob", jobId: "job-1" }), true);
  assert.deepEqual(await dispatchCommand(queue, { cmd: "retryJob", jobId: "job-1", state: "failed" }), {
    id: "job-1",
    name: "example",
  });
  await dispatchCommand(queue, { cmd: "changeDelay", jobId: "job-1", delay: 500 });
  await dispatchCommand(queue, { cmd: "promoteJob", jobId: "job-1" });
  await dispatchCommand(queue, { cmd: "changePriority", jobId: "job-1", priority: 4, lifo: true });

  assert.deepEqual(job.calls, [
    ["getState"],
    ["remove"],
    ["retry", "failed"],
    ["changeDelay", 500],
    ["promote"],
    ["changePriority", { priority: 4, lifo: true }],
  ]);
});

test("required-job commands reject missing ids and jobs", async () => {
  await assert.rejects(
    () => dispatchCommand(createRecordingQueue(), { cmd: "removeJob" }),
    /msg\.jobId is required/,
  );
  await assert.rejects(
    () => dispatchCommand(createRecordingQueue({ getJob: undefined }), { cmd: "removeJob", jobId: "missing" }),
    /Job not found: missing/,
  );
});
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```sh
node --test test/commands.test.js
```

Expected: all command tests pass.

Commit:

```sh
git add lib/commands.js test/commands.test.js
git commit -m "test: cover BullMQ job commands"
```

---

### Task 2: Cover Scheduler, Administration, And Metrics Commands

**Files:**
- Modify: `test/commands.test.js`

**Interfaces:**
- Consumes: the recording queue fake from Task 1.
- Produces: test evidence for every remaining `dispatchCommand` branch and defaults.

- [ ] **Step 1: Add native scheduler tests**

Add one test that calls and verifies:

```js
const queue = createRecordingQueue({
  upsertJobScheduler: { id: "next-job", name: "scheduled" },
  getJobScheduler: { id: "scheduler-1", pattern: "*/5 * * * *" },
  getJobSchedulers: [{ id: "scheduler-1", pattern: "*/5 * * * *" }],
  getJobSchedulersCount: 1,
  removeJobScheduler: true,
});

await dispatchCommand(queue, {
  cmd: "upsertJobScheduler",
  schedulerId: "scheduler-1",
  repeat: { pattern: "*/5 * * * *" },
  template: { name: "scheduled" },
});
await dispatchCommand(queue, { cmd: "getJobScheduler", schedulerId: "scheduler-1" });
await dispatchCommand(queue, { cmd: "getJobSchedulers", start: 1, end: 3, asc: false });
await dispatchCommand(queue, { cmd: "getJobSchedulersCount" });
await dispatchCommand(queue, { cmd: "removeJobScheduler", schedulerId: "scheduler-1" });
```

Assert the five recorded calls contain those exact arguments and the returned jobs/schedulers contain only serialized known fields.

- [ ] **Step 2: Add direct queue-command table**

Use this complete case table:

```js
const cases = [
  ["retryJobs", { opts: { count: 2 } }, [{ count: 2 }], "retried", "retried"],
  ["promoteJobs", {}, [], "promoted", "promoted"],
  ["getCountsPerPriority", { priorities: [1, 5] }, [[1, 5]], { 1: 2 }, { 1: 2 }],
  ["getDeduplicationJobId", { deduplicationId: "dedupe" }, ["dedupe"], "job-1", "job-1"],
  ["removeDeduplicationKey", { deduplicationId: "dedupe" }, ["dedupe"], 1, 1],
  ["getJobCounts", { types: ["waiting", "failed"] }, ["waiting", "failed"], { waiting: 1 }, { waiting: 1 }],
  ["pause", {}, [], undefined, true],
  ["resume", {}, [], undefined, true],
  ["drain", { delayed: true }, [true], undefined, true],
  ["clean", { grace: 10, limit: 20, state: "failed" }, [10, 20, "failed"], ["job-1"], ["job-1"]],
  ["setGlobalConcurrency", { concurrency: 3 }, [3], 3, true],
  ["getGlobalConcurrency", {}, [], 3, 3],
  ["removeGlobalConcurrency", {}, [], 1, 1],
  ["setGlobalRateLimit", { max: 2, duration: 1000 }, [2, 1000], 1, true],
  ["getGlobalRateLimit", {}, [], { max: 2, duration: 1000 }, { max: 2, duration: 1000 }],
  ["removeGlobalRateLimit", {}, [], 1, 1],
  ["rateLimit", { duration: 500 }, [500], undefined, true],
  ["getRateLimitTtl", { maxJobs: 2 }, [2], 450, 450],
  ["removeRateLimitKey", {}, [], 1, 1],
  ["addJobLog", { jobId: "job-1", logRow: "row", keepLogs: 5 }, ["job-1", "row", 5], 1, 1],
  ["getJobLogs", { jobId: "job-1", start: 1, end: 2, asc: false }, ["job-1", 1, 2, false], { logs: ["row"] }, { logs: ["row"] }],
  ["exportPrometheusMetrics", {}, [], "metric 1", "metric 1"],
];
```

For each row, construct `createRecordingQueue({ [cmd]: methodResult })`, dispatch `{ cmd, ...msg }`, assert the return equals `expected`, and assert calls equal `[[cmd, ...args]]`.

- [ ] **Step 3: Add default-value cases**

Verify:

```js
await dispatchCommand(queue, { cmd: "getJobs" });
await dispatchCommand(queue, { cmd: "getDelayed" });
await dispatchCommand(queue, { cmd: "getPrioritized" });
await dispatchCommand(queue, { cmd: "getJobSchedulers" });
await dispatchCommand(queue, { cmd: "drain" });
await dispatchCommand(queue, { cmd: "clean" });
await dispatchCommand(queue, { cmd: "getJobLogs", jobid: "job-1" });
```

Assert default calls are respectively:

```js
["getJobs", undefined, 0, -1, false]
["getDelayed", 0, -1]
["getPrioritized", 0, -1]
["getJobSchedulers", 0, -1, true]
["drain", false]
["clean", 0, 1000, "completed"]
["getJobLogs", "job-1", 0, -1, true]
```

- [ ] **Step 4: Measure coverage**

Run:

```sh
node --test --experimental-test-coverage test/*.test.js
```

Expected: `lib/commands.js` line coverage is at least 90% and the test run has zero failures.

- [ ] **Step 5: Commit**

```sh
git add test/commands.test.js
git commit -m "test: cover queue administration commands"
```

---

### Task 3: Pin BullMQ 5.80.2 And Update Contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/package-contract.test.js`
- Modify: `test/docs-contract.test.js`
- Modify: `bull-queue.js`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/MIGRATION.md`
- Modify: `docs/RELEASE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: exact npm package `bullmq@5.80.2`.
- Produces: updated runtime dependency and maintained version contract.

- [ ] **Step 1: Update version contract tests first**

Change the expected BullMQ value in `test/package-contract.test.js` and `test/docs-contract.test.js` from `5.78.0` to `5.80.2`.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```sh
node --test test/package-contract.test.js test/docs-contract.test.js
```

Expected: FAIL because `package.json` and README still contain `5.78.0`.

- [ ] **Step 3: Update the exact dependency and lockfile**

Change `package.json` to:

```json
"bullmq": "5.80.2"
```

Then run:

```sh
npm install
```

Confirm:

```sh
node -p "require('./node_modules/bullmq/package.json').version"
```

Expected: `5.80.2`.

- [ ] **Step 4: Update maintained version documentation**

Replace the active `5.78.0` requirement with `5.80.2` in:

```text
bull-queue.js
README.md
CLAUDE.md
CONTRIBUTING.md
docs/MIGRATION.md
docs/RELEASE.md
```

Add an `Unreleased` section to `CHANGELOG.md`:

```md
## Unreleased

- Updated BullMQ from 5.78.0 to 5.80.2, including the upstream Job Scheduler offset fix.
- Expanded command-dispatch regression coverage and corrected the `getDelayed` BullMQ call signature.
```

Keep the historical `1.0.0` entry and the historical June migration design unchanged.

- [ ] **Step 5: Run focused contracts and tests**

Run:

```sh
node --test test/package-contract.test.js test/docs-contract.test.js test/commands.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```sh
git add package.json package-lock.json test/package-contract.test.js test/docs-contract.test.js bull-queue.js README.md CLAUDE.md CONTRIBUTING.md docs/MIGRATION.md docs/RELEASE.md CHANGELOG.md
git commit -m "chore: update BullMQ to 5.80.2"
```

---

### Task 4: Full Verification

**Files:**
- Modify only if a verification command exposes a confirmed defect.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: release-quality verification evidence.

- [ ] **Step 1: Run formatting**

```sh
npm run format:check
```

Expected: all files match Prettier style. If not, run `npm exec -- prettier --write` only on changed files and commit the mechanical result.

- [ ] **Step 2: Run fast suites on every supported Node line**

```sh
npm test
npx --yes node@18 --test test/*.test.js
npx --yes node@22 --test test/*.test.js
npx --yes node@24 --test test/*.test.js
```

Expected: zero failures; Redis integration files remain skipped in the fast suite.

- [ ] **Step 3: Run editor, package, and audit gates**

```sh
npm run test:playwright
npm run validate
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
git diff --check
```

Expected: zero failures. `node-red-dev` may warn that the exact BullMQ pin is not the newest only if a newer release appears after `5.80.2`; verify before changing it.

- [ ] **Step 4: Run standalone Redis integration**

Run `npm run test:integration` with a temporary Redis executable on `PATH`, as documented in the completed review session.

Expected: all six integration tests pass.

- [ ] **Step 5: Attempt Docker topology verification**

```sh
npm run test:deployments
```

Expected when Docker is accessible: all configured standalone, Cluster, and Sentinel topologies pass. If the daemon socket is still denied, record the exact external error without changing code.

- [ ] **Step 6: Verify final branch state**

```sh
git status --short --branch
git log --oneline --decorate -5
```

Expected: branch `review/bullmq-dependency-updates-and-fixes`, clean worktree, and the plan plus implementation commits present.
