const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const productionFiles = [
  "bull-queue.js",
  "lib/commands.js",
  "lib/connections.js",
  "lib/scheduler.js",
  "lib/serialization.js",
];

test("production Node.js code uses async/await instead of direct promise construction or chaining", () => {
  for (const file of productionFiles) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(
      source,
      /\bnew\s+Promise\b/,
      `${file} constructs a Promise`,
    );
    assert.doesNotMatch(
      source,
      /\bPromise\.(?!all\b|race\b)/,
      `${file} calls a Promise combinator other than all/race`,
    );
    assert.doesNotMatch(source, /\.then\s*\(/, `${file} chains .then()`);
    assert.doesNotMatch(source, /\.catch\s*\(/, `${file} chains .catch()`);
  }
});
