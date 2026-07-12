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
    ["clean", 0, 1000, "completed"],
    ["clean", 0, 1000, "failed"],
    ["clean", 0, 1000, "delayed"],
    ["clean", 0, 1000, "wait"],
  ]);
});

test("stopAndRemoveAllJobs cleans every batch of inactive jobs", async () => {
  const queue = createQueueStub();
  let completedCalls = 0;
  queue.clean = async function clean(grace, limit, state) {
    queue.calls.push(["clean", grace, limit, state]);
    if (state === "completed" && completedCalls++ === 0) {
      return Array.from({ length: limit }, (_, index) => `completed-${index}`);
    }
    return state === "completed" ? ["completed-last"] : [];
  };

  const result = await dispatchCommand(queue, { cmd: "stopAndRemoveAllJobs" });

  assert.equal(result.cleaned.completed.length, 1001);
  assert.equal(
    queue.calls.filter(
      ([command, , , state]) => command === "clean" && state === "completed",
    ).length,
    2,
  );
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

test("rejects unsupported command names", async () => {
  await assert.rejects(
    () => dispatchCommand(createQueueStub(), { cmd: "unknown" }),
    /Unsupported bull cmd/,
  );
});
