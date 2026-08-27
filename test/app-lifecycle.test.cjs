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
