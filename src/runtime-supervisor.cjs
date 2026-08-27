function createRuntimeSupervisor(deps, options = {}) {
  if (!deps || typeof deps !== "object") throw new TypeError("RuntimeSupervisor dependencies are required");
  const required = [
    "prepare",
    "startBroker",
    "startAgent",
    "waitAgentReady",
    "startTunnel",
    "waitTunnelReady",
    "stopResource",
  ];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new TypeError(`RuntimeSupervisor dependency ${name} must be a function`);
  }

  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const recoveryDelays = Object.freeze([...(options.recoveryDelays || [1000, 3000, 10000])]);

  let state = "stopped";
  let stateStartedAt = now();
  let transitionId = 0;
  let generation = 0;
  let startPromise = null;
  let stopPromise = null;
  let restartPromise = null;
  let shutdownPromise = null;
  let shuttingDown = false;
  let stopping = false;
  let preflight = null;
  let agentHealth = "unknown";
  let tunnelReadiness = "unknown";
  let lastExitReason = null;
  const phaseTimings = {};
  const ledger = [];
  const listeners = new Set();
  const expectedExits = new WeakSet();
  let backgroundActivity = Promise.resolve();

  function reasonFrom(error, fallbackCode) {
    if (!error) return Object.freeze({ code: fallbackCode });
    if (typeof error === "object") {
      return Object.freeze({
        code: error.code || fallbackCode,
        message: error.message || String(error),
      });
    }
    return Object.freeze({ code: fallbackCode, message: String(error) });
  }

  function getEntry(kind) {
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
      if (ledger[index].kind === kind) return ledger[index];
    }
    return null;
  }

  function removeEntry(entry) {
    const index = ledger.indexOf(entry);
    if (index >= 0) ledger.splice(index, 1);
  }

  function getStatus() {
    const broker = Boolean(getEntry("broker"));
    const agent = Boolean(getEntry("agent"));
    const tunnel = Boolean(getEntry("tunnel"));
    return Object.freeze({
      state,
      connected: state === "connected" && agentHealth === "ready" && tunnelReadiness === "ready",
      server: agent,
      tunnel,
      localBroker: broker,
      agentHealth,
      tunnelReadiness,
      transitionId,
      lastExitReason,
      phaseTimings: Object.freeze({ ...phaseTimings }),
    });
  }

  function publish() {
    const snapshot = getStatus();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers cannot break lifecycle ownership.
      }
    }
    return snapshot;
  }

  function transition(nextState, updates = {}) {
    const at = now();
    if (state !== "stopped") phaseTimings[state] = Math.max(0, at - stateStartedAt);
    state = nextState;
    stateStartedAt = at;
    if (Object.hasOwn(updates, "agentHealth")) agentHealth = updates.agentHealth;
    if (Object.hasOwn(updates, "tunnelReadiness")) tunnelReadiness = updates.tunnelReadiness;
    if (Object.hasOwn(updates, "lastExitReason")) lastExitReason = updates.lastExitReason;
    transitionId += 1;
    return publish();
  }

  function cancelledError() {
    return Object.assign(new Error("Runtime start was cancelled"), { code: "START_CANCELLED" });
  }

  function assertStartToken(token) {
    if (token !== generation || stopping || shuttingDown) throw cancelledError();
  }

  function attachChildExit(entry) {
    if (entry.kind !== "agent" && entry.kind !== "tunnel") return;
    const child = entry.value;
    if (!child || typeof child.once !== "function") return;
    child.once("exit", (code, signal) => {
      if (expectedExits.has(child)) return;
      backgroundActivity = backgroundActivity
        .then(() => handleUnexpectedExit(entry, code, signal))
        .catch((error) => {
          lastExitReason = reasonFrom(error, "RUNTIME_RECOVERY_FAILED");
          if (!stopping && !shuttingDown) transition("failed", { lastExitReason });
        });
    });
  }

  function acquire(kind, value) {
    const entry = { kind, value };
    ledger.push(entry);
    attachChildExit(entry);
    return entry;
  }

  async function releaseEntry(entry, reason) {
    if (!ledger.includes(entry)) return null;
    const value = entry.value;
    if (value && (typeof value === "object" || typeof value === "function")) expectedExits.add(value);
    let failure = null;
    try {
      await deps.stopResource(value, { kind: entry.kind, reason });
    } catch (error) {
      failure = error;
    } finally {
      removeEntry(entry);
    }
    return failure;
  }

  async function releaseAll(reason) {
    let firstFailure = null;
    for (const entry of [...ledger].reverse()) {
      const failure = await releaseEntry(entry, reason);
      if (!firstFailure && failure) firstFailure = failure;
    }
    return firstFailure;
  }

  async function runTunnelRecovery(token) {
    let lastError = null;
    for (const delayMs of recoveryDelays) {
      await sleep(delayMs);
      if (token !== generation || stopping || shuttingDown) return;
      transition("tunnel_starting", { tunnelReadiness: "starting" });
      let entry = null;
      try {
        const tunnelResource = await deps.startTunnel(preflight);
        entry = acquire("tunnel", tunnelResource);
        if (token !== generation || stopping || shuttingDown) {
          await releaseEntry(entry, "recovery-cancelled");
          return;
        }
        const ready = await deps.waitTunnelReady(tunnelResource, preflight);
        if (!ready) throw Object.assign(new Error("Tunnel readiness check failed"), { code: "TUNNEL_READY_TIMEOUT" });
        if (token !== generation || stopping || shuttingDown) {
          await releaseEntry(entry, "recovery-cancelled");
          return;
        }
        transition("connected", { tunnelReadiness: "ready" });
        return;
      } catch (error) {
        lastError = error;
        if (entry) await releaseEntry(entry, "recovery-failed");
        if (token !== generation || stopping || shuttingDown) return;
        transition("degraded", {
          tunnelReadiness: "failed",
          lastExitReason: reasonFrom(error, "TUNNEL_RECOVERY_FAILED"),
        });
      }
    }
    if (token === generation && !stopping && !shuttingDown) {
      lastExitReason = Object.freeze({
        code: "TUNNEL_RECOVERY_EXHAUSTED",
        message: lastError?.message || "Tunnel recovery budget exhausted",
      });
      transition("failed", { tunnelReadiness: "failed", lastExitReason });
    }
  }

  async function handleUnexpectedExit(entry, code, signal) {
    if (!ledger.includes(entry) || stopping || shuttingDown) return;
    removeEntry(entry);
    const exitReason = Object.freeze({
      code: entry.kind === "agent" ? "AGENT_EXITED" : "TUNNEL_EXITED",
      kind: entry.kind,
      exitCode: code ?? null,
      signal: signal ?? null,
    });
    lastExitReason = exitReason;

    if (entry.kind === "agent") {
      transition("degraded", {
        agentHealth: "failed",
        tunnelReadiness: getEntry("tunnel") ? "stopping" : tunnelReadiness,
        lastExitReason: exitReason,
      });
      const tunnelEntry = getEntry("tunnel");
      if (tunnelEntry) await releaseEntry(tunnelEntry, "agent-exited");
      tunnelReadiness = "failed";
      publish();
      return;
    }

    transition("degraded", {
      tunnelReadiness: "failed",
      lastExitReason: exitReason,
    });
    await runTunnelRecovery(generation);
  }

  function start() {
    if (shuttingDown || shutdownPromise) {
      return Promise.reject(Object.assign(new Error("App is shutting down"), { code: "APP_SHUTTING_DOWN" }));
    }
    if (startPromise) return startPromise;
    if (state === "connected") return Promise.resolve(getStatus());
    if (stopPromise) {
      startPromise = stopPromise.then(() => {
        startPromise = null;
        return start();
      });
      return startPromise;
    }

    const token = ++generation;
    startPromise = (async () => {
      transition("preparing", {
        agentHealth: "unknown",
        tunnelReadiness: "unknown",
        lastExitReason: null,
      });
      try {
        preflight = await deps.prepare({ cancelled: () => token !== generation || stopping || shuttingDown });
        assertStartToken(token);

        const brokerResource = await deps.startBroker(preflight);
        acquire("broker", brokerResource);
        assertStartToken(token);

        transition("agent_starting", { agentHealth: "starting" });
        const agentResource = await deps.startAgent(preflight);
        acquire("agent", agentResource);
        assertStartToken(token);

        const agentReady = await deps.waitAgentReady(agentResource, preflight);
        if (!agentReady) throw Object.assign(new Error("Agent readiness check failed"), { code: "AGENT_HEALTH_TIMEOUT" });
        assertStartToken(token);
        transition("agent_ready", { agentHealth: "ready" });

        transition("tunnel_starting", { tunnelReadiness: "starting" });
        const tunnelResource = await deps.startTunnel(preflight);
        acquire("tunnel", tunnelResource);
        assertStartToken(token);

        const tunnelReady = await deps.waitTunnelReady(tunnelResource, preflight);
        if (!tunnelReady) throw Object.assign(new Error("Tunnel readiness check failed"), { code: "TUNNEL_READY_TIMEOUT" });
        assertStartToken(token);

        return transition("connected", { tunnelReadiness: "ready" });
      } catch (error) {
        if (error?.code === "START_CANCELLED" || token !== generation || stopping || shuttingDown) {
          throw error?.code === "START_CANCELLED" ? error : cancelledError();
        }
        const failureReason = reasonFrom(error, "RUNTIME_START_FAILED");
        lastExitReason = failureReason;
        await releaseAll("start-failed");
        transition("failed", {
          agentHealth: getEntry("agent") ? agentHealth : "failed",
          tunnelReadiness: "failed",
          lastExitReason: failureReason,
        });
        throw error;
      }
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function stop(reason = "stop") {
    if (shutdownPromise) return shutdownPromise;
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      generation += 1;
      transition("stopping", {
        tunnelReadiness: getEntry("tunnel") ? "stopping" : tunnelReadiness,
      });
      const pendingStart = startPromise;
      if (pendingStart) {
        try {
          await pendingStart;
        } catch {
          // Cancellation/failure is reflected by the stop transaction.
        }
      }
      await backgroundActivity.catch(() => {});
      const failure = await releaseAll(reason);
      agentHealth = "unknown";
      tunnelReadiness = "unknown";
      preflight = null;
      stopping = false;
      const status = transition("stopped");
      if (failure) throw failure;
      return status;
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  function restart(reason = "restart") {
    if (shuttingDown || shutdownPromise) {
      return Promise.reject(Object.assign(new Error("App is shutting down"), { code: "APP_SHUTTING_DOWN" }));
    }
    if (restartPromise) return restartPromise;
    restartPromise = (async () => {
      await stop(reason);
      if (shuttingDown || shutdownPromise) {
        throw Object.assign(new Error("App is shutting down"), { code: "APP_SHUTTING_DOWN" });
      }
      return start();
    })().finally(() => {
      restartPromise = null;
    });
    return restartPromise;
  }

  function shutdown(reason = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      if (stopPromise) {
        try {
          await stopPromise;
        } catch {
          // A fresh terminal teardown below still owns the final result.
        }
      }
      stopping = true;
      generation += 1;
      transition("stopping", {
        tunnelReadiness: getEntry("tunnel") ? "stopping" : tunnelReadiness,
      });
      const pendingStart = startPromise;
      if (pendingStart) {
        try {
          await pendingStart;
        } catch {
          // Expected when shutdown cancels an in-flight start.
        }
      }
      await backgroundActivity.catch(() => {});
      const failure = await releaseAll(reason);
      agentHealth = "unknown";
      tunnelReadiness = "unknown";
      preflight = null;
      stopping = false;
      const status = transition("stopped");
      if (failure) throw failure;
      return status;
    })();
    return shutdownPromise;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("RuntimeSupervisor listener must be a function");
    listeners.add(listener);
    listener(getStatus());
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    start,
    stop,
    restart,
    shutdown,
    getStatus,
    subscribe,
  });
}

module.exports = { createRuntimeSupervisor };
