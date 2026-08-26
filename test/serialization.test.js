const assert = require("node:assert/strict");
const test = require("node:test");

const { serializeJob } = require("../lib/serialization");

test("serialized jobs expose the fields BullMQ patterns need", () => {
  const job = {
    id: "1",
    name: "email",
    queueName: "outbox",
    data: { to: "someone" },
    opts: { attempts: 3, backoff: 1000 },
    progress: 50,
    attemptsMade: 1,
    // Distinct from attemptsMade: it counts every activation, including
    // rate-limited ones, which is what the stop-retrying pattern branches on.
    attemptsStarted: 2,
    failedReason: "boom",
    returnvalue: "ok",
    deduplicationId: "dedupe-1",
  };

  const serialized = serializeJob(job);
  assert.equal(serialized.attemptsStarted, 2);
  assert.equal(serialized.attemptsMade, 1);
  assert.deepEqual(serialized.opts, { attempts: 3, backoff: 1000 });
  assert.equal(serialized.name, "email");
});

test("serialized jobs never carry a BullMQ lock token", () => {
  const serialized = serializeJob({
    id: "1",
    name: "email",
    token: "a-lock-token",
    lockToken: "a-lock-token",
  });

  assert.equal(Object.hasOwn(serialized, "token"), false);
  assert.equal(Object.hasOwn(serialized, "lockToken"), false);
  assert.doesNotMatch(JSON.stringify(serialized), /a-lock-token/);
});
