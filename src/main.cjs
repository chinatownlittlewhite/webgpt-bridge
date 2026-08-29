const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveDevelopmentRuntimeConfig } = require("./dev-runtime-config.cjs");
const { establishSingleInstanceOwnership } = require("./single-instance.cjs");
const { createBrokerBootstrap, createBrokerChallenge, verifyBrokerProof } = require("../shared/local-broker-protocol.cjs");
const { normalizeSettings } = require("./host-config.cjs");
const { approvalPrompt } = require("./approval-prompt.cjs");
const { createApprovalSession } = require("./approval-session.cjs");
const { classifyHostCommandApproval, classifyLocalAction, classifyLocalPath, normalizeApprovalMode } = require("./local-policy.cjs");
const { createLocalFileBroker } = require("./local-file-broker.cjs");
const { createHostCapabilityStore } = require("./host-capability-store.cjs");
const { createKnownFolderAccess } = require("./known-folder-access.cjs");
const { createLoopbackHealthProbe, defaultTcpProbe } = require("./loopback-health-probe.cjs");
const { createLocalTerminalBroker } = require("./local-terminal-broker.cjs");
const { validateSshCommand } = require("./ssh-policy.cjs");
const { resolveSystemProxyEnvironment } = require("./system-proxy.cjs");
const { resolveDesktopGitHubCli } = require("./github-cli-path.cjs");
const { buildTrustedCommandPath } = require("./host-path.cjs");
const { bundledTunnelClientPath } = require("./tunnel-client-path.cjs");
const { ensureTunnelProfile } = require("./tunnel-profile-manager.cjs");
const { createStartupPreflight } = require("./startup-preflight.cjs");
const { createAppLifecycleCoordinator } = require("./app-lifecycle.cjs");
const { createRuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { createUpdateService } = require("./update-service.cjs");
const { trayIconDataUrl } = require("./tray-icon.cjs");
const { autoUpdater } = require("electron-updater");
const packageMetadata = require("../package.json");

// Keep v0.1 settings and encrypted runtime keys when the product name changes
// from Local Agent Host to WebGPT Bridge. Development smoke runs may override
// this path and the fixed loopback ports, but packaged builds ignore those envs.
const desktopRuntimeConfig = resolveDevelopmentRuntimeConfig({
  isPackaged: app.isPackaged,
  env: process.env,
  defaultUserDataPath: path.join(app.getPath("appData"), "local-agent-host"),
});
app.setPath("userData", desktopRuntimeConfig.userDataPath);
const singleInstanceOwnership = establishSingleInstanceOwnership({
  app,
  activatePrimary: () => {
    void app.whenReady().then(() => setImmediate(showWindow));
  },
});

const MCP_HOST = "127.0.0.1";
const MCP_PORT = desktopRuntimeConfig.mcpPort;
const TUNNEL_HEALTH_HOST = "127.0.0.1";
const TUNNEL_HEALTH_PORT = desktopRuntimeConfig.tunnelHealthPort;
const TUNNEL_HEALTH_LISTEN_ADDR = `${TUNNEL_HEALTH_HOST}:${TUNNEL_HEALTH_PORT}`;
const MAX_LOG_LINES = 600;

let windowRef;
let trayRef;
let serverProcess;
let tunnelProcess;
let localBrokerServer;
let localBrokerSocket = "";
let localFileBroker;
let localCapabilityStore;
let localKnownFolderAccess;
let localHealthProbe;
let localTerminalBroker;
let localApprovalMode = "development";
const approvalSession = createApprovalSession();
let logLines = [];
let updateService;
let runtimeSupervisor;
let appLifecycle;

function configPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function secretPath() {
  return path.join(app.getPath("userData"), "runtime-key.bin");
}

function bundledRuntimePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "agent-runtime")
    : path.join(__dirname, "..", "agent-runtime");
}

function defaultBundledTunnelClientPath() {
  return bundledTunnelClientPath({
    resourcesPath: app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "build"),
    platform: process.platform,
  });
}

function defaultBundledNodePath() {
  if (process.platform !== "win32") return "";
  const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "build");
  return path.join(resourcesRoot, "node-runtime", "node.exe");
}

function loadBundledNodeManifest() {
  const nodePath = defaultBundledNodePath();
  if (!nodePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(path.dirname(nodePath), "BUNDLED_SOURCE.json"), "utf8"));
    const version = String(parsed?.version || "").trim();
    const nodeSha256 = String(parsed?.nodeSha256 || "").trim().toLowerCase();
    if (!version || !/^[a-f0-9]{64}$/.test(nodeSha256)) return null;
    return Object.freeze({ path: nodePath, version, nodeSha256 });
  } catch {
    return null;
  }
}

function defaultSettings() {
  return {
    workspacePath: "",
    runtimePath: bundledRuntimePath(),
    agentMode: "bundled",
    developmentPath: "",
    tunnelClientPath: "",
    nodePath: "",
    tunnelId: "",
    profile: "webgpt-bridge",
    httpsProxy: "",
    sshEnabled: false,
    sshAllowedHosts: [],
    approvalMode: "development",
    designIssueJournal: false,
  };
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath(), "utf8"));
    const settings = normalizeSettings(parsed, defaultSettings());
    return { ...settings, runtimePath: settings.runtimePath || bundledRuntimePath(), hasRuntimeKey: fs.existsSync(secretPath()) };
  } catch {
    return { ...defaultSettings(), hasRuntimeKey: fs.existsSync(secretPath()) };
  }
}

async function writeSettings(input) {
  const settings = { ...normalizeSettings(input, defaultSettings()), runtimePath: input.runtimePath || bundledRuntimePath() };
  delete settings.runtimeKey;
  delete settings.hasRuntimeKey;
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

async function saveRuntimeKey(key) {
  if (typeof key !== "string" || key.length < 16) throw new Error("运行时密钥为空或格式不正确。");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用；不会将密钥保存为明文。");
  }
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  await fsp.writeFile(secretPath(), safeStorage.encryptString(key).toString("base64"), { mode: 0o600 });
}

async function migrateLegacyMacKey() {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "openai-tunnel-client", "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const legacyKey = result.status === 0 ? result.stdout.trim() : "";
  if (!legacyKey) return "";
  await saveRuntimeKey(legacyKey);
  return legacyKey;
}

async function readRuntimeKey() {
  if (fs.existsSync(secretPath())) {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取运行时密钥。");
      const encrypted = Buffer.from(await fsp.readFile(secretPath(), "utf8"), "base64");
      return safeStorage.decryptString(encrypted);
    } catch {
      // The app was renamed after v0.1. Fall back to the legacy Keychain item
      // and immediately re-encrypt it using this app's safeStorage identity.
      const migrated = await migrateLegacyMacKey();
      if (migrated) return migrated;
      throw new Error("无法读取已保存的运行时密钥。请在高级设置中重新保存此电脑的密钥。");
    }
  }
  return migrateLegacyMacKey();
}

const startupPreflight = createStartupPreflight({
  bundledTunnelClientPath: () => defaultBundledTunnelClientPath(),
  bundledNodeManifest: () => loadBundledNodeManifest(),
  ensureTunnelProfile,
  tunnelProfileDir: () => path.join(app.getPath("userData"), "tunnel-profiles"),
  mcpServerUrl: () => `http://${MCP_HOST}:${MCP_PORT}/mcp`,
  tunnelHealthListenAddr: () => TUNNEL_HEALTH_LISTEN_ADDR,
  readRuntimeKey: () => readRuntimeKey(),
  appToolsBin: () => path.join(app.getPath("userData"), "tools", "bin"),
  resolveDesktopGitHubCli,
});

function emit(type, value) {
  windowRef?.webContents.send("host:event", { type, value });
  if (type === "status") updateTray();
}

function appendLog(source, data) {
  for (const line of String(data).split(/\r?\n/)) {
    if (!line) continue;
    logLines.push({ source, line, at: new Date().toISOString() });
  }
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
  emit("logs", logLines);
}

function processIsLive(child) {
  return Boolean(child && child.exitCode === null);
}

function nvmNodeCandidates() {
  const versions = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    return fs.readdirSync(versions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versions, entry.name, "bin", process.platform === "win32" ? "node.exe" : "node"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

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
    const req = http.get({ host: MCP_HOST, port: MCP_PORT, path: "/healthz", timeout: 1500 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : ""));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const health = await requestHealth();
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("本地 Agent 服务未在 15 秒内通过健康检查。请查看日志。");
}

function getStatus() {
  const status = runtimeSupervisor?.getStatus() || {
    state: "stopped",
    connected: false,
    server: false,
    tunnel: false,
    localBroker: false,
    agentHealth: "unknown",
    tunnelReadiness: "unknown",
    transitionId: 0,
    lastExitReason: null,
    phaseTimings: Object.freeze({}),
  };
  return {
    ...status,
    healthUrl: `http://${MCP_HOST}:${MCP_PORT}/healthz`,
    tunnelAdminUrl: `http://${TUNNEL_HEALTH_HOST}:${TUNNEL_HEALTH_PORT}/ui`,
  };
}

function dialogOwner() {
  return windowRef && !windowRef.isDestroyed() ? windowRef : undefined;
}


async function confirmHostCommandApproval(params) {
  const request = params?.request;
  if (!request || typeof request !== "object" || !Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((value) => typeof value !== "string" || !value || value.includes("\0"))) {
    throw new Error("Agent 审批请求格式无效。");
  }
  if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Agent 审批请求缺少工作目录。");
  const authorization = classifyHostCommandApproval(request, localApprovalMode);
  if (authorization.decision === "deny") {
    appendLog("local-broker", `Agent 命令审批：已拒绝（${authorization.reason}）`);
    return { approved: false };
  }
  if (authorization.decision === "allow") {
    appendLog("local-broker", `Agent 命令审批：自动批准（${authorization.reason}）`);
    return { approved: true };
  }
  const approved = await confirmLocalOperation({
    kind: "terminal-command",
    argv: request.argv,
    cwd: request.cwd,
    policy: { ...request.policy, reason: authorization.reason || request.policy?.reason },
    rememberKey: authorization.rememberKey,
  });
  appendLog("local-broker", `Agent 命令审批：${approved ? "已批准" : "已取消"}`);
  return { approved };
}

async function confirmLocalOperation(request) {
  const explicitConsent = request?.kind === "sensitive-access" || request?.kind === "known-folder-access" || request?.kind === "host-path-access";
  if (!explicitConsent && localApprovalMode === "full_control") {
    appendLog("local-broker", "完全控制模式：自动批准本机权限请求");
    return true;
  }
  const prompt = approvalPrompt(request, localApprovalMode);
  if (approvalSession.isRemembered(prompt)) {
    appendLog("local-broker", `已按本次连接记忆自动批准：${prompt.message}`);
    return true;
  }
  const options = {
    type: "warning",
    buttons: ["取消", "允许"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "WebGPT Bridge · 权限请求",
    message: prompt.message,
    detail: prompt.detail,
  };
  const owner = dialogOwner();
  const response = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  const approved = response.response === 1;
  approvalSession.record(prompt, { approved });
  return approved;
}

function localBrokerSocketPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\webgpt-bridge-${process.pid}`;
  return path.join(app.getPath("temp"), `webgpt-bridge-${process.pid}.sock`);
}

async function stopLocalBroker() {
  approvalSession.clear();
  const server = localBrokerServer;
  const socketPath = localBrokerSocket;
  localBrokerServer = undefined;
  localBrokerSocket = "";
  localCapabilityStore?.clear();
  localCapabilityStore = undefined;
  localFileBroker = undefined;
  localKnownFolderAccess = undefined;
  localHealthProbe = undefined;
  localTerminalBroker = undefined;
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (socketPath && process.platform !== "win32") await fsp.rm(socketPath, { force: true }).catch(() => {});
}

function localBrokerDispatch(method, params, executionContext = {}) {
  const handlers = {
    local_list: () => localFileBroker.list(params),
    local_read: () => localFileBroker.read(params),
    local_list_known_folder: () => localKnownFolderAccess.list(params),
    local_read_known_folder: () => localKnownFolderAccess.read(params),
    local_probe_health: () => localHealthProbe.probe(params),
    local_request_sensitive_access: () => localFileBroker.requestSensitiveAccess(params),
    local_request_host_access: () => localFileBroker.requestHostAccess(params),
    local_stage_changes: () => localFileBroker.stage(params),
    local_confirm_batch: () => localFileBroker.confirmBatch(params),
    local_run_command: () => localTerminalBroker.run(params, executionContext),
    host_approve_command: () => confirmHostCommandApproval(params),
  };
  if (!Object.hasOwn(handlers, method)) throw new Error("未知的本机代理方法。");
  return handlers[method]();
}

function attachLocalBrokerConnection(socket, brokerBootstrap) {
  let buffered = "";
  let handshakeState = "awaiting_hello";
  let hello = null;
  let challengeNonce = "";
  const activeRequests = new Set();

  function rejectHandshake(code) {
    const safeCode = code === "BROKER_PROTOCOL_MISMATCH" ? code : "BROKER_AUTH_FAILED";
    appendLog("local-broker", `broker-handshake: ${safeCode}`);
    if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "hello_error", code: safeCode })}\n`);
    handshakeState = "failed";
    hello = null;
    challengeNonce = "";
  }

  socket.setEncoding("utf8");
  socket.on("close", () => {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    hello = null;
    challengeNonce = "";
  });
  socket.on("data", (chunk) => {
    buffered += chunk;
    if (buffered.length > 1024 * 1024) return socket.destroy();
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim() || handshakeState === "failed") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        if (handshakeState !== "ready") rejectHandshake("BROKER_AUTH_FAILED");
        else if (!socket.destroyed) socket.write(`${JSON.stringify({ id: null, ok: false, error: "本机代理请求格式无效。" })}\n`);
        continue;
      }

      if (handshakeState === "awaiting_hello") {
        if (!message || message.type !== "hello") {
          rejectHandshake("BROKER_AUTH_FAILED");
          continue;
        }
        const challenge = createBrokerChallenge(message, brokerBootstrap);
        if (challenge.type === "hello_error") {
          rejectHandshake(challenge.code);
          continue;
        }
        hello = Object.freeze({
          protocolVersion: message.protocolVersion,
          sessionId: message.sessionId,
          agentVersion: message.agentVersion,
        });
        challengeNonce = challenge.nonce;
        handshakeState = "awaiting_proof";
        socket.write(`${JSON.stringify(challenge)}\n`);
        continue;
      }

      if (handshakeState === "awaiting_proof") {
        if (!message || message.type !== "authenticate" || !hello || message.protocolVersion !== hello.protocolVersion || message.sessionId !== hello.sessionId || message.agentVersion !== hello.agentVersion || message.nonce !== challengeNonce) {
          rejectHandshake("BROKER_AUTH_FAILED");
          continue;
        }
        const verification = verifyBrokerProof(message, brokerBootstrap, { expectedNonce: challengeNonce });
        if (!verification.ok) {
          rejectHandshake(verification.code);
          continue;
        }
        handshakeState = "ready";
        hello = null;
        challengeNonce = "";
        appendLog("local-broker", "broker-handshake: accepted");
        socket.write(`${JSON.stringify({ type: "hello_ok" })}\n`);
        continue;
      }

      if (handshakeState !== "ready") continue;
      void (async () => {
        try {
          if (!message || typeof message !== "object" || typeof message.method !== "string" || !message.params || typeof message.params !== "object") throw new Error("本机代理请求格式无效。");
          const controller = new AbortController();
          activeRequests.add(controller);
          try {
            const result = await localBrokerDispatch(message.method, message.params, { signal: controller.signal });
            if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
          } finally {
            activeRequests.delete(controller);
          }
        } catch (error) {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message?.id, ok: false, error: error.message || "本机代理请求失败。" })}\n`);
        }
      })();
    }
  });
}

async function startLocalBroker(settings, runtime, { githubCliPath = "", proxyEnv = {}, brokerBootstrap } = {}) {
  await stopLocalBroker();
  localApprovalMode = normalizeApprovalMode(settings.approvalMode);
  const knownFolderRoots = {
    desktop: app.getPath("desktop"),
    downloads: app.getPath("downloads"),
    documents: app.getPath("documents"),
  };
  const policyOptions = {
    appDataRoots: [app.getPath("userData")],
    workspaceRoot: settings.workspacePath,
    knownFolderRoots,
  };
  const pathPolicy = (target, options) => classifyLocalPath(target, { ...policyOptions, ...options, approvalMode: settings.approvalMode });
  const actionPolicy = (action) => classifyLocalAction({ ...action, approvalMode: settings.approvalMode });
  const policyModule = await import(pathToFileURL(path.join(runtime.runtimePath, "dist", "policy.js")).href);
  localCapabilityStore = createHostCapabilityStore({ generation: crypto.randomUUID(), policyVersion: "v0.5-phase1" });
  localFileBroker = createLocalFileBroker({
    workspaceRoot: settings.workspacePath,
    capabilityStore: localCapabilityStore,
    policy: pathPolicy,
    actionPolicy,
    confirm: confirmLocalOperation,
    audit: (entry) => appendLog("local-broker", `${entry.action}：${entry.result}`),
  });
  localKnownFolderAccess = createKnownFolderAccess({
    roots: knownFolderRoots,
    fileBroker: localFileBroker,
    issueCapability: async (request) => {
      const classified = pathPolicy(request.path, { operation: request.operation });
      if (classified.scope === "system" || classified.scope === "sensitive") {
        throw new Error(classified.reason || "该 known-folder 目标不能通过普通目录授权访问。");
      }
      if (!await confirmLocalOperation({ kind: "known-folder-access", ...request })) {
        throw new Error("known-folder 访问未获得用户授权。");
      }
      const grant = localCapabilityStore.issue({
        root: classified.path || request.path,
        operations: [request.operation],
        ttlMs: 5 * 60_000,
        maxUses: 100,
        className: `known-folder-${request.operation}`,
      });
      return { accessId: grant.accessId };
    },
  });
  localHealthProbe = createLoopbackHealthProbe({
    targets: {
      agent: { kind: "http", host: MCP_HOST, port: MCP_PORT, path: "/healthz" },
      tunnel: { kind: "http", host: TUNNEL_HEALTH_HOST, port: TUNNEL_HEALTH_PORT, path: "/readyz" },
    },
    githubProbe: async () => {
      const connectivity = await defaultTcpProbe({ host: "github.com", port: 443 });
      if (!githubCliPath) {
        return { ok: false, connectivity: connectivity.ok === true, binaryReady: false, authenticated: false };
      }
      const auth = spawnSync(githubCliPath, ["auth", "status"], {
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
      });
      const authenticated = !auth.error && auth.status === 0;
      return {
        ok: connectivity.ok === true && authenticated,
        connectivity: connectivity.ok === true,
        binaryReady: true,
        authenticated,
      };
    },
  });
  const sshExecutable = settings.sshEnabled && process.platform !== "win32" ? "/usr/bin/ssh" : "";
  const trustedExecutables = {
    ...(githubCliPath ? { gh: githubCliPath } : {}),
    ...(sshExecutable ? { ssh: sshExecutable } : {}),
  };
  localTerminalBroker = createLocalTerminalBroker({
    approvalMode: settings.approvalMode,
    classifyCommand: policyModule.classifyCommand,
    confirm: confirmLocalOperation,
    pathPolicy,
    trustedExecutables,
    networkEnv: proxyEnv,
    sshPolicy: sshExecutable ? (argv) => validateSshCommand(argv, { allowedHosts: settings.sshAllowedHosts }) : undefined,
  });
  localBrokerSocket = localBrokerSocketPath();
  if (process.platform !== "win32") await fsp.rm(localBrokerSocket, { force: true }).catch(() => {});
  if (!brokerBootstrap || typeof brokerBootstrap.secret !== "string" || !brokerBootstrap.secret) throw new Error("Local broker authentication bootstrap is required");
  localBrokerServer = net.createServer((socket) => attachLocalBrokerConnection(socket, brokerBootstrap));
  await new Promise((resolve, reject) => {
    localBrokerServer.once("error", reject);
    localBrokerServer.listen(localBrokerSocket, () => {
      localBrokerServer.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await fsp.chmod(localBrokerSocket, 0o600);
  appendLog("local-broker", "已启动受控本机文件与终端代理。");
  return localBrokerServer;
}

function trayIcon() {
  const image = nativeImage.createFromDataURL(trayIconDataUrl(process.platform));
  if (image.isEmpty()) throw new Error("无法创建系统托盘图标。");
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function dockIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="b" x1="180" y1="96" x2="850" y2="920"><stop stop-color="#26312e"/><stop offset="1" stop-color="#0d1211"/></linearGradient><linearGradient id="a" x1="322" y1="384" x2="712" y2="650"><stop stop-color="#cff9e9"/><stop offset="1" stop-color="#56d6ae"/></linearGradient></defs><rect width="1024" height="1024" rx="226" fill="url(#b)"/><path d="M282 596c0-88 71-159 159-159h64" fill="none" stroke="#f3f7f5" stroke-width="92" stroke-linecap="round"/><path d="M742 428c0 88-71 159-159 159h-64" fill="none" stroke="url(#a)" stroke-width="92" stroke-linecap="round"/><circle cx="282" cy="596" r="62" fill="#f3f7f5"/><circle cx="742" cy="428" r="62" fill="#56d6ae"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function showWindow() {
  if (!windowRef || windowRef.isDestroyed()) createWindow();
  windowRef.show();
  windowRef.focus();
}

function updateTray() {
  if (!trayRef) return;
  const status = getStatus();
  const connected = status.connected;
  const update = updateService?.getState();
  const updateItem = update?.status === "downloaded"
    ? { label: `更新已下载 · v${update.availableVersion}`, enabled: false }
    : update?.status === "available"
      ? { label: `发现更新 · v${update.availableVersion}`, enabled: false }
      : null;
  trayRef.setToolTip(`WebGPT Bridge · ${connected ? "已连接" : "未连接"}`);
  trayRef.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? "已连接到 ChatGPT" : "未连接", enabled: false },
    ...(updateItem ? [updateItem] : []),
    { type: "separator" },
    { label: "显示控制器", click: showWindow },
    {
      label: "启动连接",
      enabled: !connected,
      click: () => runtimeSupervisor.start().catch((error) => appendLog("host", `启动失败：${error.message}`)),
    },
    { label: "停止服务", enabled: status.server || status.tunnel, click: () => { void runtimeSupervisor.stop("tray"); } },
    { type: "separator" },
    {
      label: "退出 WebGPT Bridge",
      click: () => {
        void appLifecycle.requestQuit("tray-quit").catch((error) => appendLog("host", `${error.code || "SHUTDOWN_FAILED"}：${error.message}`));
      },
    },
  ]));
}

function createTray() {
  trayRef = new Tray(trayIcon());
  trayRef.on("click", showWindow);
  updateTray();
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
  if (process.platform === "win32" && child.pid) {
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

async function prepareRuntime() {
  const settings = await loadSettings();
  const preflight = await startupPreflight.prepare({
    settings,
    env: process.env,
    platform: process.platform,
    nvmCandidates: nvmNodeCandidates(),
  });
  const proxyEnv = resolveSystemProxyEnvironment({
    explicitProxy: settings.httpsProxy,
    platform: process.platform,
    spawnSync,
  });
  logLines = [];
  emit("logs", logLines);
  appendLog(
    "host",
    preflight.githubCliPath
      ? `GitHub CLI：${preflight.githubCliPath}`
      : "未检测到 GitHub CLI；GitHub 工具会返回可修复诊断，其他本地工具不受影响。",
  );
  const brokerBootstrap = createBrokerBootstrap();
  return { ...preflight, proxyEnv, brokerBootstrap };
}

async function startRuntimeBroker(preflight) {
  return startLocalBroker(preflight.settings, preflight.runtime, {
    githubCliPath: preflight.githubCliPath,
    proxyEnv: preflight.proxyEnv,
    brokerBootstrap: preflight.brokerBootstrap,
  });
}

async function startRuntimeAgent(preflight) {
  const { settings, node, runtime, appToolsBin, githubCliPath } = preflight;
  const baseEnv = {
    ...process.env,
    PATH: buildTrustedCommandPath({
      nodePath: node,
      additionalPaths: [
        appToolsBin,
        ...(githubCliPath ? [path.dirname(githubCliPath)] : []),
      ],
    }),
    LPC_WORKSPACE: runtime.workspacePath,
    LPC_HOST: MCP_HOST,
    LPC_PORT: String(MCP_PORT),
    LPC_VERIFY_SANDBOX: "true",
    LPC_ENABLE_NETWORK_TOOLS: "true",
    LPC_LOCAL_BROKER_SOCKET: localBrokerSocket,
    LPC_LOCAL_BROKER_PROTOCOL: String(preflight.brokerBootstrap.protocolVersion),
    LPC_LOCAL_BROKER_SESSION: preflight.brokerBootstrap.sessionId,
    LPC_LOCAL_BROKER_SECRET: preflight.brokerBootstrap.secret,
    LPC_GITHUB_CLI_PATH: githubCliPath,
    LPC_DESIGN_ISSUE_JOURNAL: settings.designIssueJournal === true ? "true" : "false",
  };
  serverProcess = spawnLogged(node, [path.join(runtime.runtimePath, "dist", "server.js")], { env: baseEnv, cwd: runtime.runtimePath }, "agent");
  return serverProcess;
}

async function waitRuntimeAgentReady() {
  await waitForHealth();
  return true;
}

async function startRuntimeTunnel(preflight) {
  const { tunnelClient, tunnelProfile, runtimeKey, proxyEnv = {} } = preflight;
  const tunnelEnv = {
    ...process.env,
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

async function waitRuntimeTunnelReady(tunnel, preflight) {
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

async function stopRuntimeResource(resource, { kind }) {
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
  if (kind === "broker") {
    await stopLocalBroker();
  }
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 560,
    minHeight: 540,
    backgroundColor: "#edf1ef",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  windowRef.webContents.on("will-navigate", (event) => event.preventDefault());
  windowRef.on("close", (event) => {
    if (appLifecycle.nativeQuitAllowed()) return;
    event.preventDefault();
    windowRef.hide();
  });
  windowRef.on("closed", () => { windowRef = undefined; });
  windowRef.loadFile(path.join(__dirname, "renderer", "index.html"));
}

if (singleInstanceOwnership.primary) {
  app.whenReady().then(() => {
    runtimeSupervisor = createRuntimeSupervisor({
      prepare: prepareRuntime,
      startBroker: startRuntimeBroker,
      startAgent: startRuntimeAgent,
      waitAgentReady: waitRuntimeAgentReady,
      startTunnel: startRuntimeTunnel,
      waitTunnelReady: waitRuntimeTunnelReady,
      stopResource: stopRuntimeResource,
    });
    runtimeSupervisor.subscribe(() => emit("status", getStatus()));
    appLifecycle = createAppLifecycleCoordinator({
      app,
      supervisor: runtimeSupervisor,
      disposeHostServices: async () => {
        singleInstanceOwnership.dispose();
        updateService?.dispose();
      },
    });

    if (process.platform === "darwin" && app.dock) app.dock.setIcon(dockIcon());
    updateService = createUpdateService({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      prepareForInstall: () => appLifecycle.prepareForUpdateInstall(),
      emitState: (state) => {
        windowRef?.webContents?.send("update:state", state);
        updateTray();
      },
      log: (line) => appendLog("update", line),
    });
    // The host has no browser-facing permissions. Tunnel traffic is handled by
    // the separate client process, not by renderer pages.
    const { session } = require("electron");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle("settings:load", loadSettings);
    ipcMain.handle("settings:save", async (_event, payload) => {
      if (!payload || typeof payload !== "object") throw new Error("设置格式无效。");
      if (typeof payload.runtimeKey === "string" && payload.runtimeKey.trim()) await saveRuntimeKey(payload.runtimeKey.trim());
      return { ...(await writeSettings(payload)), hasRuntimeKey: fs.existsSync(secretPath()) };
    });
    ipcMain.handle("settings:clear-key", async () => { await fsp.rm(secretPath(), { force: true }); return { hasRuntimeKey: false }; });
    ipcMain.handle("dialog:directory", async () => (await dialog.showOpenDialog(windowRef, { properties: ["openDirectory"] })).filePaths[0] || "");
    ipcMain.handle("dialog:file", async () => (await dialog.showOpenDialog(windowRef, { properties: ["openFile"] })).filePaths[0] || "");
    ipcMain.handle("host:start", () => runtimeSupervisor.start());
    ipcMain.handle("host:stop", () => runtimeSupervisor.stop("ipc"));
    ipcMain.handle("host:status", () => getStatus());
    ipcMain.handle("host:logs", () => logLines);
    ipcMain.handle("chatgpt:open", () => shell.openExternal("https://chatgpt.com/"));
    ipcMain.handle("update:get-state", () => updateService.getState());
    ipcMain.handle("update:check", () => updateService.checkForUpdates());
    ipcMain.handle("update:download", () => updateService.downloadUpdate());
    ipcMain.handle("update:install", () => updateService.installUpdateAndRestart());
    createTray();
    showWindow();
    if (packageMetadata.WEBGPT_UPDATE_E2E_BUILD === true) {
      const { runUpdateE2EControl } = require("./update-e2e-control.cjs");
      void runUpdateE2EControl({ packageMeta: packageMetadata, updateService, app }).catch((error) => {
        appendLog("update-e2e", error?.stack || error?.message || String(error));
        setTimeout(() => app.exit(1), 250);
      });
    } else {
      updateService.start();
    }
    app.on("activate", showWindow);
    app.on("before-quit", (event) => {
      const nativeAllowed = appLifecycle.nativeQuitAllowed();
      appLifecycle.handleBeforeQuit(event);
      if (!nativeAllowed) {
        void appLifecycle.whenSettled().catch((error) => appendLog("host", `${error.code || "SHUTDOWN_FAILED"}：${error.message}`));
      }
    });
  });
}
