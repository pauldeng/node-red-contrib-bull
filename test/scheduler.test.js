const assert = require("node:assert/strict");
const test = require("node:test");
const { CronExpressionParser } = require("cron-parser");

const {
  getLegacySchedulerId,
  normalizeAddRequest,
  serializeScheduler,
} = require("../lib/scheduler");

test("translates Bull repeat.cron into a BullMQ Job Scheduler template", () => {
  const normalized = normalizeAddRequest({
    payload: "gateway-FCC23DFFFE0AA2A8",
    cmd: "add",
    jobopts: {
      jobId: "gateway-FCC23DFFFE0AA2A8",
      removeOnComplete: true,
      repeat: {
        cron: "30 9,19,29,39,49,59 * * * *",
      },
    },
  });

  assert.equal(normalized.kind, "scheduler");
  assert.equal(normalized.schedulerId, "gateway-FCC23DFFFE0AA2A8");
  assert.deepEqual(normalized.repeat, {
    pattern: "30 9,19,29,39,49,59 * * * *",
  });
  assert.deepEqual(normalized.template, {
    name: "default",
    data: { payload: "gateway-FCC23DFFFE0AA2A8" },
    opts: { removeOnComplete: true },
  });
});

test("accepts explicit schedulerId and repeat.pattern", () => {
  const normalized = normalizeAddRequest({
    payload: { value: 1 },
    schedulerId: "sensor-reading",
    jobName: "sample",
    jobData: { sample: true },
    jobopts: {
      repeat: {
        pattern: "*/10 * * * * *",
      },
    },
  });

  assert.equal(normalized.kind, "scheduler");
  assert.equal(normalized.schedulerId, "sensor-reading");
  assert.deepEqual(normalized.repeat, { pattern: "*/10 * * * * *" });
  assert.deepEqual(normalized.template, {
    name: "sample",
    data: { sample: true },
    opts: {},
  });
});

test("rejects conflicting repeat cron and pattern values", () => {
  assert.throws(
    () =>
      normalizeAddRequest({
        schedulerId: "conflict",
        jobopts: {
          repeat: {
            cron: "*/5 * * * * *",
            pattern: "*/10 * * * * *",
          },
        },
      }),
    /repeat\.cron and repeat\.pattern must match/,
  );
});

test("requires a stable scheduler id for scheduled jobs", () => {
  assert.throws(
    () =>
      normalizeAddRequest({
        payload: "missing-id",
        jobopts: {
          repeat: { cron: "*/5 * * * * *" },
        },
      }),
    /scheduled jobs require msg\.schedulerId or msg\.jobopts\.jobId/,
  );
});

test("translates repeat.utc into tz: UTC and the computed next fire time reflects UTC, not local time", () => {
  const pattern = "30 9,19,29,39,49,59 * * * *";
  const normalized = normalizeAddRequest({
    payload: "gateway",
    schedulerId: "gateway",
    jobopts: {
      repeat: { cron: pattern, utc: true },
    },
  });

  assert.deepEqual(normalized.repeat, { pattern, tz: "UTC" });

  const currentDate = new Date("2026-01-01T00:00:00.000Z");
  const nextWithTranslatedOptions = CronExpressionParser.parse(pattern, {
    tz: normalized.repeat.tz,
    currentDate,
  })
    .next()
    .getTime();

  // The pattern must resolve to the UTC-anchored instant, independent of
  // whatever local timezone this test happens to run in.
  assert.equal(nextWithTranslatedOptions, Date.UTC(2026, 0, 1, 0, 9, 30));

  // Prove tz is actually load-bearing (not just present in the shape): a
  // fractional-hour offset zone must compute a different instant for this
  // pattern. If the translation were dropped, this whole computation would
  // never diverge from an arbitrary other zone the way it does here.
  const nextWithDifferentOffsetTz = CronExpressionParser.parse(pattern, {
    tz: "Asia/Kathmandu",
    currentDate,
  })
    .next()
    .getTime();
  assert.notEqual(nextWithTranslatedOptions, nextWithDifferentOffsetTz);
});

test("treats repeat.utc: false as a legacy no-op and drops the key without setting tz", () => {
  const normalized = normalizeAddRequest({
    payload: "sensor",
    schedulerId: "sensor",
    jobopts: {
      repeat: { pattern: "*/10 * * * * *", utc: false },
    },
  });

  assert.deepEqual(normalized.repeat, { pattern: "*/10 * * * * *" });
});

test("rejects repeat.utc: true when repeat.tz is already set to a different zone", () => {
  assert.throws(
    () =>
      normalizeAddRequest({
        schedulerId: "conflict-tz",
        jobopts: {
          repeat: {
            pattern: "*/10 * * * * *",
            utc: true,
            tz: "America/New_York",
          },
        },
      }),
    /repeat\.utc and repeat\.tz must match when both are supplied/,
  );
});

test("normalizes normal add requests without repeat options", () => {
  const normalized = normalizeAddRequest({
    payload: "plain",
    jobopts: { jobId: "plain", priority: 2 },
  });

  assert.equal(normalized.kind, "job");
  assert.equal(normalized.name, "default");
  assert.deepEqual(normalized.data, { payload: "plain" });
  assert.deepEqual(normalized.opts, { jobId: "plain", priority: 2 });
});

test("legacy scheduler lookup uses exact ids only", () => {
  assert.equal(getLegacySchedulerId({ schedulerId: "exact" }), "exact");
  assert.equal(getLegacySchedulerId({ jobid: "legacy" }), "legacy");
  assert.throws(() => getLegacySchedulerId({}), /scheduler id/);
});

test("serializes scheduler metadata without live BullMQ objects", () => {
  assert.deepEqual(
    serializeScheduler({
      id: "gateway",
      key: "repeat:gateway",
      name: "default",
      next: 1760000000000,
      pattern: "*/10 * * * * *",
    }),
    {
      id: "gateway",
      key: "repeat:gateway",
      name: "default",
      next: 1760000000000,
      pattern: "*/10 * * * * *",
    },
  );
});

test("serializes v6 scheduler startDate and iterationCount fields, without duplicating template", () => {
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
