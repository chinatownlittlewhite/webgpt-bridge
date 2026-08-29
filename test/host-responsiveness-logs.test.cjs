const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("GitHub health never runs gh auth status synchronously on the Electron main thread", () => {
  const broker = read("src/host/broker-server.cjs");
  const main = read("src/main.cjs");

  assert.match(broker, /createGitHubHealthProbe/);
  assert.doesNotMatch(broker, /spawnSync\(githubCliPath\s*,\s*\[\s*["']auth["']\s*,\s*["']status["']\s*\]/);
  assert.doesNotMatch(main, /createHostBrokerServer\([\s\S]*?spawnSync[,\s}]/);
});

test("async GitHub health keeps connectivity binary readiness and authentication as distinct bounded facts", () => {
  const source = read("src/github-health-probe.cjs");

  assert.match(source, /execFile/);
  assert.match(source, /timeoutMs/);
  assert.match(source, /maxBuffer/);
  assert.match(source, /connectivity/);
  assert.match(source, /binaryReady/);
  assert.match(source, /authenticated/);
  assert.doesNotMatch(source, /spawnSync/);
});

test("Host logs use one bounded snapshot and monotonic append protocol instead of full-ring retransmission", () => {
  const main = read("src/main.cjs");
  const ipc = read("src/host/ipc-controller.cjs");

  assert.match(main, /createHostLogBuffer/);
  assert.doesNotMatch(main, /let\s+logLines\s*=\s*\[\]/);
  assert.doesNotMatch(main, /emit\(["']logs["']\s*,\s*logLines\s*\)/);
  assert.match(main, /\.subscribe\(.*?emit\(["']logs["']/s);
  assert.match(ipc, /host:logs/);
});
