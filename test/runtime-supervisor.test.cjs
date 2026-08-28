const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { createRuntimeSupervisor } = require("../src/runtime-supervisor.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(turns = 12) {
  for (let index = 0; index < turns; index += 1) await new Promise(setImmediate);
}

function resource(kind, pid) {
  const value = new EventEmitter();
  value.kind = kind;
  value.pid = pid;
  return value;
}

function baseDeps(overrides = {}) {
  return {
    prepare: async () => Object.freeze({ token: "preflight" }),
    startBroker: async () => resource("broker"),
    startAgent: async () => resource("agent", 1),
    waitAgentReady: async () => true,
    startTunnel: async () => resource("tunnel", 2),
    waitTunnelReady: async () => true,
    stopResource: async () => {},
    sleep: async () => {},
    ...overrides,
  };
}

test("duplicate start returns one promise and connected requires both readiness gates", async () => {
  const agentGate = deferred();
  const tunnelGate = deferred();
  let prepares = 0;
  const supervisor = createRuntimeSupervisor(baseDeps({
    prepare: async () => { prepares += 1; return {}; },
    waitAgentReady: () => agentGate.promise,
    waitTunnelReady: () => tunnelGate.promise,
  }));

  const first = supervisor.start();
  const second = supervisor.start();
  assert.equal(first, second);
  assert.equal(supervisor.getStatus().state, "preparing");
  await new Promise(setImmediate);
  assert.equal(supervisor.getStatus().state, "agent_starting");
  assert.equal(supervisor.getStatus().connected, false);

  agentGate.resolve(true);
  await new Promise(setImmediate);
  assert.equal(supervisor.getStatus().state, "tunnel_starting");
  assert.equal(supervisor.getStatus().connected, false);

  tunnelGate.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(prepares, 1);
  assert.equal(a.state, "connected");
  assert.equal(b.connected, true);
  assert.equal(a.agentHealth, "ready");
  assert.equal(a.tunnelReadiness, "ready");
});

test("stop during preparing cancels before broker acquisition", async () => {
  const gate = deferred();
  let brokers = 0;
  const supervisor = createRuntimeSupervisor(baseDeps({
    prepare: () => gate.promise,
    startBroker: async () => { brokers += 1; return resource("broker"); },
  }));

  const started = supervisor.start();
  const stopped = supervisor.stop("user");
  gate.resolve({});
  await assert.rejects(started, (error) => error?.code === "START_CANCELLED");
  const status = await stopped;
  assert.equal(brokers, 0);
  assert.equal(status.state, "stopped");
});

test("failed start rolls back only acquired resources in reverse order", async () => {
  const stopped = [];
  const supervisor = createRuntimeSupervisor(baseDeps({
    waitTunnelReady: async () => { throw Object.assign(new Error("not ready"), { code: "TUNNEL_READY_TIMEOUT" }); },
    stopResource: async (_resource, meta) => stopped.push(meta.kind),
  }));

  await assert.rejects(supervisor.start(), /not ready/);
  assert.deepEqual(stopped, ["tunnel", "agent", "broker"]);
  assert.equal(supervisor.getStatus().state, "failed");
  assert.equal(supervisor.getStatus().lastExitReason.code, "TUNNEL_READY_TIMEOUT");
});

test("stop tears down tunnel agent broker and preserves compatibility booleans as derived fields", async () => {
  const stopped = [];
  const supervisor = createRuntimeSupervisor(baseDeps({
    stopResource: async (_resource, meta) => stopped.push(meta.kind),
  }));
  await supervisor.start();
  const live = supervisor.getStatus();
  assert.equal(live.server, true);
  assert.equal(live.tunnel, true);
  assert.equal(live.localBroker, true);

  const status = await supervisor.stop("user");
  assert.deepEqual(stopped, ["tunnel", "agent", "broker"]);
  assert.equal(status.state, "stopped");
  assert.equal(status.server, false);
  assert.equal(status.tunnel, false);
  assert.equal(status.localBroker, false);
});

test("shutdown is terminal and blocks new start or restart", async () => {
  let starts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps({
    startAgent: async () => { starts += 1; return resource("agent", 1); },
  }));
  await supervisor.start();
  const first = supervisor.shutdown("quit");
  const second = supervisor.shutdown("quit");
  assert.equal(first, second);
  await first;
  await assert.rejects(() => supervisor.start(), (error) => error?.code === "APP_SHUTTING_DOWN");
  await assert.rejects(() => supervisor.restart("ui"), (error) => error?.code === "APP_SHUTTING_DOWN");
  assert.equal(starts, 1);
});

test("stop plus quit shares one teardown and makes shutdown terminal", async () => {
  const tunnelReleaseStarted = deferred();
  const releaseGate = deferred();
  const stopped = [];
  const supervisor = createRuntimeSupervisor(baseDeps({
    stopResource: async (_resource, meta) => {
      stopped.push(meta.kind);
      if (meta.kind === "tunnel") {
        tunnelReleaseStarted.resolve();
        await releaseGate.promise;
      }
    },
  }));
  await supervisor.start();

  const stopping = supervisor.stop("user");
  await tunnelReleaseStarted.promise;
  const shuttingDown = supervisor.shutdown("quit");
  releaseGate.resolve();
  await Promise.all([stopping, shuttingDown]);

  assert.deepEqual(stopped, ["tunnel", "agent", "broker"]);
  assert.equal(supervisor.getStatus().state, "stopped");
  await assert.rejects(() => supervisor.start(), (error) => error?.code === "APP_SHUTTING_DOWN");
});

test("restart plus quit cancels reacquisition and ends in terminal shutdown", async () => {
  const tunnelReleaseStarted = deferred();
  const releaseGate = deferred();
  let agentStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps({
    startAgent: async () => {
      agentStarts += 1;
      return resource("agent", agentStarts);
    },
    stopResource: async (_resource, meta) => {
      if (meta.kind === "tunnel") {
        tunnelReleaseStarted.resolve();
        await releaseGate.promise;
      }
    },
  }));
  await supervisor.start();

  const restarting = supervisor.restart("ui");
  await tunnelReleaseStarted.promise;
  const shuttingDown = supervisor.shutdown("quit");
  releaseGate.resolve();

  await assert.rejects(restarting, (error) => error?.code === "APP_SHUTTING_DOWN");
  await shuttingDown;
  assert.equal(agentStarts, 1, "restart must not acquire a second agent after quit intent");
  assert.equal(supervisor.getStatus().state, "stopped");
  await assert.rejects(() => supervisor.start(), (error) => error?.code === "APP_SHUTTING_DOWN");
});

test("unexpected agent exit immediately leaves connected and tears down dependent tunnel", async () => {
  const stopped = [];
  const agent = resource("agent", 1);
  const tunnel = resource("tunnel", 2);
  const supervisor = createRuntimeSupervisor(baseDeps({
    startAgent: async () => agent,
    startTunnel: async () => tunnel,
    stopResource: async (_resource, meta) => stopped.push(meta.kind),
  }));
  await supervisor.start();

  agent.emit("exit", 17, null);
  await settle();
  const status = supervisor.getStatus();
  assert.notEqual(status.state, "connected");
  assert.equal(status.connected, false);
  assert.equal(status.agentHealth, "failed");
  assert.deepEqual(stopped, ["tunnel"]);
  assert.equal(status.server, false);
  assert.equal(status.tunnel, false);
  assert.equal(status.localBroker, true);
});

test("unexpected tunnel exit uses bounded recovery budget and then fails", async () => {
  const sleeps = [];
  let starts = 0;
  const first = resource("tunnel", 2);
  const supervisor = createRuntimeSupervisor(baseDeps({
    startTunnel: async () => {
      starts += 1;
      if (starts === 1) return first;
      throw Object.assign(new Error("no tunnel"), { code: "TUNNEL_START_FAILED" });
    },
    sleep: async (ms) => sleeps.push(ms),
  }), { recoveryDelays: [1000, 3000, 10000] });
  await supervisor.start();

  first.emit("exit", 1, null);
  await settle();
  assert.equal(starts, 4);
  assert.deepEqual(sleeps, [1000, 3000, 10000]);
  assert.equal(supervisor.getStatus().state, "failed");
  assert.equal(supervisor.getStatus().connected, false);
  assert.equal(supervisor.getStatus().lastExitReason.code, "TUNNEL_RECOVERY_EXHAUSTED");
});

test("expected child exits during stop do not trigger recovery", async () => {
  const tunnel = resource("tunnel", 2);
  let tunnelStarts = 0;
  const supervisor = createRuntimeSupervisor(baseDeps({
    startTunnel: async () => { tunnelStarts += 1; return tunnel; },
    stopResource: async (value) => { if (value.emit) value.emit("exit", 0, null); },
  }), { recoveryDelays: [0] });
  await supervisor.start();
  await supervisor.stop("user");
  await settle();
  assert.equal(tunnelStarts, 1);
  assert.equal(supervisor.getStatus().state, "stopped");
});

test("subscribe snapshots include monotonic transition id and phase timings", async () => {
  let current = 10;
  const seen = [];
  const supervisor = createRuntimeSupervisor(baseDeps({ now: () => ++current }));
  const unsubscribe = supervisor.subscribe((status) => seen.push(status));
  await supervisor.start();
  unsubscribe();

  assert.ok(seen.length >= 5);
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index].transitionId > seen[index - 1].transitionId);
  }
  const status = supervisor.getStatus();
  assert.equal(typeof status.phaseTimings.preparing, "number");
  assert.equal(typeof status.phaseTimings.agent_starting, "number");
  assert.equal(typeof status.phaseTimings.tunnel_starting, "number");
  assert.equal(Object.isFrozen(status), true);
});

test("desktop host delegates start stop status and tray lifecycle authority to RuntimeSupervisor", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(source, /createRuntimeSupervisor/);
  assert.match(source, /runtimeSupervisor\s*=\s*createRuntimeSupervisor/);
  assert.doesNotMatch(source, /async function startAll\s*\(/);
  assert.doesNotMatch(source, /async function stopAll\s*\(/);

  const startHandler = source.match(/ipcMain\.handle\("host:start",([\s\S]*?)\);/)?.[1] || "";
  const stopHandler = source.match(/ipcMain\.handle\("host:stop",([\s\S]*?)\);/)?.[1] || "";
  const statusHandler = source.match(/ipcMain\.handle\("host:status",([\s\S]*?)\);/)?.[1] || "";
  assert.match(startHandler, /runtimeSupervisor\.start/);
  assert.match(stopHandler, /runtimeSupervisor\.stop/);
  assert.match(statusHandler, /runtimeSupervisor|getStatus/);

  const trayBlock = source.match(/function updateTray\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(trayBlock, /runtimeSupervisor\.start/);
  assert.match(trayBlock, /runtimeSupervisor\.stop/);
});
