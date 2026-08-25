const assert = require("node:assert/strict");
const test = require("node:test");

const { dispatchCommand } = require("../lib/commands");

function createQueueStub() {
  const calls = [];
  return {
    calls,
    async add(...args) {
      calls.push(["add", ...args]);
      return { id: "job-1", name: args[0], data: args[1], opts: args[2] };
    },
    async upsertJobScheduler(...args) {
      calls.push(["upsertJobScheduler", ...args]);
      return { id: "delayed-1", name: args[2].name, data: args[2].data };
    },
    async getJobSchedulersCount() {
      calls.push(["getJobSchedulersCount"]);
      return 2;
    },
    async getJobSchedulers(...args) {
      calls.push(["getJobSchedulers", ...args]);
      return [{ id: "a" }, { id: "b" }];
    },
    async getJobScheduler(...args) {
      calls.push(["getJobScheduler", ...args]);
      return { id: args[0] };
    },
    async removeJobScheduler(...args) {
      calls.push(["removeJobScheduler", ...args]);
      return true;
    },
    async drain(...args) {
      calls.push(["drain", ...args]);
      return undefined;
    },
    async clean(...args) {
      calls.push(["clean", ...args]);
      return [`${args[2]}-1`];
    },
  };
}

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

test("adds a normal job through BullMQ Queue.add", async () => {
  const queue = createQueueStub();

  const result = await dispatchCommand(queue, {
    cmd: "add",
    payload: "plain",
    jobopts: { jobId: "plain" },
  });

  assert.equal(result.name, "default");
  assert.deepEqual(queue.calls[0], [
    "add",
    "default",
    { payload: "plain" },
    { jobId: "plain" },
  ]);
});

test("adds legacy repeat jobs through upsertJobScheduler", async () => {
  const queue = createQueueStub();

  await dispatchCommand(queue, {
    cmd: "add",
    payload: "gateway-FCC23DFFFE0AA2A8",
    jobopts: {
      jobId: "gateway-FCC23DFFFE0AA2A8",
      repeat: { cron: "30 9,19,29,39,49,59 * * * *" },
    },
  });

  assert.deepEqual(queue.calls[0], [
    "upsertJobScheduler",
    "gateway-FCC23DFFFE0AA2A8",
    { pattern: "30 9,19,29,39,49,59 * * * *" },
    {
      name: "default",
      data: { payload: "gateway-FCC23DFFFE0AA2A8" },
      opts: {},
    },
  ]);
});

test("maps legacy repeat commands to Job Scheduler APIs", async () => {
  const queue = createQueueStub();

  assert.equal(await dispatchCommand(queue, { cmd: "count" }), 2);
  assert.deepEqual(await dispatchCommand(queue, { cmd: "getRepeatableJobs" }), [
    { id: "a" },
    { id: "b" },
  ]);
  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "getRepeatableJobByKey",
      jobid: "gateway",
    }),
    { id: "gateway" },
  );
  assert.equal(
    await dispatchCommand(queue, {
      cmd: "removeRepeatableByKey",
      jobid: "gateway",
    }),
    true,
  );

  assert.deepEqual(queue.calls.slice(0, 4), [
    ["getJobSchedulersCount"],
    ["getJobSchedulers", 0, -1, true],
    ["getJobScheduler", "gateway"],
    ["removeJobScheduler", "gateway"],
  ]);
});

test("stopAndRemoveAllJobs removes schedulers, drains, and cleans inactive states", async () => {
  const queue = createQueueStub();

  const result = await dispatchCommand(queue, { cmd: "stopAndRemoveAllJobs" });

  assert.deepEqual(result.removedSchedulers, ["a", "b"]);
  assert.deepEqual(result.cleaned, {
    completed: ["completed-1"],
    failed: ["failed-1"],
    delayed: ["delayed-1"],
    wait: ["wait-1"],
  });
  assert.deepEqual(queue.calls, [
    ["getJobSchedulers", 0, -1, true],
    ["removeJobScheduler", "a"],
    ["removeJobScheduler", "b"],
    ["drain", true],
    ["clean", 0, 0, "completed"],
    ["clean", 0, 0, "failed"],
    ["clean", 0, 0, "delayed"],
    ["clean", 0, 0, "wait"],
  ]);
});

test("setGlobalRateLimit accepts the documented payload options", async () => {
  const queue = createQueueStub();
  queue.setGlobalRateLimit = async (...args) => {
    queue.calls.push(["setGlobalRateLimit", ...args]);
  };

  await dispatchCommand(queue, {
    cmd: "setGlobalRateLimit",
    payload: { max: 2, duration: 1000 },
  });

  assert.deepEqual(queue.calls, [["setGlobalRateLimit", 2, 1000]]);
});

test("setGlobalRateLimit requires max and duration", async () => {
  await assert.rejects(
    () =>
      dispatchCommand(createRecordingQueue(), { cmd: "setGlobalRateLimit" }),
    /msg\.max and msg\.duration are required/,
  );
});

test("maps job listing commands and serializes jobs", async () => {
  const jobs = [{ id: "job-1", name: "example", extra: "ignored" }];
  const bulk = [{ name: "example", data: { value: 1 } }];
  const queue = createRecordingQueue({
    addBulk: jobs,
    getJob: jobs[0],
    getJobs: jobs,
    getPrioritized: jobs,
  });

  assert.deepEqual(
    await dispatchCommand(queue, { cmd: "addBulk", payload: bulk }),
    [{ id: "job-1", name: "example" }],
  );
  assert.deepEqual(
    await dispatchCommand(queue, { cmd: "getJob", jobid: "job-1" }),
    { id: "job-1", name: "example" },
  );
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
    await dispatchCommand(queue, {
      cmd: "getPrioritized",
      start: 1,
      end: 2,
    }),
    [{ id: "job-1", name: "example" }],
  );
  assert.deepEqual(queue.calls, [
    ["addBulk", bulk],
    ["getJob", "job-1"],
    ["getJobs", ["waiting"], 2, 3, true],
    ["getPrioritized", 1, 2],
  ]);
});

test("addBulk rejects repeat options anywhere in the batch", async () => {
  const queue = createRecordingQueue();
  const bulk = [
    { name: "a", data: {}, opts: { jobId: "a" } },
    { name: "b", data: {}, opts: { repeat: { pattern: "*/5 * * * *" } } },
  ];

  await assert.rejects(
    () => dispatchCommand(queue, { cmd: "addBulk", payload: bulk }),
    /upsertJobScheduler/,
  );
  assert.deepEqual(queue.calls, []);
});

test("addBulk with a non-array payload keeps its existing pass-through behaviour", async () => {
  const queue = createRecordingQueue({ addBulk: [] });

  await dispatchCommand(queue, { cmd: "addBulk", payload: "not-an-array" });

  assert.deepEqual(queue.calls, [["addBulk", "not-an-array"]]);
});

test("maps commands that require an existing job", async () => {
  const job = createJobStub();
  const queue = createRecordingQueue({ getJob: job });

  assert.equal(
    await dispatchCommand(queue, { cmd: "getJobState", jobId: "job-1" }),
    "failed",
  );
  assert.equal(
    await dispatchCommand(queue, { cmd: "removeJob", jobId: "job-1" }),
    true,
  );
  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "retryJob",
      jobId: "job-1",
      state: "failed",
    }),
    { id: "job-1", name: "example" },
  );
  await dispatchCommand(queue, {
    cmd: "changeDelay",
    jobId: "job-1",
    delay: 500,
  });
  await dispatchCommand(queue, { cmd: "promoteJob", jobId: "job-1" });
  await dispatchCommand(queue, {
    cmd: "changePriority",
    jobId: "job-1",
    priority: 4,
    lifo: true,
  });

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
    () =>
      dispatchCommand(createRecordingQueue({ getJob: undefined }), {
        cmd: "removeJob",
        jobId: "missing",
      }),
    /Job not found: missing/,
  );
});

test("maps native Job Scheduler commands", async () => {
  const queue = createRecordingQueue({
    upsertJobScheduler: {
      id: "next-job",
      name: "scheduled",
      extra: "ignored",
    },
    getJobScheduler: {
      id: "scheduler-1",
      pattern: "*/5 * * * *",
      extra: "ignored",
    },
    getJobSchedulers: [
      {
        id: "scheduler-1",
        pattern: "*/5 * * * *",
        extra: "ignored",
      },
    ],
    getJobSchedulersCount: 1,
    removeJobScheduler: true,
  });
  const repeat = { pattern: "*/5 * * * *" };
  const template = { name: "scheduled" };

  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "upsertJobScheduler",
      schedulerId: "scheduler-1",
      repeat,
      template,
    }),
    { id: "next-job", name: "scheduled" },
  );
  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "getJobScheduler",
      schedulerId: "scheduler-1",
    }),
    { id: "scheduler-1", pattern: "*/5 * * * *" },
  );
  assert.deepEqual(
    await dispatchCommand(queue, {
      cmd: "getJobSchedulers",
      start: 1,
      end: 3,
      asc: false,
    }),
    [{ id: "scheduler-1", pattern: "*/5 * * * *" }],
  );
  assert.equal(
    await dispatchCommand(queue, { cmd: "getJobSchedulersCount" }),
    1,
  );
  assert.equal(
    await dispatchCommand(queue, {
      cmd: "removeJobScheduler",
      schedulerId: "scheduler-1",
    }),
    true,
  );
  assert.deepEqual(queue.calls, [
    ["upsertJobScheduler", "scheduler-1", repeat, template],
    ["getJobScheduler", "scheduler-1"],
    ["getJobSchedulers", 1, 3, false],
    ["getJobSchedulersCount"],
    ["removeJobScheduler", "scheduler-1"],
  ]);
});

test("maps queue administration, limits, logs, and metrics commands", async () => {
  const cases = [
    ["retryJobs", { opts: { count: 2 } }, [{ count: 2 }], "retried", "retried"],
    ["promoteJobs", {}, [], "promoted", "promoted"],
    [
      "getCountsPerPriority",
      { priorities: [1, 5] },
      [[1, 5]],
      { 1: 2 },
      { 1: 2 },
    ],
    [
      "getDeduplicationJobId",
      { deduplicationId: "dedupe" },
      ["dedupe"],
      "job-1",
      "job-1",
    ],
    ["removeDeduplicationKey", { deduplicationId: "dedupe" }, ["dedupe"], 1, 1],
    [
      "getJobCounts",
      { types: ["waiting", "failed"] },
      ["waiting", "failed"],
      { waiting: 1 },
      { waiting: 1 },
    ],
    ["pause", {}, [], undefined, true],
    ["resume", {}, [], undefined, true],
    ["isPaused", {}, [], true, true],
    ["isMaxed", {}, [], false, false],
    ["drain", { delayed: true }, [true], undefined, true],
    [
      "clean",
      { grace: 10, limit: 20, state: "failed" },
      [10, 20, "failed"],
      ["job-1"],
      ["job-1"],
    ],
    ["setGlobalConcurrency", { concurrency: 3 }, [3], 3, true],
    ["getGlobalConcurrency", {}, [], 3, 3],
    ["removeGlobalConcurrency", {}, [], 1, 1],
    ["setGlobalRateLimit", { max: 2, duration: 1000 }, [2, 1000], 1, true],
    [
      "getGlobalRateLimit",
      {},
      [],
      { max: 2, duration: 1000 },
      { max: 2, duration: 1000 },
    ],
    ["removeGlobalRateLimit", {}, [], 1, 1],
    ["rateLimit", { duration: 500 }, [500], undefined, true],
    ["getRateLimitTtl", { maxJobs: 2 }, [2], 450, 450],
    ["removeRateLimitKey", {}, [], 1, 1],
    [
      "addJobLog",
      { jobId: "job-1", logRow: "row", keepLogs: 5 },
      ["job-1", "row", 5],
      1,
      1,
    ],
    [
      "getJobLogs",
      { jobId: "job-1", start: 1, end: 2, asc: false },
      ["job-1", 1, 2, false],
      { logs: ["row"] },
      { logs: ["row"] },
    ],
    ["getVersion", {}, [], "5.80.9", "5.80.9"],
    ["exportPrometheusMetrics", {}, [], "metric 1", "metric 1"],
  ];

  for (const [cmd, msg, args, methodResult, expected] of cases) {
    const queue = createRecordingQueue({ [cmd]: methodResult });
    assert.deepEqual(
      await dispatchCommand(queue, { cmd, ...msg }),
      expected,
      cmd,
    );
    assert.deepEqual(queue.calls, [[cmd, ...args]], cmd);
  }
});

test("uses documented command defaults", async () => {
  const queue = createRecordingQueue({
    getJobs: [],
    getDelayed: [],
    getPrioritized: [],
    getJobSchedulers: [],
    clean: [],
    getJobLogs: { logs: [] },
  });

  await dispatchCommand(queue, { cmd: "getJobs" });
  await dispatchCommand(queue, { cmd: "getDelayed" });
  await dispatchCommand(queue, { cmd: "getPrioritized" });
  await dispatchCommand(queue, { cmd: "getJobSchedulers" });
  await dispatchCommand(queue, { cmd: "drain" });
  await dispatchCommand(queue, { cmd: "clean" });
  await dispatchCommand(queue, { cmd: "getJobLogs", jobid: "job-1" });

  assert.deepEqual(queue.calls, [
    ["getJobs", undefined, 0, -1, false],
    ["getDelayed", 0, -1],
    ["getPrioritized", 0, -1],
    ["getJobSchedulers", 0, -1, true],
    ["drain", false],
    ["clean", 0, 1000, "completed"],
    ["getJobLogs", "job-1", 0, -1, true],
  ]);
});

test("rejects unsupported command names", async () => {
  await assert.rejects(
    () => dispatchCommand(createQueueStub(), { cmd: "unknown" }),
    /Unsupported bull cmd/,
  );
});
