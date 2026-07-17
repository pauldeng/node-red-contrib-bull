"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const repoRoot = path.join(__dirname, "..", "..");
const userDir = path.join(os.tmpdir(), "node-red-contrib-bullmq-playwright");
const nodeModulesDir = path.join(userDir, "node_modules");
const packageLink = path.join(
  nodeModulesDir,
  "@pauldeng",
  "node-red-contrib-bullmq",
);
const settingsPath = path.join(userDir, "settings.js");

fs.rmSync(userDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(packageLink), { recursive: true });
fs.symlinkSync(repoRoot, packageLink, "dir");
fs.writeFileSync(path.join(userDir, "flows.json"), "[]\n");
fs.writeFileSync(
  settingsPath,
  `module.exports = {
  uiPort: 18889,
  userDir: ${JSON.stringify(userDir)},
  flowFile: "flows.json",
  credentialSecret: false,
  editorTheme: {
    tours: false,
    projects: { enabled: false }
  },
  telemetry: { enabled: false },
  logging: {
    console: { level: "error" }
  }
};\n`,
);

const nodeRedBin = path.join(repoRoot, "node_modules", "node-red", "red.js");
const child = spawn(
  process.execPath,
  [nodeRedBin, "--userDir", userDir, "--settings", settingsPath, "-p", "18889"],
  {
    stdio: "inherit",
    cwd: repoRoot,
  },
);

function stop() {
  child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
