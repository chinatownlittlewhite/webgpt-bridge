const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createRuntimeHost } = require("../src/host/runtime-host.cjs");

function baseOptions(overrides = {}) {
  return {
    settingsStore: { loadSettings: async () => ({ httpsProxy: "", designIssueJournal: false }) },
    startupPreflight: { prepare: async () => ({}) },
    hostBroker: { async start() {}, async stop() {}, getSocketPath: () => "/tmp/broker.sock" },
    appendLog() {},
    resetLogs() {},
    spawn: () => ({ pid: 1, exitCode: null, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, removeListener() {}, kill() {} }),
    spawnSync: () => ({ status: 0 }),
    buildTrustedCommandPath: () => "/trusted/bin",
    resolveSystemProxyEnvironment: () => ({}),
    platform: "linux",
    env: {},
    createBrokerBootstrap: () => ({ protocolVersion: 1, sessionId: "session", secret: "secret" }),
    ...overrides,
  };
}

function fakeChild(pid, exitCode = null) {
  return { pid, exitCode };
}

test("RuntimeHost one-shot Agent health probe validates live process PID and workspace", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: 222, workspace: "/workspace" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const host = createRuntimeHost(baseOptions({
      endpoints: { mcpHost: "127.0.0.1", mcpPort: server.address().port },
    }));
    assert.equal(typeof host.checkAgentHealth, "function");

    const preflight = { runtime: { workspacePath: "/workspace" } };
    assert.equal(await host.checkAgentHealth(fakeChild(222), preflight), true);
    assert.equal(await host.checkAgentHealth(fakeChild(333), preflight), false, "wrong PID must fail health");
    assert.equal(await host.checkAgentHealth(fakeChild(222), { runtime: { workspacePath: "/other" } }), false, "wrong workspace must fail health");

    const beforeExitedProbe = requests;
    assert.equal(await host.checkAgentHealth(fakeChild(222, 0), preflight), false, "exited process must fail without probing the port");
    assert.equal(requests, beforeExitedProbe);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
