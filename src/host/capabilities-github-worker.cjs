const { parentPort, workerData } = require("node:worker_threads");
const { probeGithubSync } = require("./diagnostics-service.cjs");

if (!parentPort) {
  process.exitCode = 1;
} else {
  const requested = Number(workerData?.commandTimeoutMs);
  const commandTimeoutMs = Number.isFinite(requested) ? Math.max(100, Math.min(5000, requested)) : 1500;
  const state = probeGithubSync({ timeoutMs: commandTimeoutMs });
  parentPort.postMessage({
    available: state.available === true,
    authenticated: state.authenticated === true,
    upstreamOk: state.upstreamOk === true,
  });
}
