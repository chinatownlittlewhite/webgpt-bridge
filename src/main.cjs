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
const { createWindowController } = require("./host/window-controller.cjs");
const { createTrayController } = require("./host/tray-controller.cjs");
const { registerHostIpc } = require("./host/ipc-controller.cjs");
const { createLogStreamService } = require("./host/log-stream-service.cjs");
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

let windowController;
let trayController;
let disposeIpc;
const logStream = createLogStreamService({ maxEntries: MAX_LOG_LINES });
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
  windowController?.getWindow()?.webContents.send("host:event", { type, value });
  if (type === "status") updateTray();
}

function emitLogCursor(reset = false) {
  emit("logs", { cursor: logStream.getCursor(), reset });
}

function appendLog(source, data) {
  const result = logStream.append(source, data);
  if (result.added > 0) emitLogCursor(false);
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
  return windowController?.dialogOwner();
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
    logStream.reset();
    emitLogCursor(true);
  },
  spawnSync,
  endpoints: { mcpHost: MCP_HOST, mcpPort: MCP_PORT },
  platform: process.platform,
  env: process.env,
});

function showWindow() {
  return windowController?.showWindow();
}

function updateTray() {
  trayController?.updateTray();
}

if (singleInstanceOwnership.primary) {
  app.whenReady().then(() => {
    runtimeSupervisor = createRuntimeSupervisor(runtimeHost);
    runtimeSupervisor.subscribe(() => emit("status", getStatus()));
    appLifecycle = createAppLifecycleCoordinator({
      app,
      supervisor: runtimeSupervisor,
      disposeHostServices: async () => {
        disposeIpc?.();
        trayController?.dispose();
        singleInstanceOwnership.dispose();
        updateService?.dispose();
      },
    });

    windowController = createWindowController({
      BrowserWindow,
      shell,
      preloadPath: path.join(__dirname, "preload.cjs"),
      rendererPath: path.join(__dirname, "renderer", "index.html"),
      platform: process.platform,
      nativeQuitAllowed: () => appLifecycle.nativeQuitAllowed(),
    });
    trayController = createTrayController({
      Tray,
      Menu,
      nativeImage,
      trayIconDataUrl,
      platform: process.platform,
      getStatus,
      getUpdateState: () => updateService?.getState(),
      showWindow,
      start: () => runtimeSupervisor.start(),
      stop: (reason) => runtimeSupervisor.stop(reason),
      requestQuit: (reason) => appLifecycle.requestQuit(reason),
      appendLog,
    });
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(trayController.dockIcon());
    updateService = createUpdateService({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      prepareForInstall: () => appLifecycle.prepareForUpdateInstall(),
      emitState: (state) => {
        windowController?.getWindow()?.webContents?.send("update:state", state);
        updateTray();
      },
      log: (line) => appendLog("update", line),
    });
    // The host has no browser-facing permissions. Tunnel traffic is handled by
    // the separate client process, not by renderer pages.
    const { session } = require("electron");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    disposeIpc = registerHostIpc({
      ipcMain,
      settingsStore,
      dialog,
      getWindow: () => windowController.getWindow(),
      runtimeSupervisor,
      getStatus,
      getLogs: (payload) => logStream.read(payload),
      shell,
      updateService,
    });
    trayController.createTray();
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
