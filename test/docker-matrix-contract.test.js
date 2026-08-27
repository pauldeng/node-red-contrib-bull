const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

test("package exposes a Docker deployment matrix test command", () => {
  const packageJson = require("../package.json");

  assert.equal(
    packageJson.scripts?.["test:deployments"],
    "node scripts/run-deployment-tests.js",
  );
  assert.ok(exists("scripts/run-deployment-tests.js"));
});

test("Docker deployment fixtures cover Redis topologies and PostgreSQL", () => {
  const requiredFiles = [
    "test/deployments/single-noauth/compose.yml",
    "test/deployments/single-auth/compose.yml",
    "test/deployments/single-auth/redis.conf",
    "test/deployments/single-tls/compose.yml",
    "test/deployments/single-tls/redis.conf",
    "test/deployments/cluster-auth/compose.yml",
    "test/deployments/cluster-auth/redis-7000.conf",
    "test/deployments/cluster-auth/redis-7001.conf",
    "test/deployments/cluster-tls/compose.yml",
    "test/deployments/cluster-tls/redis-17002.conf",
    "test/deployments/cluster-tls/redis-17003.conf",
    "test/deployments/sentinel-auth/compose.yml",
    "test/deployments/sentinel-auth/redis-master.conf",
    "test/deployments/sentinel-auth/redis-replica-6380.conf",
    "test/deployments/sentinel-auth/redis-replica-6381.conf",
    "test/deployments/sentinel-tls/compose.yml",
    "test/deployments/sentinel-tls/redis-master.conf",
    "test/deployments/sentinel-tls/redis-replica-16385.conf",
    "test/deployments/sentinel-tls/redis-replica-16386.conf",
    "test/deployments/postgres-plain/compose.yml",
    "test/deployments/postgres-tls/compose.yml",
    "test/deployments/postgres-tls/Dockerfile",
    "test/deployments/tls-certs/ca.crt",
    "test/deployments/tls-certs/redis.crt",
    "test/deployments/tls-certs/redis.key",
  ];

  for (const file of requiredFiles) {
    assert.ok(exists(file), `${file} missing`);
  }

  assert.match(read("test/deployments/cluster-auth/compose.yml"), /CLUSTER/);
  assert.match(read("test/deployments/cluster-tls/compose.yml"), /--tls/);
  assert.match(read("test/deployments/sentinel-auth/compose.yml"), /sentinel/i);
  assert.match(read("test/deployments/sentinel-tls/compose.yml"), /tls-port/);
  assert.match(
    read("test/deployments/postgres-plain/compose.yml"),
    /postgres/i,
  );
  assert.match(read("test/deployments/postgres-tls/compose.yml"), /ssl=on/);
});

test("Docker Redis fixtures use BullMQ production-safe memory policy", () => {
  for (const file of [
    "test/deployments/single-noauth/compose.yml",
    "test/deployments/single-auth/redis.conf",
    "test/deployments/single-tls/redis.conf",
    "test/deployments/cluster-auth/redis-7000.conf",
    "test/deployments/cluster-auth/redis-7001.conf",
    "test/deployments/cluster-tls/redis-17002.conf",
    "test/deployments/cluster-tls/redis-17003.conf",
    "test/deployments/sentinel-auth/redis-master.conf",
    "test/deployments/sentinel-auth/redis-replica-6380.conf",
    "test/deployments/sentinel-auth/redis-replica-6381.conf",
    "test/deployments/sentinel-tls/redis-master.conf",
    "test/deployments/sentinel-tls/redis-replica-16385.conf",
    "test/deployments/sentinel-tls/redis-replica-16386.conf",
  ]) {
    assert.match(read(file), /maxmemory-policy[\s-]+noeviction/);
  }
});

test("Docker deployment fixtures avoid common local Redis host ports", () => {
  const fixtureText = [
    "test/deployments/single-noauth/compose.yml",
    "test/deployments/single-auth/compose.yml",
    "test/deployments/single-tls/compose.yml",
    "test/deployments/cluster-auth/compose.yml",
    "test/deployments/cluster-auth/redis-7000.conf",
    "test/deployments/cluster-auth/redis-7001.conf",
    "test/deployments/cluster-tls/compose.yml",
    "test/deployments/cluster-tls/redis-17002.conf",
    "test/deployments/cluster-tls/redis-17003.conf",
    "test/deployments/sentinel-auth/compose.yml",
    "test/deployments/sentinel-auth/redis-master.conf",
    "test/deployments/sentinel-auth/redis-replica-6380.conf",
    "test/deployments/sentinel-auth/redis-replica-6381.conf",
    "test/deployments/sentinel-tls/compose.yml",
    "test/deployments/sentinel-tls/redis-master.conf",
    "test/deployments/sentinel-tls/redis-replica-16385.conf",
    "test/deployments/sentinel-tls/redis-replica-16386.conf",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(fixtureText, /127\.0\.0\.1:6379:6379/);
  assert.doesNotMatch(fixtureText, /^port 6379$/m);
  assert.match(fixtureText, /BULLMQ_SINGLE_NOAUTH_PORT:-16379/);
  assert.match(fixtureText, /BULLMQ_SINGLE_AUTH_PORT:-16380/);
});

test("Docker runner keeps AWS MemoryDB optional and environment-only", () => {
  const runner = read("scripts/run-deployment-tests.js");

  for (const name of [
    "single-noauth",
    "single-auth",
    "single-tls",
    "cluster-auth",
    "cluster-tls",
    "sentinel-auth",
    "sentinel-tls",
    "postgres-plain",
    "postgres-tls",
  ]) {
    assert.match(runner, new RegExp(name));
  }

  assert.match(runner, /MEMORYDB_ENABLED/);
  assert.match(runner, /BULLMQ_BACKEND/);
  assert.match(runner, /deployment\.build \? \["--build"\]/);
  assert.match(runner, /MEMORYDB_ENDPOINT/);
  assert.match(runner, /MEMORYDB_PASSWORD/);
  assert.doesNotMatch(runner, /clustercfg\.memdb\.bchgcd/);
});
