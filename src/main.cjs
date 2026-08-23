const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Keep v0.1 settings and encrypted runtime keys when the product name changes
// from Local Agent Host to WebGPT Bridge.
app.setPath("userData", path.join(app.getPath("appData"), "local-agent-host"));

const MCP_HOST = "127.0.0.1";
const MCP_PORT = 8787;
const MAX_LOG_LINES = 600;
const PROFILE_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

let windowRef;
let trayRef;
let serverProcess;
let tunnelProcess;
let logLines = [];
let isQuitting = false;

function configPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function secretPath() {
  return path.join(app.getPath("userData"), "runtime-key.bin");
}

function defaultSettings() {
  return {
    workspacePath: "",
    runtimePath: "",
    tunnelClientPath: "",
    nodePath: "",
    tunnelId: "",
    profile: "webgpt-bridge",
    httpsProxy: "",
  };
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath(), "utf8"));
    return { ...defaultSettings(), ...parsed, hasRuntimeKey: fs.existsSync(secretPath()) };
  } catch {
    return { ...defaultSettings(), hasRuntimeKey: fs.existsSync(secretPath()) };
  }
}

async function writeSettings(input) {
  const settings = { ...defaultSettings(), ...input };
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
  return Boolean(child && child.exitCode === null && !child.killed);
}

function commandExists(candidate) {
  if (!candidate) return false;
  if (candidate.includes(path.sep) || candidate.includes("/")) return fs.existsSync(candidate);
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore", shell: false, timeout: 4000 });
  return !result.error;
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

function preferredNode(settings) {
  const candidates = [
    settings.nodePath,
    process.env.LPC_NODE_PATH,
    process.platform === "darwin" ? "/opt/homebrew/bin/node" : "",
    process.platform === "darwin" ? "/usr/local/bin/node" : "",
    process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe") : "",
    ...nvmNodeCandidates(),
    "node",
  ];
  return candidates.find(commandExists) || "";
}

function assertDirectory(value, label) {
  if (!value || !path.isAbsolute(value) || !fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label}必须是存在的绝对目录。`);
  }
}

function validateSettings(settings) {
  assertDirectory(settings.workspacePath, "工作区");
  assertDirectory(settings.runtimePath, "Agent 运行时目录");
  if (!fs.existsSync(path.join(settings.runtimePath, "dist", "server.js"))) {
    throw new Error("Agent 运行时目录中未找到 dist/server.js；请先在该项目运行 npm install 和 npm run build。");
  }
  if (!settings.tunnelClientPath || !fs.statSync(settings.tunnelClientPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("请选择 OpenAI tunnel-client 可执行文件。");
  }
  if (!settings.tunnelId.startsWith("tunnel_")) throw new Error("Tunnel ID 应以 tunnel_ 开头。");
  if (!PROFILE_PATTERN.test(settings.profile)) throw new Error("配置名称只能包含字母、数字、点、下划线和连字符。");
  const node = preferredNode(settings);
  if (!node) throw new Error("未找到 Node.js。请安装 Node.js 20+，或在设置中选择 node 可执行文件。");
  return node;
}

function spawnLogged(command, args, options, label) {
  const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
  child.stdout?.on("data", (chunk) => appendLog(label, chunk));
  child.stderr?.on("data", (chunk) => appendLog(label, chunk));
  child.on("error", (error) => appendLog(label, `启动失败：${error.message}`));
  child.on("exit", (code, signal) => {
    appendLog(label, `进程已退出（code=${code ?? "null"}, signal=${signal ?? "none"}）`);
    emit("status", getStatus());
  });
  return child;
}

function onceExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`命令退出码：${code}`)));
  });
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
  return {
    server: processIsLive(serverProcess),
    tunnel: processIsLive(tunnelProcess),
    healthUrl: `http://${MCP_HOST}:${MCP_PORT}/healthz`,
    tunnelAdminUrl: "http://127.0.0.1:8080/ui",
  };
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="#000" d="M9 1.25a7.75 7.75 0 1 0 0 15.5A7.75 7.75 0 0 0 9 1.25Zm0 2a5.75 5.75 0 1 1 0 11.5A5.75 5.75 0 0 1 9 3.25Zm0 2.2a3.55 3.55 0 1 0 0 7.1 3.55 3.55 0 0 0 0-7.1Z"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function showWindow() {
  if (!windowRef || windowRef.isDestroyed()) createWindow();
  windowRef.show();
  windowRef.focus();
}

function updateTray() {
  if (!trayRef) return;
  const status = getStatus();
  const connected = status.tunnel;
  trayRef.setToolTip(`WebGPT Bridge · ${connected ? "已连接" : "未连接"}`);
  trayRef.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? "已连接到 ChatGPT" : "未连接", enabled: false },
    { type: "separator" },
    { label: "显示控制器", click: showWindow },
    {
      label: "启动连接",
      enabled: !connected,
      click: () => startAll().catch((error) => appendLog("host", `启动失败：${error.message}`)),
    },
    { label: "停止服务", enabled: status.server || status.tunnel, click: () => { void stopAll(); } },
    { type: "separator" },
    {
      label: "退出 WebGPT Bridge",
      click: () => { isQuitting = true; app.quit(); },
    },
  ]));
}

function createTray() {
  trayRef = new Tray(trayIcon());
  trayRef.on("click", showWindow);
  updateTray();
}

async function stopChild(child, name) {
  if (!processIsLive(child)) return;
  appendLog("host", `正在停止 ${name}…`);
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

async function stopAll() {
  await stopChild(tunnelProcess, "隧道客户端");
  await stopChild(serverProcess, "Agent 服务");
  tunnelProcess = undefined;
  serverProcess = undefined;
  emit("status", getStatus());
}

async function startAll() {
  if (processIsLive(tunnelProcess)) return getStatus();
  const settings = await loadSettings();
  const node = validateSettings(settings);
  const runtimeKey = await readRuntimeKey();
  if (!runtimeKey) throw new Error("请先保存此电脑专用的 OpenAI Tunnel 运行时密钥。");
  await stopAll();
  logLines = [];
  emit("logs", logLines);

  const baseEnv = {
    ...process.env,
    LPC_WORKSPACE: settings.workspacePath,
    LPC_HOST: MCP_HOST,
    LPC_PORT: String(MCP_PORT),
    LPC_VERIFY_SANDBOX: "true",
    LPC_ENABLE_NETWORK_TOOLS: "false",
  };
  serverProcess = spawnLogged(node, [path.join(settings.runtimePath, "dist", "server.js")], { env: baseEnv, cwd: settings.runtimePath }, "agent");
  await waitForHealth();

  const tunnelEnv = {
    ...process.env,
    CONTROL_PLANE_API_KEY: runtimeKey,
    ...(settings.httpsProxy ? { HTTPS_PROXY: settings.httpsProxy, HTTP_PROXY: settings.httpsProxy } : {}),
  };
  const init = spawnLogged(
    settings.tunnelClientPath,
    ["init", "--force", "--profile", settings.profile, "--tunnel-id", settings.tunnelId, "--mcp-server-url", `http://${MCP_HOST}:${MCP_PORT}/mcp`],
    { env: tunnelEnv },
    "tunnel-init",
  );
  await onceExit(init);
  tunnelProcess = spawnLogged(settings.tunnelClientPath, ["run", "--profile", settings.profile], { env: tunnelEnv }, "tunnel");
  emit("status", getStatus());
  return getStatus();
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 680,
    height: 584,
    minWidth: 520,
    minHeight: 510,
    backgroundColor: "#f7f7f8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  windowRef.webContents.on("will-navigate", (event) => event.preventDefault());
  windowRef.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    windowRef.hide();
  });
  windowRef.on("closed", () => { windowRef = undefined; });
  windowRef.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
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
  ipcMain.handle("host:start", startAll);
  ipcMain.handle("host:stop", stopAll);
  ipcMain.handle("host:status", getStatus);
  ipcMain.handle("host:logs", () => logLines);
  ipcMain.handle("chatgpt:open", () => shell.openExternal("https://chatgpt.com/"));
  createTray();
  createWindow();
  app.on("activate", showWindow);
});

app.on("before-quit", () => { isQuitting = true; void stopAll(); });
