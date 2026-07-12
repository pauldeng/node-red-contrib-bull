const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");
const test = require("node:test");

const {
  AcknowledgementRegistry,
  parseAckTimeoutMs,
} = require("../lib/acknowledgements");

function context(overrides = {}) {
  return {
    job: { id: "job-1" },
    queue: {},
    queueName: "testcasts",
    runNodeId: "run-1",
    ...overrides,
  };
}

test("resolves the waiter with the completion value", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.complete({ ok: true });

  assert.deepEqual(await settled, { ok: true });
});

test("rejects the waiter when the job fails", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.fail(new Error("boom"));

  await assert.rejects(settled, /boom/);
});

test("returns a completion that happened before waiting", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  entry.complete({ ok: true });

  assert.deepEqual(
    await Promise.race([entry.wait(), sleep(25, "missed settlement")]),
    { ok: true },
  );
});

test("throws a failure that happened before waiting", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  entry.fail(new Error("boom"));

  await assert.rejects(
    Promise.race([entry.wait(), sleep(25, "missed settlement")]),
    /boom/,
  );
});

test("removes the entry from the registry after completion", async () => {
  const registry = new AcknowledgementRegistry();
  const { ackId, entry } = registry.create(context(), 0);

  assert.equal(registry.entries.size, 1);

  const settled = entry.wait();
  entry.complete("done");
  await settled;

  assert.equal(
    registry.entries.size,
    0,
    "settled acknowledgements must not stay in the registry",
  );
  assert.throws(() => registry.get(ackId), /Missing, stale/);
});

test("removes the entry from the registry after failure", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 0);

  const settled = entry.wait();
  entry.fail(new Error("nope"));
  await assert.rejects(settled);

  assert.equal(registry.entries.size, 0);
});

test("removes the entry from the registry after a timeout", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), 10);

  await assert.rejects(entry.wait(), /timed out/);
  assert.equal(registry.entries.size, 0);
});

test("rejectByRunNode settles and drops every entry for that run node", async () => {
  const registry = new AcknowledgementRegistry();
  const first = registry.create(context({ job: { id: "a" } }), 0);
  const second = registry.create(context({ job: { id: "b" } }), 0);
  const other = registry.create(
    context({ runNodeId: "run-2", job: { id: "c" } }),
    0,
  );

  const firstWait = first.entry.wait();
  const secondWait = second.entry.wait();

  registry.rejectByRunNode("run-1", new Error("closed"));

  await assert.rejects(firstWait, /closed/);
  await assert.rejects(secondWait, /closed/);
  assert.equal(registry.entries.size, 1, "entries for other run nodes remain");
  assert.equal(registry.get(other.ackId), other.entry);

  // Settle the survivor so the test leaves no dangling waiter.
  const otherWait = other.entry.wait();
  other.entry.complete("ok");
  await otherWait;
  assert.equal(registry.entries.size, 0);
});

test("parseAckTimeoutMs defaults empty, non-numeric, and negative values", () => {
  assert.equal(parseAckTimeoutMs(undefined), 300000);
  assert.equal(parseAckTimeoutMs(null), 300000);
  assert.equal(parseAckTimeoutMs(""), 300000);
  assert.equal(parseAckTimeoutMs("abc"), 300000);
  assert.equal(parseAckTimeoutMs(-5), 300000);
  assert.equal(parseAckTimeoutMs(undefined, 1000), 1000);
});

test("parseAckTimeoutMs keeps 0 so the timeout can be disabled", () => {
  assert.equal(parseAckTimeoutMs(0), 0);
  assert.equal(parseAckTimeoutMs("0"), 0);
});

test("parseAckTimeoutMs accepts positive millisecond values", () => {
  assert.equal(parseAckTimeoutMs(5000), 5000);
  assert.equal(parseAckTimeoutMs("60000"), 60000);
});

test("an ack timeout of 0 never settles on its own", async () => {
  const registry = new AcknowledgementRegistry();
  const { entry } = registry.create(context(), parseAckTimeoutMs(0));

  let settledValue;
  let settled = false;
  const waiter = (async () => {
    settledValue = await entry.wait();
    settled = true;
  })();

  await sleep(30);
  assert.equal(settled, false, "a 0 timeout must wait indefinitely");
  assert.equal(registry.entries.size, 1);

  // Complete it so the test leaves no pending waiter.
  entry.complete("done");
  await waiter;
  assert.equal(settledValue, "done");
});

test("create returns unique ack ids", () => {
  const registry = new AcknowledgementRegistry();
  const a = registry.create(context(), 0);
  const b = registry.create(context(), 0);
  assert.notEqual(a.ackId, b.ackId);
});

test("does not leak entries under repeated completion", async () => {
  const registry = new AcknowledgementRegistry();

  for (let i = 0; i < 100; i += 1) {
    const { entry } = registry.create(context({ job: { id: `job-${i}` } }), 0);
    const settled = entry.wait();
    entry.complete(i);
    await settled;
  }

  // Give any asynchronous cleanup a chance to run.
  await sleep(0);
  assert.equal(registry.entries.size, 0);
});
