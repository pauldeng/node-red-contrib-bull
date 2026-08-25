"use strict";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function clonePlain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return { ...value };
}

function normalizeRepeatOptions(repeat) {
  const normalized = clonePlain(repeat) || {};
  if (
    normalized.cron &&
    normalized.pattern &&
    normalized.cron !== normalized.pattern
  ) {
    throw new Error(
      "repeat.cron and repeat.pattern must match when both are supplied",
    );
  }
  if (normalized.cron) {
    normalized.pattern = normalized.cron;
    delete normalized.cron;
  }
  if (hasOwn(normalized, "utc")) {
    const utc = normalized.utc;
    delete normalized.utc;
    if (utc) {
      if (normalized.tz && normalized.tz !== "UTC") {
        throw new Error(
          "repeat.utc and repeat.tz must match when both are supplied",
        );
      }
      normalized.tz = "UTC";
    }
  }
  return normalized;
}

function getJobData(msg) {
  if (hasOwn(msg, "jobData")) {
    return msg.jobData;
  }
  return { payload: msg.payload };
}

function normalizeAddRequest(msg = {}) {
  const jobopts = clonePlain(msg.jobopts) || {};
  const name = msg.jobName || "default";

  if (jobopts.repeat) {
    const schedulerId = String(msg.schedulerId || jobopts.jobId || "").trim();
    if (!schedulerId) {
      throw new Error(
        "scheduled jobs require msg.schedulerId or msg.jobopts.jobId",
      );
    }

    const repeat = normalizeRepeatOptions(jobopts.repeat);
    delete jobopts.repeat;
    delete jobopts.jobId;

    return {
      kind: "scheduler",
      schedulerId,
      repeat,
      template: {
        name,
        data: getJobData(msg),
        opts: jobopts,
      },
    };
  }

  return {
    kind: "job",
    name,
    data: getJobData(msg),
    opts: jobopts,
  };
}

function getLegacySchedulerId(msg = {}) {
  const schedulerId = String(
    msg.schedulerId || msg.jobid || msg.jobId || "",
  ).trim();
  if (!schedulerId) {
    throw new Error("A scheduler id is required");
  }
  return schedulerId;
}

function serializeScheduler(scheduler) {
  if (!scheduler) {
    return scheduler;
  }

  const result = {};
  for (const key of [
    "id",
    "key",
    "name",
    "next",
    "pattern",
    "every",
    "limit",
    "offset",
    "tz",
    "endDate",
    "startDate",
    "iterationCount",
  ]) {
    if (hasOwn(scheduler, key)) {
      result[key] = scheduler[key];
    }
  }
  return result;
}

module.exports = {
  getLegacySchedulerId,
  normalizeAddRequest,
  serializeScheduler,
};
