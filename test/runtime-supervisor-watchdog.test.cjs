const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRuntimeSupervisor } = require("../src/runtime-supervisor.cjs");

async function settle(turns = 16) {
  for (let index = 0; index < turns; index += 1) await new Promise(setImmediate);
}

function resource(kind, pid) {
  const value = new EventEmitter();
  value.kind = kind;
  value.pid = pid;
  return value;
}

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingDelays() {
      return [...timers.values()].map((timer) => timer.ms);
    },
    async runNext() {
      const first = timers.entries().next();
      assert.equal(first.done, false, "expected a pending watchdog timer");
      const [id, timer] = first.value;
      timers.delete(id);
      timer.fn();
      await settle();
    },
  };
}

function baseDeps(timers, overrides = {}) {
  return {
    prepare: async () => Object.freeze({ runtime: { workspacePath: "/workspace" } }),
    startBroker: async () => resource("broker"),
    startAgent: async () => resource("agent", 1),
    waitAgentReady: async () => true,
    checkAgentHealth: async () => true,
    startTunnel: async () => resource("tunnel", 2),
    waitTunnelReady: async () => true,
    stopResource: async () => {},
    sleep: async () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides,
  };
}

function watchdogOptions(overrides = {}) {
  return {
    healthCheckIntervalMs: 30_000,
    healthFailureThreshold: 2,
    recoveryDelays: [0],
    ...overrides,
  };
}

test("connected watchdog tolerates one failed Agent health check before recovery", async () => {
  const timers = fakeTimers();
  let checks = 0;
  let agentStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps(timers, {
    startAgent: async () => resource("agent", ++agentStarts),
    checkAgentHealth: async () => { checks += 1; return false; },
  }), watchdogOptions());

  await supervisor.start();
  assert.deepEqual(timers.pendingDelays(), [30_000]);
  await timers.runNext();

  assert.equal(checks, 1);
  assert.equal(agentStarts, 1, "one transient health failure must not restart Agent");
  assert.equal(supervisor.getStatus().connected, true);
  assert.deepEqual(timers.pendingDelays(), [30_000], "watchdog must re-arm after the first failure");
});

test("two consecutive failed Agent health checks tear down dependents and use bounded recovery", async () => {
  const timers = fakeTimers();
  const stopped = [];
  const health = [false, false, true];
  let agentStarts = 0;
  let tunnelStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps(timers, {
    startAgent: async () => resource("agent", ++agentStarts),
    startTunnel: async () => resource("tunnel", ++tunnelStarts + 100),
    checkAgentHealth: async () => health.shift() ?? true,
    stopResource: async (_value, meta) => stopped.push(meta.kind),
  }), watchdogOptions());

  await supervisor.start();
  await timers.runNext();
  assert.equal(supervisor.getStatus().connected, true);
  await timers.runNext();

  assert.equal(agentStarts, 2);
  assert.equal(tunnelStarts, 2);
  assert.deepEqual(stopped.slice(0, 2), ["tunnel", "agent"]);
  assert.equal(supervisor.getStatus().state, "connected");
  assert.equal(supervisor.getStatus().connected, true);
  assert.equal(supervisor.getStatus().agentHealth, "ready");
  assert.equal(supervisor.getStatus().tunnelReadiness, "ready");
  assert.deepEqual(timers.pendingDelays(), [30_000], "recovered connection must arm a fresh watchdog");
});

test("a successful Agent health check resets the consecutive failure count", async () => {
  const timers = fakeTimers();
  const health = [false, true, false];
  let agentStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps(timers, {
    startAgent: async () => resource("agent", ++agentStarts),
    checkAgentHealth: async () => health.shift() ?? true,
  }), watchdogOptions());

  await supervisor.start();
  await timers.runNext();
  await timers.runNext();
  await timers.runNext();

  assert.equal(agentStarts, 1, "failure-success-failure is never two consecutive failures");
  assert.equal(supervisor.getStatus().connected, true);
  assert.deepEqual(timers.pendingDelays(), [30_000]);
});

test("stop cancels the connected watchdog and prevents later health recovery", async () => {
  const timers = fakeTimers();
  let checks = 0;
  let agentStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps(timers, {
    startAgent: async () => resource("agent", ++agentStarts),
    checkAgentHealth: async () => { checks += 1; return false; },
  }), watchdogOptions());

  await supervisor.start();
  assert.deepEqual(timers.pendingDelays(), [30_000]);
  await supervisor.stop("user");

  assert.deepEqual(timers.pendingDelays(), []);
  await settle();
  assert.equal(checks, 0);
  assert.equal(agentStarts, 1);
  assert.equal(supervisor.getStatus().state, "stopped");
});
