const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(
  path.join(__dirname, "..", "bull-queue.html"),
  "utf8",
);

function helpBlock(type) {
  const pattern = new RegExp(
    `<script type="text/html" data-help-name="${type}">([\\s\\S]*?)<\\/script>`,
  );
  const match = html.match(pattern);
  assert.ok(match, `missing help block for ${type}`);
  return match[1];
}

test("editor defines templates and registrations for all node types", () => {
  for (const type of [
    "bullmq-queue-server",
    "bullmq run",
    "bullmq cmd",
    "bullmq job",
    "bullmq events",
    "bullmq flow",
  ]) {
    assert.match(html, new RegExp(`data-template-name="${type}"`));
    assert.match(html, new RegExp(`registerType\\("${type}"`));
  }
});

test("config editor exposes deployment, cluster, sentinel, auth, and TLS fields", () => {
  for (const field of [
    "deployment",
    "clusterNodes",
    "sentinels",
    "sentinelMasterName",
    "username",
    "password",
    "sentinelUsername",
    "sentinelPassword",
    "tls",
    "sentinelTls",
    "tlsRejectUnauthorized",
    "tlsServerName",
    "prefix",
    "telemetry",
    "telemetryServiceName",
    "telemetryMetrics",
  ]) {
    assert.match(html, new RegExp(`node-config-input-${field}`));
  }
});

test("worker, job, events, and flow editors expose their stable config fields", () => {
  for (const field of [
    "completionMode",
    "ackTimeout",
    "concurrency",
    "limiterMax",
    "limiterDuration",
    "action",
    "events",
  ]) {
    assert.match(html, new RegExp(`node-input-${field}`));
  }
});

test("help documents every config node field", () => {
  const help = helpBlock("bullmq-queue-server");
  for (const text of [
    "Queue",
    "Deployment",
    "Host",
    "Port",
    "Cluster Nodes",
    "Sentinels",
    "Master",
    "Database",
    "Username",
    "Password",
    "Sentinel User",
    "Sentinel Pass",
    "TLS",
    "Sentinel TLS",
    "Verify TLS",
    "TLS Server Name",
    "CA",
    "Client Cert",
    "Client Key",
    "Prefix",
    "Telemetry",
    "Service Name",
    "Metrics",
    "bullmq-otel",
    "npm install bullmq-otel",
    "exportPrometheusMetrics",
    "Example",
  ]) {
    assert.match(help, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("help documents runtime node fields and message examples", () => {
  const expected = {
    "bullmq cmd": [
      "Name",
      "Queue",
      "msg.cmd",
      "msg.payload",
      "msg.jobName",
      "msg.jobData",
      "msg.jobopts",
      "delay",
      "priority",
      "deduplication",
      "setGlobalRateLimit",
      "Example",
    ],
    "bullmq run": [
      "Name",
      "Queue",
      "Completion",
      "Ack Timeout",
      "Concurrency",
      "Limiter Max",
      "Limiter Duration",
      "msg.payload",
      "msg.job",
      "msg.bull",
      "Example",
    ],
    "bullmq job": [
      "Name",
      "Action",
      "complete",
      "fail",
      "failUnrecoverable",
      "progress",
      "rateLimit",
      "removeDeduplicationKey",
      "getChildrenValues",
      "getFailedChildrenValues",
      "removeUnprocessedChildren",
      "msg.cmd",
      "Example",
    ],
    "bullmq events": [
      "Name",
      "Queue",
      "Events",
      "completed",
      "failed",
      "delayed",
      "deduplicated",
      "progress",
      "msg.topic",
      "msg.payload",
      "msg.bull",
      "Example",
    ],
    "bullmq flow": [
      "Name",
      "Queue",
      "msg.payload",
      "msg.flowopts",
      "parent",
      "children",
      "queueName",
      "Example",
    ],
  };

  for (const [type, texts] of Object.entries(expected)) {
    const help = helpBlock(type);
    for (const text of texts) {
      assert.match(
        help,
        new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  }
});

test("help links BullMQ API references to official API docs", () => {
  const expectedLinks = [
    "https://docs.bullmq.io/api/classes/v6.Queue.html",
    "https://docs.bullmq.io/api/interfaces/v6.QueueOptions.html",
    "https://docs.bullmq.io/api/classes/v6.Queue.html#add",
    "https://docs.bullmq.io/api/types/v6.JobsOptions.html",
    "https://docs.bullmq.io/api/types/v6.DeduplicationOptions.html",
    "https://docs.bullmq.io/api/classes/v6.Queue.html#setglobalratelimit",
    "https://docs.bullmq.io/api/classes/v6.Queue.html#upsertjobscheduler",
    "https://docs.bullmq.io/api/classes/v6.Worker.html",
    "https://docs.bullmq.io/api/interfaces/v6.WorkerOptions.html",
    "https://docs.bullmq.io/api/classes/v6.Job.html",
    "https://docs.bullmq.io/api/classes/v6.UnrecoverableError.html",
    "https://docs.bullmq.io/api/classes/v6.QueueEvents.html",
    "https://docs.bullmq.io/api/classes/v6.FlowProducer.html",
    "https://docs.bullmq.io/api/types/v6.FlowJob.html",
  ];

  for (const link of expectedLinks) {
    assert.match(html, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("worker fields use positive integer and paired limiter validation", () => {
  assert.match(html, /function positiveInteger\(value\)/);
  assert.match(html, /function optionalPositivePair\(value, otherProperty\)/);
  assert.match(html, /concurrency:\s*\{[^}]*validate: positiveInteger/);
  assert.match(html, /limiterMax:\s*\{[^}]*validate:/);
  assert.match(html, /limiterDuration:\s*\{[^}]*validate:/);
});

test("editor hides irrelevant rows and teaches configured completion", () => {
  assert.match(html, /id="node-config-input-name" placeholder="email-jobs"/);
  assert.match(html, /class="form-row bull-db-row"/);
  assert.match(html, /class="form-row bull-ack-timeout-row"/);
  assert.match(helpBlock("bullmq job"), /delete msg\.cmd;/);
});

test("telemetry fields default off and their rows toggle with the telemetry checkbox", () => {
  assert.match(html, /telemetry:\s*\{\s*value:\s*false\s*\}/);
  assert.match(html, /telemetryServiceName:\s*\{\s*value:\s*""\s*\}/);
  assert.match(html, /telemetryMetrics:\s*\{\s*value:\s*false\s*\}/);
  assert.match(html, /class="form-row bull-telemetry-row"/);
  assert.match(
    html,
    /\$\("\.bull-telemetry-row"\)\.toggle\(\$\("#node-config-input-telemetry"\)\.is\(":checked"\)\)/,
  );
  assert.match(
    html,
    /\$\("#node-config-input-telemetry"\)\.on\("change", updateBullQueueServerRows\)/,
  );
});
