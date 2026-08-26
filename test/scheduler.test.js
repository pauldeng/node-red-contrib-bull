const assert = require("node:assert/strict");
const test = require("node:test");

const { getSchedulerId, serializeScheduler } = require("../lib/scheduler");

test("scheduler commands require the native msg.schedulerId field", () => {
  assert.equal(getSchedulerId({ schedulerId: "exact" }), "exact");
  assert.throws(() => getSchedulerId({ jobId: "legacy" }), /scheduler id/);
  assert.throws(() => getSchedulerId({ jobid: "legacy" }), /scheduler id/);
  assert.throws(() => getSchedulerId({}), /scheduler id/);
});

test("serializes BullMQ v6 scheduler metadata without live objects", () => {
  assert.deepEqual(
    serializeScheduler({
      id: "gateway",
      key: "repeat:gateway",
      name: "default",
      next: 1760000000000,
      pattern: "*/10 * * * * *",
      startDate: 1750000000000,
      iterationCount: 42,
      template: { data: { should: "not appear" } },
    }),
    {
      id: "gateway",
      key: "repeat:gateway",
      name: "default",
      next: 1760000000000,
      pattern: "*/10 * * * * *",
      startDate: 1750000000000,
      iterationCount: 42,
    },
  );
});
