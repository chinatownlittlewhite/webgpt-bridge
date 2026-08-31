const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { probeGithubHealth } = require("../src/host/diagnostics-service.cjs");

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminateCalls = 0;
  }

  terminate() {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

test("GitHub health times out without blocking the Host event loop", async () => {
  const worker = new FakeWorker();
  const started = Date.now();
  const health = await probeGithubHealth({
    workerTimeoutMs: 25,
    workerFactory: () => worker,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 250, `health probe blocked for ${elapsed}ms`);
  assert.notEqual(health.status, "ready");
  assert.equal(health.code, "UPSTREAM_ERROR");
  assert.equal(worker.terminateCalls, 1);
});

test("GitHub worker result is classified into a bounded service value", async () => {
  const worker = new FakeWorker();
  queueMicrotask(() => worker.emit("message", {
    available: true,
    authenticated: false,
    upstreamOk: false,
    stderr: "token=secret should never cross the boundary",
  }));

  const health = await probeGithubHealth({
    workerTimeoutMs: 100,
    workerFactory: () => worker,
  });

  assert.equal(health.code, "NOT_AUTHENTICATED");
  assert.equal(health.status, "degraded");
  assert.equal(health.stderr, undefined);
  assert.equal(JSON.stringify(health).includes("secret"), false);
  assert.equal(worker.terminateCalls, 1);
});

test("invalid worker messages fail closed", async () => {
  const worker = new FakeWorker();
  queueMicrotask(() => worker.emit("message", { raw: "unexpected" }));
  const health = await probeGithubHealth({ workerTimeoutMs: 100, workerFactory: () => worker });
  assert.equal(health.code, "UPSTREAM_ERROR");
  assert.notEqual(health.status, "ready");
});
