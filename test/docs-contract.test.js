const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("agent and user documentation files exist", () => {
  for (const file of [
    "CLAUDE.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/REFERENCE_MAP.md",
    "docs/RULES.md",
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
    "docs/TELEMETRY.md",
    "docs/RELEASE.md",
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `${file} missing`);
  }
});

test("agent instructions keep global rules and the Claude import discoverable", () => {
  assert.match(read("AGENTS.md"), /^## Before Any Change$/m);
  assert.match(read("CLAUDE.md"), /^@AGENTS\.md$/m);
});

test("README documents BullMQ migration, supported deployments, and unsupported features", () => {
  const readme = read("README.md");
  for (const text of [
    "BullMQ 6.2.1",
    "Node-RED 5",
    "Node.js 22.9",
    "@pauldeng/node-red-contrib-bullmq",
    "npm install @pauldeng/node-red-contrib-bullmq",
    "https://github.com/pauldeng/node-red-contrib-bullmq",
    "Redis Cluster",
    "AWS MemoryDB",
    "Sentinel",
    "Unsupported",
    "maxmemory-policy=noeviction",
    "Append Only File",
    "clear text",
    "Bull v4 Redis data is not automatically migrated",
  ]) {
    assert.match(
      readme,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("production docs cover persistence, payload protection, and flow retention", () => {
  const connections = read("docs/CONNECTIONS.md");
  const nodeGuide = read("docs/NODE_GUIDE.md");
  for (const text of [
    "Append Only File",
    "maxmemory-policy=noeviction",
    "clear text",
    "sentinelRetryStrategy",
  ]) {
    assert.match(connections, new RegExp(text));
  }
  for (const text of ["bullmq flow", "queuesOptions", "job's own `opts`"]) {
    assert.match(nodeGuide, new RegExp(text));
  }
});

test("release documentation covers npm and Node-RED Flow Library publication", () => {
  const release = read("docs/RELEASE.md");
  for (const text of [
    "npm pack --dry-run",
    "npm publish",
    "trusted publishing",
    "flows.nodered.org",
    "Node-RED Flow Library",
    "npm run test:deployments",
    "MEMORYDB_ENABLED=1",
  ]) {
    assert.match(
      release,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("examples include the required basecasts scheduled job flow", () => {
  const example = read("examples/example_flow.json");
  assert.match(example, /"name"\s*:\s*"basecasts"/);
  assert.match(example, /gateway-FCC23DFFFE0AA2A8/);
  assert.match(example, /30 9,19,29,39,49,59 \* \* \* \*/);
  assert.match(example, /"type"\s*:\s*"bullmq events"/);
  assert.match(example, /"type"\s*:\s*"bullmq flow"/);
});

test("examples include simple BullMQ feature import flows", () => {
  const fileText = read("examples/bullmq_features.json");
  const example = JSON.parse(fileText);
  const readme = read("examples/README.md");
  const nodeText = JSON.stringify(example);
  const functionText = example
    .filter((node) => node.type === "function")
    .map((node) => node.func)
    .join("\n");
  const searchableText = `${nodeText}\n${functionText}`;

  for (const label of [
    "delay: send later",
    "delay: series of one-off jobs",
    "delay: series at exact date-times",
    "priority: high priority",
    "dedupe: same job once",
    "rate limit: 2 per second",
    "scheduler: every minute",
    "manual ack worker",
    "flow: parent plus child",
  ]) {
    assert.match(
      nodeText,
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(readme, new RegExp(label.split(":")[0], "i"));
  }

  for (const text of [
    "delay: 10000",
    "priority: 1",
    "deduplication: { id: msg.payload }",
    'msg.cmd = "setGlobalRateLimit"',
    'msg.cmd = "upsertJobScheduler"',
    'msg.repeat = { pattern: "*/1 * * * *" }',
    'msg.cmd = "addBulk"',
    "Date.parse(at) - now",
    '"bullmq events"',
    '"bullmq job"',
    '"bullmq flow"',
  ]) {
    assert.match(
      searchableText,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("examples include a dedicated BullMQ v6 Job Scheduler flow", () => {
  const fileText = read("examples/repeatable_jobs.json");
  const example = JSON.parse(fileText);
  const readme = read("examples/README.md");
  const nodeText = JSON.stringify(example);
  const functionText = example
    .filter((node) => node.type === "function")
    .map((node) => node.func)
    .join("\n");
  const searchableText = `${nodeText}\n${functionText}`;

  for (const label of [
    "scheduler: upsert basecasts job",
    "scheduler: getJobSchedulers",
    "scheduler: getJobSchedulersCount",
    "scheduler: getJobScheduler",
    "scheduler: removeJobScheduler",
    "scheduler: stopAndRemoveAllJobs",
    "scheduler: upsert with timezone",
  ]) {
    assert.match(
      searchableText,
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  for (const text of [
    'msg.cmd = "upsertJobScheduler"',
    'pattern: "30 9,19,29,39,49,59 * * * *"',
    'tz: "UTC"',
    'msg.cmd = "stopAndRemoveAllJobs"',
    'msg.cmd = "getJobSchedulers"',
    'msg.cmd = "getJobSchedulersCount"',
    'msg.cmd = "removeJobScheduler"',
    "msg.schedulerId = msg.payload",
    'msg.cmd = "getJobScheduler"',
    "gateway-FCC23DFFFE0AA2A8",
  ]) {
    assert.match(
      searchableText,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  assert.match(readme, /repeatable_jobs\.json/);
  assert.match(readme, /stopAndRemoveAllJobs/);
});

test("testing docs describe the executable Docker deployment matrix", () => {
  const testing = read("docs/TESTING.md");
  for (const text of [
    "npm run test:deployments",
    "single-noauth",
    "single-auth",
    "single-tls",
    "cluster-auth",
    "cluster-tls",
    "sentinel-auth",
    "sentinel-tls",
    "MEMORYDB_ENABLED=1",
  ]) {
    assert.match(
      testing,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("repository text does not contain MemoryDB secret assignments", () => {
  const forbiddenPatterns = [
    /MEMORYDB_PASSWORD\s*=\s*["'][^"']+["']/,
    /MEMORYDB_USERNAME\s*=\s*["'][^"']+["']/,
    /clustercfg\.memdb\.bchgcd\.memorydb\.ap-southeast-2\.amazonaws\.com/,
  ];
  const files = [
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "docs/REFERENCE_MAP.md",
    "docs/RULES.md",
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
    "docs/TELEMETRY.md",
    "examples/README.md",
    "examples/example_flow.json",
    "examples/bullmq_features.json",
    "examples/repeatable_jobs.json",
    "package.json",
  ];

  const allText = files
    .filter((file) => fs.existsSync(path.join(repoRoot, file)))
    .map(read)
    .join("\n");
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(allText, pattern);
  }
});

test("public package docs and helpers use the BullMQ repo name and Node.js 22.9 support", () => {
  const files = [
    "README.md",
    "docs/REFERENCE_MAP.md",
    "docs/RULES.md",
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
    "docs/TELEMETRY.md",
    "examples/README.md",
    "package.json",
    "package-lock.json",
    "scripts/run-deployment-tests.js",
    "test/playwright/start-node-red.js",
  ];

  const allText = files
    .filter((file) => fs.existsSync(path.join(repoRoot, file)))
    .map(read)
    .join("\n");

  assert.doesNotMatch(
    allText,
    /github\.com\/pauldeng\/node-red-contrib-bull(?!mq)/,
    "old repository URL must not remain in public docs or helpers",
  );
  assert.doesNotMatch(
    allText,
    /Node\.js 24|Node\.js 24\+|>=24/,
    "Node.js 24 must not remain the public runtime floor",
  );
  assert.doesNotMatch(
    allText,
    /Node\.js 18|Node\.js 20|Node-RED 4\.1|>=4\.1\.0/,
    "the retired Node.js 18 / Node-RED 4.1 floors must not creep back",
  );
  assert.match(allText, /github\.com\/pauldeng\/node-red-contrib-bullmq/);
  assert.match(allText, /Node\.js 22\.9/);
});

test("maintained docs match current BullMQ runtime contracts", () => {
  const readme = read("README.md");
  const changelog = read("CHANGELOG.md");
  const referenceMap = read("docs/REFERENCE_MAP.md");
  const architecture = read("docs/ARCHITECTURE.md");
  const nodeGuide = read("docs/NODE_GUIDE.md");
  const testing = read("docs/TESTING.md");
  const troubleshooting = read("docs/TROUBLESHOOTING.md");
  const commands = read("docs/COMMANDS.md");
  const connections = read("docs/CONNECTIONS.md");
  const release = read("docs/RELEASE.md");

  for (const example of [
    "examples/example_flow.json",
    "examples/bullmq_features.json",
    "examples/repeatable_jobs.json",
  ]) {
    assert.match(readme, new RegExp(example.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(readme, /required `basecasts`/);
  assert.doesNotMatch(testing, /required `basecasts`/);

  assert.match(referenceMap, /test\/shutdown\.test\.js/);
  assert.match(referenceMap, /test\/async-style\.test\.js/);
  assert.match(testing, /shutdown\.test\.js/);
  assert.match(testing, /async-style\.test\.js/);

  assert.match(architecture, /`bullmq cmd`.*shared producer connection/i);
  assert.match(architecture, /config node owns the shared queue/i);
  assert.doesNotMatch(commands, /msg\.command/);
  assert.doesNotMatch(nodeGuide, /msg\.command/);

  for (const event of [
    "active",
    "added",
    "cleaned",
    "completed",
    "deduplicated",
    "delayed",
    "drained",
    "duplicated",
    "failed",
    "paused",
    "progress",
    "removed",
    "resumed",
    "stalled",
    "waiting",
    "waiting-children",
  ]) {
    assert.match(nodeGuide, new RegExp(`\\b${event}\\b`));
  }

  for (const text of [
    "bare IPv6",
    "bracketed IPv6",
    "redis://",
    "rediss://",
    "sentinelTls",
    "URL credentials",
  ]) {
    assert.match(
      connections,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  }
  assert.match(connections, /schemes?.*agree with.*TLS/i);
  assert.match(connections, /DNS lookup passthrough/i);
  assert.doesNotMatch(connections, /TLS-enabled cluster discovery/);
  assert.match(connections, /rejects unauthorized certificates by default/i);
  assert.doesNotMatch(connections, /`memorydb`.*compatibility alias/i);
  assert.match(connections, /read only from Node-RED credentials/i);

  assert.doesNotMatch(troubleshooting, /msg\.jobopts\.jobId/);
  assert.doesNotMatch(release, /\.github\/workflows\/codeql\.yml/);
  assert.match(release, /Code scanning.*default setup/i);

  for (const text of [
    "BullMQ 6.2.1",
    "ioredis 5.11.1",
    "resource",
    "URL credentials",
    "limiter",
  ]) {
    assert.match(changelog, new RegExp(text, "i"));
  }
});
