const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function fakeChild(pid) {
  return { pid, exitCode: null, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, removeListener() {}, kill() {} };
}

test("runtime host projects only trusted broker bootstrap and starts processes without a shell", async () => {
  const calls = [];
  const brokerCalls = [];
  const broker = {
    async start(...args) { brokerCalls.push(["start", ...args]); return { broker: true }; },
    async stop() { brokerCalls.push(["stop"]); },
    getSocketPath() { return "/tmp/broker.sock"; },
  };
  let nextPid = 100;
  const spawn = (command, argv, options) => { calls.push({ command, argv, options }); return fakeChild(++nextPid); };
  const { createRuntimeHost } = require("../src/host/runtime-host.cjs");
  const host = createRuntimeHost({
    settingsStore: { loadSettings: async () => ({ httpsProxy: "", designIssueJournal: true }) },
    startupPreflight: { prepare: async () => ({}) },
    hostBroker: broker,
    appendLog() {}, resetLogs() {}, spawn,
    spawnSync: () => ({ status: 0 }),
    buildTrustedCommandPath: () => "/trusted/bin",
    resolveSystemProxyEnvironment: () => ({ HTTPS_PROXY: "http://proxy" }),
    endpoints: { mcpHost: "127.0.0.1", mcpPort: 8787 },
    platform: "linux",
    env: { HOME: "/home/test", UNTRUSTED: "kept-for-process-env" },
    createBrokerBootstrap: () => ({ protocolVersion: 1, sessionId: "session-1", secret: "secret-1" }),
  });
  const preflight = {
    settings: { designIssueJournal: true },
    runtime: { runtimePath: "/runtime", workspacePath: "/workspace" },
    node: "/trusted/node",
    appToolsBin: "/trusted/tools",
    githubCliPath: "/trusted/gh",
    brokerBootstrap: { protocolVersion: 1, sessionId: "session-1", secret: "secret-1" },
    proxyEnv: { HTTPS_PROXY: "http://proxy" },
    tunnelClient: "/trusted/tunnel",
    tunnelProfile: { profile: "webgpt", profileDir: "/profiles", healthBaseUrl: "http://127.0.0.1:8080" },
    runtimeKey: "runtime-secret",
  };
  await host.startBroker(preflight);
  assert.equal(brokerCalls[0][1], preflight.settings);
  assert.equal(brokerCalls[0][3].brokerBootstrap.secret, "secret-1");

  const agent = await host.startAgent(preflight);
  assert.equal(agent.pid, 101);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PATH, "/trusted/bin");
  assert.equal(calls[0].options.env.LPC_LOCAL_BROKER_SOCKET, "/tmp/broker.sock");
  assert.equal(calls[0].options.env.LPC_LOCAL_BROKER_PROTOCOL, "1");
  assert.equal(calls[0].options.env.LPC_LOCAL_BROKER_SESSION, "session-1");
  assert.equal(calls[0].options.env.LPC_LOCAL_BROKER_SECRET, "secret-1");
  assert.equal(calls[0].options.env.LPC_DESIGN_ISSUE_JOURNAL, "true");
  assert.equal(calls[0].argv[0], path.join("/runtime", "dist", "server.js"));

  const tunnel = await host.startTunnel(preflight);
  assert.equal(tunnel.pid, 102);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env.HTTPS_PROXY, "http://proxy");
  assert.equal(calls[1].options.env.CONTROL_PLANE_API_KEY, "runtime-secret");

  await host.stopResource({ broker: true }, { kind: "broker" });
  assert.deepEqual(brokerCalls.at(-1), ["stop"]);
});

test("runtime host prepare owns settings, preflight, proxy projection, and fresh broker bootstrap", async () => {
  const calls = [];
  const { createRuntimeHost } = require("../src/host/runtime-host.cjs");
  const settings = { httpsProxy: "http://explicit", approvalMode: "development" };
  const host = createRuntimeHost({
    settingsStore: { loadSettings: async () => settings },
    startupPreflight: { prepare: async (input) => { calls.push(["preflight", input]); return { settings, runtime: { runtimePath: "/runtime" }, githubCliPath: "" }; } },
    hostBroker: { start() {}, stop() {}, getSocketPath: () => "/tmp/broker.sock" },
    appendLog: (source, line) => calls.push([source, line]),
    resetLogs: () => calls.push(["reset"]),
    spawn: () => fakeChild(1), spawnSync: () => ({ status: 0 }),
    buildTrustedCommandPath: () => "", resolveSystemProxyEnvironment: (input) => { calls.push(["proxy", input]); return { HTTPS_PROXY: "http://resolved" }; },
    endpoints: { mcpHost: "127.0.0.1", mcpPort: 8787 }, platform: "linux", env: { TEST: "1" },
    createBrokerBootstrap: () => ({ protocolVersion: 1, sessionId: "fresh", secret: "fresh-secret" }),
    nvmCandidates: () => ["/nvm/node"],
  });
  const prepared = await host.prepare();
  assert.equal(prepared.proxyEnv.HTTPS_PROXY, "http://resolved");
  assert.equal(prepared.brokerBootstrap.sessionId, "fresh");
  assert.deepEqual(calls[0], ["preflight", { settings, env: { TEST: "1" }, platform: "linux", nvmCandidates: ["/nvm/node"] }]);
  assert.equal(calls[1][0], "proxy");
  assert.deepEqual(calls[2], ["reset"]);
});
