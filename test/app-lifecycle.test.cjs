const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppLifecycleCoordinator } = require("../src/app-lifecycle.cjs");

function beforeQuitEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test("ordinary quit waits for supervisor shutdown exactly once", async () => {
  let shutdowns = 0;
  let quits = 0;
  const app = { quit() { quits += 1; } };
  const coordinator = createAppLifecycleCoordinator({
    app,
    supervisor: { shutdown: async () => { shutdowns += 1; } },
    disposeHostServices: async () => {},
  });

  const first = beforeQuitEvent();
  coordinator.handleBeforeQuit(first);
  await coordinator.whenSettled();

  assert.equal(first.prevented, true);
  assert.equal(shutdowns, 1);
  assert.equal(quits, 1);
  assert.equal(coordinator.nativeQuitAllowed(), true);
});

test("native re-entry after awaited shutdown passes through without a second teardown", async () => {
  let shutdowns = 0;
  let disposals = 0;
  const app = { quit() {} };
  const coordinator = createAppLifecycleCoordinator({
    app,
    supervisor: { shutdown: async () => { shutdowns += 1; } },
    disposeHostServices: async () => { disposals += 1; },
  });

  const first = beforeQuitEvent();
  coordinator.handleBeforeQuit(first);
  await coordinator.whenSettled();
  const second = beforeQuitEvent();
  coordinator.handleBeforeQuit(second);

  assert.equal(first.prevented, true);
  assert.equal(second.prevented, false);
  assert.equal(shutdowns, 1);
  assert.equal(disposals, 1);
});

test("ordinary quit bounds an unresolved shutdown and records SHUTDOWN_INCOMPLETE before native quit", async () => {
  let timeoutCallback;
  let quits = 0;
  const coordinator = createAppLifecycleCoordinator({
    app: { quit() { quits += 1; } },
    supervisor: { shutdown: () => new Promise(() => {}) },
    disposeHostServices: async () => {},
    shutdownTimeoutMs: 20_000,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });

  const event = beforeQuitEvent();
  coordinator.handleBeforeQuit(event);
  await Promise.resolve();
  assert.equal(typeof timeoutCallback, "function", "coordinator must arm a bounded shutdown timeout");
  timeoutCallback();

  const failure = await coordinator.whenSettled().then(() => null, (error) => error);
  assert.equal(event.prevented, true);
  assert.equal(failure?.code, "SHUTDOWN_INCOMPLETE");
  assert.equal(coordinator.nativeQuitAllowed(), true);
  assert.equal(quits, 1);
});

test("update install refuses a timed-out shutdown and never opens the native quit gate", async () => {
  let timeoutCallback;
  let quits = 0;
  const coordinator = createAppLifecycleCoordinator({
    app: { quit() { quits += 1; } },
    supervisor: { shutdown: () => new Promise(() => {}) },
    disposeHostServices: async () => {},
    shutdownTimeoutMs: 20_000,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });

  const pending = coordinator.prepareForUpdateInstall();
  await Promise.resolve();
  assert.equal(typeof timeoutCallback, "function", "update preparation must use the same bounded shutdown gate");
  timeoutCallback();

  await assert.rejects(pending, (error) => error?.code === "SHUTDOWN_TIMEOUT");
  assert.equal(coordinator.nativeQuitAllowed(), false);
  assert.equal(quits, 0);
});
