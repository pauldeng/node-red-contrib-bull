const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const packageLock = require("../package-lock.json");
const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("package metadata targets BullMQ, Node.js 22.9+, and Node-RED 5.x", () => {
  assert.equal(packageJson.name, "@pauldeng/node-red-contrib-bullmq");
  assert.equal(packageJson.version, "1.0.3");
  assert.equal(packageJson.main, "bull-queue.js");
  assert.equal(
    packageJson.description,
    "BullMQ-backed Redis job queue nodes for Node-RED",
  );
  assert.equal(packageJson.repository?.type, "git");
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/pauldeng/node-red-contrib-bullmq.git",
  );
  assert.equal(
    packageJson.homepage,
    "https://github.com/pauldeng/node-red-contrib-bullmq#readme",
  );
  assert.equal(
    packageJson.bugs?.url,
    "https://github.com/pauldeng/node-red-contrib-bullmq/issues",
  );
  assert.equal(
    packageJson.publishConfig?.registry,
    "https://registry.npmjs.org/",
  );
  assert.equal(packageJson.publishConfig?.access, "public");

  assert.equal(packageJson.dependencies?.bull, undefined);
  assert.equal(packageJson.dependencies?.["sprintf-js"], undefined);
  assert.equal(packageJson.dependencies?.bullmq, "6.2.1");
  assert.equal(packageJson.dependencies?.ioredis, "5.11.1");
  assert.equal(packageLock.packages?.["node_modules/bullmq"]?.version, "6.2.1");
  // BullMQ 6 dropped ioredis to an optional peer dependency, so nothing in
  // bullmq's own tree pins it any more. Our direct dependency is the only
  // reason a Redis client resolves at all: assert the resolved version, and
  // assert the peer contract we are satisfying.
  assert.equal(
    packageLock.packages?.["node_modules/bullmq"]?.dependencies?.ioredis,
    undefined,
  );
  assert.equal(
    packageLock.packages?.["node_modules/bullmq"]?.peerDependencies?.ioredis,
    ">=5.0.0",
  );
  assert.equal(
    packageLock.packages?.["node_modules/bullmq"]?.peerDependenciesMeta?.ioredis
      ?.optional,
    true,
  );
  assert.equal(
    packageLock.packages?.["node_modules/ioredis"]?.version,
    "5.11.1",
  );
  assert.equal(
    packageLock.packages?.["node_modules/ioredis"]?.version,
    "5.11.1",
  );
  assert.equal(
    packageLock.packages?.["node_modules/bullmq/node_modules/ioredis"],
    undefined,
  );

  assert.equal(packageJson.engines?.node, ">=22.9");
  assert.equal(packageJson["node-red"]?.version, ">=5.0.0 <6");

  assert.equal(packageJson.devDependencies?.["@playwright/test"], "1.62.1");
  assert.equal(packageJson.devDependencies?.["node-red"], "5.0.4");
  assert.equal(packageJson.devDependencies?.prettier, "3.9.6");
  assert.ok(packageJson.devDependencies?.["node-red-node-test-helper"]);

  // Tests run on node:test; mocha and sinon are not used directly.
  assert.equal(packageJson.devDependencies?.mocha, undefined);
  assert.equal(packageJson.devDependencies?.sinon, undefined);
});

test("package lock root metadata mirrors publish package metadata", () => {
  const rootPackage = packageLock.packages?.[""];

  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(rootPackage?.name, packageJson.name);
  assert.equal(rootPackage?.version, packageJson.version);
  assert.equal(rootPackage?.engines?.node, packageJson.engines.node);
});

test("runtime code no longer imports bull or sprintf-js", () => {
  const runtime = fs.readFileSync(
    path.join(__dirname, "..", "bull-queue.js"),
    "utf8",
  );

  assert.doesNotMatch(runtime, /require\(["']bull["']\)/);
  assert.doesNotMatch(runtime, /require\(["']sprintf-js["']\)/);
});

test("published files allowlist ships runtime assets and excludes tests and secrets", () => {
  const files = packageJson.files;
  assert.ok(
    Array.isArray(files),
    "package.json must declare a files allowlist",
  );

  for (const entry of [
    "bull-queue.js",
    "bull-queue.html",
    "lib/",
    "icons/",
    "examples/",
    "docs/*.md",
  ]) {
    assert.ok(files.includes(entry), `files must include ${entry}`);
  }

  // Never publish tests, fixtures (incl. TLS keys), runner scripts, or local
  // editor/agent config.
  for (const entry of files) {
    assert.doesNotMatch(
      entry,
      /^(test|scripts|\.claude|\.github|docs\/superpowers)/,
      `files must not publish ${entry}`,
    );
  }
});

test("package metadata and documentation files are not executable", () => {
  for (const file of [
    "package.json",
    "package-lock.json",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
  ]) {
    const mode = fs.statSync(path.join(__dirname, "..", file)).mode;
    assert.equal(mode & 0o111, 0, `${file} must not have executable bits`);
  }
});

test("GitHub automation and security assets exist for publishing", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
    ".github/dependabot.yml",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
  ]) {
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", file)),
      `${file} missing`,
    );
  }
});

test("GitHub CI workflow verifies the Node-RED package release contract", () => {
  const ci = read(".github/workflows/ci.yml");

  for (const text of [
    "pull_request:",
    "push:",
    "actions/checkout@",
    "actions/setup-node@",
    "cache: npm",
    "22.x",
    "24.x",
    "npm ci",
    "npm test",
    "npm run test:playwright",
    "npm run format:check",
    "npm audit --omit=dev --audit-level=moderate",
    "npm pack --dry-run",
  ]) {
    assert.match(ci, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("GitHub publish workflow uses npm trusted publishing", () => {
  const publish = read(".github/workflows/publish.yml");

  for (const text of [
    "release:",
    "types: [published]",
    "contents: read",
    "id-token: write",
    "actions/setup-node@",
    "registry-url: https://registry.npmjs.org/",
    "npm ci",
    "npm test",
    "npm run test:playwright",
    "npm audit --omit=dev --audit-level=moderate",
    "npm pack --dry-run",
    "npm publish --access public",
  ]) {
    assert.match(
      publish,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("Dependabot keeps npm and GitHub Actions dependencies current", () => {
  const dependabot = read(".github/dependabot.yml");

  for (const text of [
    "version: 2",
    'package-ecosystem: "npm"',
    'package-ecosystem: "github-actions"',
    'directory: "/"',
    "interval: weekly",
  ]) {
    assert.match(
      dependabot,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("GitHub community templates collect actionable reports", () => {
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const feature = read(".github/ISSUE_TEMPLATE/feature_request.yml");
  const pr = read(".github/pull_request_template.md");

  for (const text of [
    "Node-RED version",
    "Node.js version",
    "Operating system",
    "CPU architecture",
    "BullMQ version",
    "Error message",
    "Redis deployment",
    "Database server",
    "Database version",
    "Valkey",
    "Reproducing Node-RED flow",
  ]) {
    assert.match(bug, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const text of ["Use case", "Proposed behavior"]) {
    assert.match(
      feature,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  assert.doesNotMatch(feature, /Alternatives/);

  for (const text of [
    "Summary",
    "Verification",
    "npm test",
    "npm run test:playwright",
    "Documentation",
  ]) {
    assert.match(pr, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
