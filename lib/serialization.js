"use strict";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function copyKnownFields(source, fields) {
  if (!source) {
    return source;
  }
  const result = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function serializeJob(job) {
  if (!job) {
    return job;
  }

  return copyKnownFields(job, [
    "id",
    "name",
    "queueName",
    "data",
    "opts",
    "progress",
    "attemptsMade",
    "attemptsStarted",
    "failedReason",
    "stacktrace",
    "returnvalue",
    "timestamp",
    "processedOn",
    "finishedOn",
    "delay",
    "priority",
    "parentKey",
    "deduplicationId",
  ]);
}

function serializeFlowJob(flowJob) {
  if (!flowJob) {
    return flowJob;
  }

  return {
    job: serializeJob(flowJob.job),
    children: Array.isArray(flowJob.children)
      ? flowJob.children.map(serializeFlowJob)
      : undefined,
  };
}

module.exports = {
  serializeFlowJob,
  serializeJob,
};
