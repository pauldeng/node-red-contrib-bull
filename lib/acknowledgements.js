"use strict";

const { EventEmitter, once } = require("node:events");

class AcknowledgementEntry {
  constructor(context, timeoutMs) {
    this.events = new EventEmitter();
    this.settlement = undefined;
    this.job = context.job;
    this.queue = context.queue;
    this.queueName = context.queueName;
    this.runNodeId = context.runNodeId;
    this.worker = context.worker;
    // The job's lock token. Required by the moveTo* transitions and never
    // serialized into a Node-RED message.
    this.token = context.token;
    this.timeout = undefined;

    // BullMQ's per-job AbortController: aborting it (worker.cancelJob /
    // cancelAllJobs) does not settle this acknowledgement by itself, so a
    // manual-mode job would stay active forever unless we fail it here.
    this.signal = context.signal;
    this.abortListener = undefined;
    if (this.signal) {
      this.abortListener = () => {
        this.fail(new Error(String(this.signal.reason)));
      };
      this.signal.addEventListener("abort", this.abortListener);
    }

    if (timeoutMs > 0) {
      this.timeout = setTimeout(() => {
        this.fail(
          new Error(
            `BullMQ job acknowledgement timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    }
  }

  async wait() {
    const settlement =
      this.settlement || (await once(this.events, "settled"))[0];
    if (settlement.type === "reject") {
      throw settlement.error;
    }
    return settlement.value;
  }

  complete(value) {
    this.settle({ type: "resolve", value });
  }

  fail(error) {
    this.settle({ type: "reject", error });
  }

  settle(settlement) {
    if (this.settlement) {
      return;
    }
    this.settlement = settlement;
    clearTimeout(this.timeout);
    if (this.abortListener) {
      this.signal.removeEventListener("abort", this.abortListener);
    }
    this.events.emit("settled", settlement);
  }
}

// Parse a manual-acknowledgement timeout. Empty, non-numeric, or negative
// values fall back to defaultMs; 0 disables the timeout (wait indefinitely).
function parseAckTimeoutMs(value, defaultMs = 300000) {
  if (value === undefined || value === null || value === "") {
    return defaultMs;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultMs;
  }
  return parsed;
}

class AcknowledgementRegistry {
  constructor() {
    this.entries = new Map();
  }

  create(context, timeoutMs) {
    const ackId = `${context.runNodeId}:${context.job.id}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2)}`;

    const entry = new AcknowledgementEntry(context, timeoutMs);
    this.entries.set(ackId, entry);
    // Drop the entry as soon as it settles (complete, fail, timeout, or
    // rejectByRunNode) so the registry never accumulates finished jobs.
    entry.events.once("settled", () => {
      this.entries.delete(ackId);
    });
    return { ackId, entry };
  }

  get(ackId) {
    const entry = this.entries.get(ackId);
    if (!entry) {
      throw new Error(
        "Missing, stale, or already-settled BullMQ acknowledgement",
      );
    }
    return entry;
  }

  rejectByRunNode(runNodeId, err) {
    // Snapshot first: failing an entry settles it, which removes it from the
    // map via the "settled" handler registered in create().
    for (const entry of Array.from(this.entries.values())) {
      if (entry.runNodeId === runNodeId) {
        entry.fail(err);
      }
    }
  }
}

module.exports = {
  AcknowledgementRegistry,
  parseAckTimeoutMs,
};
