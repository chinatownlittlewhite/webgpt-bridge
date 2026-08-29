const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

function api() {
  return require("../src/single-instance.cjs");
}

function fakeApp(lockResult) {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.requestSingleInstanceLock = () => lockResult;
  app.quit = () => { app.quitCalls += 1; };
  return app;
}

test("secondary instance quits without registering a primary owner", () => {
  const { establishSingleInstanceOwnership } = api();
  const app = fakeApp(false);
  const ownership = establishSingleInstanceOwnership({
    app,
    activatePrimary: () => assert.fail("secondary cannot activate itself"),
  });

  assert.equal(ownership.primary, false);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.listenerCount("second-instance"), 0);
  ownership.dispose();
});

test("primary instance activates existing UI on second-instance and dispose removes the listener", () => {
  const { establishSingleInstanceOwnership } = api();
  const app = fakeApp(true);
  let activations = 0;
  const ownership = establishSingleInstanceOwnership({
    app,
    activatePrimary: () => { activations += 1; },
  });

  assert.equal(ownership.primary, true);
  assert.equal(app.quitCalls, 0);
  assert.equal(app.listenerCount("second-instance"), 1);
  app.emit("second-instance");
  assert.equal(activations, 1);

  ownership.dispose();
  assert.equal(app.listenerCount("second-instance"), 0);
  app.emit("second-instance");
  assert.equal(activations, 1);
});
