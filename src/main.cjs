const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { resolveDevelopmentRuntimeConfig } = require("./dev-runtime-config.cjs");
const { establishSingleInstanceOwnership } = require("./single-instance.cjs");
const { createHostSettingsStore } = require("./host/settings-store.cjs");
const { createHostSecurity } = require("./host/host-security.cjs");
const { createHostBrokerServer } = require("./host/broker-server.cjs");
const { createRuntimeHost } = require("./host/runtime-host.cjs");
const { resolveDesktopGitHubCli } = require("./github-cli-path.cjs");
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
let logLines = [];
let updateService;
let runtimeSupervisor;
let appLifecycle;

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

const settingsStore = createHostSettingsStore({
  app,
  safeStorage,
  bundledRuntimePath,
  spawnSync,
  platform: process.platform,
});

const startupPreflight = createStartupPreflight({
  bundledTunnelClientPath: () => defaultBundledTunnelClientPath(),
  bundledNodeManifest: () => loadBundledNodeManifest(),
  ensureTunnelProfile,
  tunnelProfileDir: () => path.join(app.getPath("userData"), "tunnel-profiles"),
  mcpServerUrl: () => `http://${MCP_HOST}:${MCP_PORT}/mcp`,
  tunnelHealthListenAddr: () => TUNNEL_HEALTH_LISTEN_ADDR,
  readRuntimeKey: () => settingsStore.readRuntimeKey(),
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

const hostSecurity = createHostSecurity({ dialog, dialogOwner, appendLog });

const hostBroker = createHostBrokerServer({
  app,
  hostSecurity,
  appendLog,
  endpoints: { mcpHost: MCP_HOST, mcpPort: MCP_PORT, tunnelHealthHost: TUNNEL_HEALTH_HOST, tunnelHealthPort: TUNNEL_HEALTH_PORT },
  platform: process.platform,
  pid: process.pid,
  spawnSync,
});

const runtimeHost = createRuntimeHost({
  settingsStore,
  startupPreflight,
  hostBroker,
  appendLog,
  resetLogs: () => {
    logLines = [];
    emit("logs", logLines);
  },
  spawnSync,
  endpoints: { mcpHost: MCP_HOST, mcpPort: MCP_PORT },
  platform: process.platform,
  env: process.env,
});

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
    runtimeSupervisor = createRuntimeSupervisor(runtimeHost);
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
    ipcMain.handle("settings:load", () => settingsStore.loadSettings());
    ipcMain.handle("settings:save", async (_event, payload) => {
      if (!payload || typeof payload !== "object") throw new Error("设置格式无效。");
      if (typeof payload.runtimeKey === "string" && payload.runtimeKey.trim()) await settingsStore.saveRuntimeKey(payload.runtimeKey.trim());
      return { ...(await settingsStore.writeSettings(payload)), hasRuntimeKey: settingsStore.hasRuntimeKey() };
    });
    ipcMain.handle("settings:clear-key", () => settingsStore.clearRuntimeKey());
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
