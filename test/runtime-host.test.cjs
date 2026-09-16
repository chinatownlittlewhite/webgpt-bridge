const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

function fakeChild(pid) {
  return { pid, exitCode: null, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, removeListener() {}, kill() {} };
}

function baseRuntimeHostOptions(overrides = {}) {
  return {
    settingsStore: { loadSettings: async () => ({ httpsProxy: "", designIssueJournal: false }) },
    startupPreflight: { prepare: async () => ({}) },
    hostBroker: { async start() {}, async stop() {}, getSocketPath: () => "/tmp/broker.sock" },
    appendLog() {},
    resetLogs() {},
    spawn: () => fakeChild(1),
    spawnSync: () => ({ status: 0 }),
    buildTrustedCommandPath: () => "/trusted/bin",
    resolveSystemProxyEnvironment: () => ({}),
    platform: "linux",
    env: {},
    createBrokerBootstrap: () => ({ protocolVersion: 1, sessionId: "session", secret: "secret" }),
    ...overrides,
  };
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

test("agent readiness ignores a stale Agent on the fixed port until the spawned process answers", async () => {
  const { createRuntimeHost } = require("../src/host/runtime-host.cjs");
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      name: "webgpt-bridge-core",
      pid: requests === 1 ? 111 : 222,
      workspace: "/workspace",
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const host = createRuntimeHost(baseRuntimeHostOptions({
      endpoints: { mcpHost: "127.0.0.1", mcpPort: port },
    }));
    const ready = await host.waitAgentReady(fakeChild(222), {
      runtime: { workspacePath: "/workspace" },
    });
    assert.equal(ready, true);
    assert.equal(requests, 2, "the stale PID response must not satisfy readiness");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("tunnel health uses poll progress instead of absolute last-success age", async () => {
  const { createRuntimeHost } = require("../src/host/runtime-host.cjs");
  let pollCycles = 40;
  let lastSuccess = Date.now() / 1000 - 600;
  let pollErrors = 2;
  let commandsPolled = 12;
  let responsesDelivered = 11;
  const server = http.createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end([
        `commands_poll_cycles_total ${pollCycles}`,
        `commands_poll_last_successful_timestamp_seconds ${lastSuccess}`,
        `commands_poll_errors_total ${pollErrors}`,
        `commands_polled_total ${commandsPolled}`,
        `http_client_request_body_size_bytes_count{http_request_method="POST",http_response_status_code="200",http_route="/v1/tunnels/tunnel_test/response"} ${responsesDelivered}`,
        "readiness 1",
        "",
      ].join("\n"));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const host = createRuntimeHost(baseRuntimeHostOptions());
    const tunnel = fakeChild(333);
    const preflight = { tunnelProfile: { healthBaseUrl: `http://127.0.0.1:${port}` } };

    assert.equal(await host.checkTunnelHealth(tunnel, preflight), true, "the first sample establishes a baseline even when the timestamp is old");
    assert.deepEqual(host.getTunnelHealthDiagnostics(tunnel), {
      code: "TUNNEL_PROGRESS_BASELINE",
      progressed: true,
      pollCycles: 40,
      pollCyclesDelta: 0,
      pollErrors: 2,
      pollErrorsDelta: 0,
      commandsPolled: 12,
      commandsPolledDelta: 0,
      responsesDelivered: 11,
      responsesDeliveredDelta: 0,
    });

    pollCycles += 1;
    commandsPolled += 1;
    responsesDelivered += 1;
    assert.equal(await host.checkTunnelHealth(tunnel, preflight), true, "an advancing poll cycle proves control-plane progress");
    assert.deepEqual(host.getTunnelHealthDiagnostics(tunnel), {
      code: "TUNNEL_PROGRESS_OK",
      progressed: true,
      pollCycles: 41,
      pollCyclesDelta: 1,
      pollErrors: 2,
      pollErrorsDelta: 0,
      commandsPolled: 13,
      commandsPolledDelta: 1,
      responsesDelivered: 12,
      responsesDeliveredDelta: 1,
    });

    assert.equal(await host.checkTunnelHealth(tunnel, preflight), false, "a later sample with no poll progress is a health miss");
    assert.equal(host.getTunnelHealthDiagnostics(tunnel).code, "TUNNEL_PROGRESS_STALLED");
    assert.equal(host.getTunnelHealthDiagnostics(tunnel).progressed, false);

    lastSuccess += 30;
    pollErrors += 1;
    assert.equal(await host.checkTunnelHealth(tunnel, preflight), true, "a newer successful-poll timestamp also proves progress");
    assert.equal(host.getTunnelHealthDiagnostics(tunnel).code, "TUNNEL_PROGRESS_OK");
    assert.equal(host.getTunnelHealthDiagnostics(tunnel).pollErrorsDelta, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
