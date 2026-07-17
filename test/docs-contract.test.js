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
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
    "docs/RELEASE.md",
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `${file} missing`);
  }
});

test("README documents BullMQ migration, supported deployments, and unsupported features", () => {
  const readme = read("README.md");
  for (const text of [
    "BullMQ 5.80.6",
    "Node-RED 4.1",
    "Node.js 18",
    "@pauldeng/node-red-contrib-bullmq",
    "npm install @pauldeng/node-red-contrib-bullmq",
    "https://github.com/pauldeng/node-red-contrib-bullmq",
    "Redis Cluster",
    "AWS MemoryDB",
    "Sentinel",
    "Unsupported",
    "maxmemory-policy=noeviction",
    "Bull v4 Redis data is not automatically migrated",
  ]) {
    assert.match(
      readme,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
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
  assert.match(example, /"type"\s*:\s*"bull events"/);
  assert.match(example, /"type"\s*:\s*"bull flow"/);
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
    'repeat: { pattern: "*/1 * * * *" }',
    '"bull events"',
    '"bull job"',
    '"bull flow"',
  ]) {
    assert.match(
      searchableText,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("examples include a dedicated repeatable jobs command flow", () => {
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
    "repeat: add basecasts job",
    "repeat: getRepeatableJobs",
    "repeat: count",
    "repeat: getRepeatableJobByKey",
    "repeat: removeRepeatableByKey",
    "repeat: stopAndRemoveAllJobs",
  ]) {
    assert.match(
      searchableText,
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  for (const text of [
    'msg.cmd = "add"',
    'msg.jobopts = {"jobId": msg.payload, "repeat": {"cron": "30 9,19,29,39,49,59 * * * *"}};',
    'msg.cmd = "stopAndRemoveAllJobs"',
    'msg.cmd = "getRepeatableJobs"',
    'msg.cmd = "count"',
    'msg.cmd = "removeRepeatableByKey"',
    "msg.jobid = msg.payload",
    'msg.cmd = "getRepeatableJobByKey"',
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
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
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

test("public package docs and helpers use the BullMQ repo name and Node.js 18 support", () => {
  const files = [
    "README.md",
    "docs/REFERENCE_MAP.md",
    "docs/ARCHITECTURE.md",
    "docs/NODE_GUIDE.md",
    "docs/CHANGE_WORKFLOW.md",
    "docs/TESTING.md",
    "docs/TROUBLESHOOTING.md",
    "docs/MIGRATION.md",
    "docs/COMMANDS.md",
    "docs/CONNECTIONS.md",
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
  assert.match(allText, /github\.com\/pauldeng\/node-red-contrib-bullmq/);
  assert.match(allText, /Node\.js 18/);
});
