const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createBrokerBootstrap: defaultCreateBrokerBootstrap } = require("../../shared/local-broker-protocol.cjs");
const { resolveSystemProxyEnvironment: defaultResolveSystemProxyEnvironment } = require("../system-proxy.cjs");
const { buildTrustedCommandPath: defaultBuildTrustedCommandPath } = require("../host-path.cjs");

function createRuntimeHost({
  settingsStore,
  startupPreflight,
  hostBroker,
  appendLog = () => {},
  resetLogs = () => {},
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  buildTrustedCommandPath = defaultBuildTrustedCommandPath,
  resolveSystemProxyEnvironment = defaultResolveSystemProxyEnvironment,
  endpoints = {},
  platform = process.platform,
  env = process.env,
  createBrokerBootstrap = defaultCreateBrokerBootstrap,
  nvmCandidates,
} = {}) {
  if (!settingsStore || typeof settingsStore.loadSettings !== "function") throw new TypeError("settingsStore is required");
  if (!startupPreflight || typeof startupPreflight.prepare !== "function") throw new TypeError("startupPreflight is required");
  if (!hostBroker || typeof hostBroker.start !== "function" || typeof hostBroker.stop !== "function" || typeof hostBroker.getSocketPath !== "function") {
    throw new TypeError("hostBroker is required");
  }

  const mcpHost = endpoints.mcpHost || "127.0.0.1";
  const mcpPort = endpoints.mcpPort;
  let serverProcess;
  let tunnelProcess;

  function processIsLive(child) {
    return Boolean(child && child.exitCode === null);
  }

  function defaultNvmCandidates() {
    const versions = path.join(os.homedir(), ".nvm", "versions", "node");
    try {
      return fs.readdirSync(versions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(versions, entry.name, "bin", platform === "win32" ? "node.exe" : "node"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  const resolveNvmCandidates = typeof nvmCandidates === "function" ? nvmCandidates : defaultNvmCandidates;

  function spawnLogged(command, args, options, label) {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
    child.stdout?.on("data", (chunk) => appendLog(label, chunk));
    child.stderr?.on("data", (chunk) => appendLog(label, chunk));
    child.on("error", (error) => appendLog(label, `启动失败：${error.message}`));
    child.on("exit", (code, signal) => {
      appendLog(label, `进程已退出（code=${code ?? "null"}, signal=${signal ?? "none"}）`);
    });
    return child;
  }

  function requestHealth() {
    return new Promise((resolve) => {
      const req = http.get({ host: mcpHost, port: mcpPort, path: "/healthz", timeout: 1500 }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : ""));
      });
      req.on("error", () => resolve(""));
      req.on("timeout", () => { req.destroy(); resolve(""); });
    });
  }

  function parseHealth(body) {
    if (!body) return null;
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizedWorkspace(value) {
    if (typeof value !== "string" || value.length === 0) return "";
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  async function waitAgentReady(agent, preflight) {
    const expectedWorkspace = normalizedWorkspace(preflight?.runtime?.workspacePath);
    const expectedPid = agent?.pid;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!processIsLive(agent)) return false;
      const health = parseHealth(await requestHealth());
      if (!processIsLive(agent)) return false;
      if (
        health?.ok === true
        && Number.isInteger(health.pid)
        && health.pid === expectedPid
        && normalizedWorkspace(health.workspace) === expectedWorkspace
      ) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("本地 Agent 服务未在 15 秒内通过健康检查。请查看日志。");
  }

  function waitForChildExit(child, timeoutMs = 5000) {
    if (!processIsLive(child)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };
      const onExit = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`进程在 ${timeoutMs}ms 内未退出。`));
      }, timeoutMs);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  async function stopChild(child, name) {
    if (!processIsLive(child)) return;
    appendLog("host", `正在停止 ${name}…`);
    if (platform === "win32" && child.pid) {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      if (result.status !== 0 && processIsLive(child)) throw new Error(`${name} 无法停止。`);
      return;
    }
    try {
      const gracefulExit = waitForChildExit(child, 5000);
      child.kill("SIGTERM");
      await gracefulExit;
    } catch {
      if (processIsLive(child)) {
        const forcedExit = waitForChildExit(child, 2000);
        child.kill("SIGKILL");
        await forcedExit;
      }
    }
  }

  async function prepare() {
    const settings = await settingsStore.loadSettings();
    const preflight = await startupPreflight.prepare({
      settings,
      env,
      platform,
      nvmCandidates: resolveNvmCandidates(),
    });
    const proxyEnv = resolveSystemProxyEnvironment({
      explicitProxy: settings.httpsProxy,
      platform,
      spawnSync,
    });
    resetLogs();
    appendLog(
      "host",
      preflight.githubCliPath
        ? `GitHub CLI：${preflight.githubCliPath}`
        : "未检测到 GitHub CLI；GitHub 工具会返回可修复诊断，其他本地工具不受影响。",
    );
    const brokerBootstrap = createBrokerBootstrap();
    return { ...preflight, proxyEnv, brokerBootstrap };
  }

  async function startBroker(preflight) {
    return hostBroker.start(preflight.settings, preflight.runtime, {
      githubCliPath: preflight.githubCliPath,
      proxyEnv: preflight.proxyEnv,
      brokerBootstrap: preflight.brokerBootstrap,
    });
  }

  async function startAgent(preflight) {
    const { settings, node, runtime, appToolsBin, githubCliPath } = preflight;
    const baseEnv = {
      ...env,
      PATH: buildTrustedCommandPath({
        nodePath: node,
        additionalPaths: [
          appToolsBin,
          ...(githubCliPath ? [path.dirname(githubCliPath)] : []),
        ],
      }),
      LPC_WORKSPACE: runtime.workspacePath,
      LPC_HOST: mcpHost,
      LPC_PORT: String(mcpPort),
      LPC_VERIFY_SANDBOX: "true",
      LPC_ENABLE_NETWORK_TOOLS: "true",
      LPC_LOCAL_BROKER_SOCKET: hostBroker.getSocketPath(),
      LPC_LOCAL_BROKER_PROTOCOL: String(preflight.brokerBootstrap.protocolVersion),
      LPC_LOCAL_BROKER_SESSION: preflight.brokerBootstrap.sessionId,
      LPC_LOCAL_BROKER_SECRET: preflight.brokerBootstrap.secret,
      LPC_GITHUB_CLI_PATH: githubCliPath,
      LPC_DESIGN_ISSUE_JOURNAL: settings.designIssueJournal === true ? "true" : "false",
    };
    serverProcess = spawnLogged(node, [path.join(runtime.runtimePath, "dist", "server.js")], { env: baseEnv, cwd: runtime.runtimePath }, "agent");
    return serverProcess;
  }

  async function startTunnel(preflight) {
    const { tunnelClient, tunnelProfile, runtimeKey, proxyEnv = {} } = preflight;
    const tunnelEnv = {
      ...env,
      ...proxyEnv,
      CONTROL_PLANE_API_KEY: runtimeKey,
    };
    tunnelProcess = spawnLogged(
      tunnelClient,
      ["run", "--profile", tunnelProfile.profile, "--profile-dir", tunnelProfile.profileDir],
      { env: tunnelEnv },
      "tunnel",
    );
    return tunnelProcess;
  }

  async function waitTunnelReady(tunnel, preflight) {
    const healthUrl = new URL(preflight.tunnelProfile.healthBaseUrl);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!processIsLive(tunnel)) return false;
      const ready = await new Promise((resolve) => {
        const req = http.get({
          host: healthUrl.hostname,
          port: healthUrl.port,
          path: "/readyz",
          timeout: 1500,
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode === 200));
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  async function stopResource(resource, { kind }) {
    if (kind === "tunnel") {
      await stopChild(resource, "隧道客户端");
      if (tunnelProcess === resource) tunnelProcess = undefined;
      return;
    }
    if (kind === "agent") {
      await stopChild(resource, "Agent 服务");
      if (serverProcess === resource) serverProcess = undefined;
      return;
    }
    if (kind === "broker") await hostBroker.stop();
  }

  return Object.freeze({ prepare, startBroker, startAgent, waitAgentReady, startTunnel, waitTunnelReady, stopResource });
}

module.exports = { createRuntimeHost };
