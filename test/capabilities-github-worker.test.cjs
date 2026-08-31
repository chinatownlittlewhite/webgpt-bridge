const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const service = fs.readFileSync(path.join(root, "src", "host", "diagnostics-service.cjs"), "utf8");
const workerPath = path.join(root, "src", "host", "capabilities-github-worker.cjs");

test("GitHub health probe is isolated behind worker_threads", () => {
  assert.match(service, /worker_threads/);
  assert.match(service, /new Worker\(/);
  assert.match(service, /capabilities-github-worker\.cjs/);
});

test("worker performs the blocking probe and returns only structured state", () => {
  assert.equal(fs.existsSync(workerPath), true, "GitHub health worker must exist");
  const worker = fs.readFileSync(workerPath, "utf8");
  assert.match(worker, /parentPort/);
  assert.match(worker, /probeGithubSync/);
  assert.match(worker, /postMessage/);
  assert.doesNotMatch(worker, /stderr|stdout|token|credential|secret/i);
});
