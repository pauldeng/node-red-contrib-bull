"use strict";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getSchedulerId(msg = {}) {
  const schedulerId = String(msg.schedulerId || "").trim();
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
  getSchedulerId,
  serializeScheduler,
};
