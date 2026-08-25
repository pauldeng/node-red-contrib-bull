"use strict";

const {
  getLegacySchedulerId,
  normalizeAddRequest,
  serializeScheduler,
} = require("./scheduler");
const { serializeJob } = require("./serialization");

const CLEAN_STATES = ["completed", "failed", "delayed", "wait"];

function valueOrDefault(value, defaultValue) {
  return value === undefined || value === null ? defaultValue : value;
}

async function getRequiredJob(queue, msg) {
  const jobId = String(msg.jobId || msg.jobid || "").trim();
  if (!jobId) {
    throw new Error("msg.jobId is required");
  }
  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  return job;
}

async function dispatchAdd(queue, msg) {
  const request = normalizeAddRequest(msg);
  if (request.kind === "scheduler") {
    return serializeJob(
      await queue.upsertJobScheduler(
        request.schedulerId,
        request.repeat,
        request.template,
      ),
    );
  }
  return serializeJob(
    await queue.add(request.name, request.data, request.opts),
  );
}

async function dispatchStopAndRemoveAllJobs(queue) {
  const schedulers = await queue.getJobSchedulers(0, -1, true);
  const removedSchedulers = [];
  for (const scheduler of schedulers || []) {
    const id = scheduler.id || scheduler.key;
    if (id) {
      await queue.removeJobScheduler(id);
      removedSchedulers.push(id);
    }
  }

  await queue.drain(true);

  const cleaned = {};
  for (const state of CLEAN_STATES) {
    cleaned[state] = await queue.clean(0, 0, state);
  }

  return { removedSchedulers, cleaned };
}

async function dispatchCommand(queue, msg = {}) {
  const cmd = msg.cmd || msg.command || "add";

  switch (cmd) {
    case "add":
      return dispatchAdd(queue, msg);
    case "addBulk": {
      const jobs = msg.payload || [];
      if (Array.isArray(jobs)) {
        for (const job of jobs) {
          if (job && job.opts && job.opts.repeat) {
            throw new Error(
              'addBulk does not support repeat options; use cmd "upsertJobScheduler", or cmd "add" with msg.jobopts.repeat, to schedule repeating jobs',
            );
          }
        }
      }
      return (await queue.addBulk(jobs)).map(serializeJob);
    }
    case "getJob":
      return serializeJob(await queue.getJob(msg.jobId || msg.jobid));
    case "getJobs":
      return (
        await queue.getJobs(
          msg.types,
          valueOrDefault(msg.start, 0),
          valueOrDefault(msg.end, -1),
          valueOrDefault(msg.asc, false),
        )
      ).map(serializeJob);
    case "getJobState": {
      const job = await getRequiredJob(queue, msg);
      return job.getState();
    }
    case "removeJob": {
      const job = await getRequiredJob(queue, msg);
      await job.remove();
      return true;
    }
    case "retryJob": {
      const job = await getRequiredJob(queue, msg);
      await job.retry(msg.state);
      return serializeJob(job);
    }
    case "retryJobs":
      return queue.retryJobs(msg.opts || {});
    case "getDelayed":
      return (
        await queue.getDelayed(
          valueOrDefault(msg.start, 0),
          valueOrDefault(msg.end, -1),
        )
      ).map(serializeJob);
    case "changeDelay": {
      const job = await getRequiredJob(queue, msg);
      await job.changeDelay(msg.delay);
      return serializeJob(job);
    }
    case "promoteJob": {
      const job = await getRequiredJob(queue, msg);
      await job.promote();
      return serializeJob(job);
    }
    case "promoteJobs":
      return queue.promoteJobs();
    case "getPrioritized":
      return (
        await queue.getPrioritized(
          valueOrDefault(msg.start, 0),
          valueOrDefault(msg.end, -1),
        )
      ).map(serializeJob);
    case "getCountsPerPriority":
      return queue.getCountsPerPriority(msg.priorities || []);
    case "changePriority": {
      const job = await getRequiredJob(queue, msg);
      await job.changePriority({
        priority: msg.priority,
        lifo: valueOrDefault(msg.lifo, false),
      });
      return serializeJob(job);
    }
    case "getDeduplicationJobId":
      return queue.getDeduplicationJobId(msg.deduplicationId);
    case "removeDeduplicationKey":
      return queue.removeDeduplicationKey(msg.deduplicationId);
    case "upsertJobScheduler":
      return serializeJob(
        await queue.upsertJobScheduler(
          getLegacySchedulerId(msg),
          msg.repeat,
          msg.template,
        ),
      );
    case "getJobScheduler":
      return serializeScheduler(
        await queue.getJobScheduler(getLegacySchedulerId(msg)),
      );
    case "getJobSchedulers":
    case "getRepeatableJobs":
      return (
        await queue.getJobSchedulers(
          valueOrDefault(msg.start, 0),
          valueOrDefault(msg.end, -1),
          valueOrDefault(msg.asc, true),
        )
      ).map(serializeScheduler);
    case "getJobSchedulersCount":
    case "count":
      return queue.getJobSchedulersCount();
    case "removeJobScheduler":
    case "removeRepeatableByKey":
      return queue.removeJobScheduler(getLegacySchedulerId(msg));
    case "getRepeatableJobByKey":
      return serializeScheduler(
        await queue.getJobScheduler(getLegacySchedulerId(msg)),
      );
    case "getJobCounts":
      return queue.getJobCounts(...(msg.types || []));
    case "pause":
      await queue.pause();
      return true;
    case "resume":
      await queue.resume();
      return true;
    case "isPaused":
      return queue.isPaused();
    case "isMaxed":
      return queue.isMaxed();
    case "drain":
      await queue.drain(valueOrDefault(msg.delayed, false));
      return true;
    case "clean":
      return queue.clean(
        valueOrDefault(msg.grace, 0),
        valueOrDefault(msg.limit, 1000),
        msg.state || "completed",
      );
    case "stopAndRemoveAllJobs":
      return dispatchStopAndRemoveAllJobs(queue);
    case "setGlobalConcurrency":
      await queue.setGlobalConcurrency(msg.concurrency);
      return true;
    case "getGlobalConcurrency":
      return queue.getGlobalConcurrency();
    case "removeGlobalConcurrency":
      return queue.removeGlobalConcurrency();
    case "setGlobalRateLimit": {
      const max = msg.max ?? msg.payload?.max;
      const duration = msg.duration ?? msg.payload?.duration;
      if (max == null || duration == null) {
        throw new Error("msg.max and msg.duration are required");
      }
      await queue.setGlobalRateLimit(max, duration);
      return true;
    }
    case "getGlobalRateLimit":
      return queue.getGlobalRateLimit();
    case "removeGlobalRateLimit":
      return queue.removeGlobalRateLimit();
    case "rateLimit":
      await queue.rateLimit(msg.duration);
      return true;
    case "getRateLimitTtl":
      return queue.getRateLimitTtl(msg.maxJobs);
    case "removeRateLimitKey":
      return queue.removeRateLimitKey();
    case "addJobLog":
      return queue.addJobLog(msg.jobId || msg.jobid, msg.logRow, msg.keepLogs);
    case "getJobLogs":
      return queue.getJobLogs(
        msg.jobId || msg.jobid,
        valueOrDefault(msg.start, 0),
        valueOrDefault(msg.end, -1),
        valueOrDefault(msg.asc, true),
      );
    case "getVersion":
      return queue.getVersion();
    case "exportPrometheusMetrics":
      return queue.exportPrometheusMetrics();
    default:
      throw new Error(`Unsupported bull cmd: ${cmd}`);
  }
}

module.exports = {
  dispatchCommand,
};
