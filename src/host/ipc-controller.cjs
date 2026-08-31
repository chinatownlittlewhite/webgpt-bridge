const { createCapabilitiesService } = require("./diagnostics-service.cjs");

const HANDLERS = Object.freeze([
  "settings:load", "settings:save", "settings:clear-key", "dialog:directory", "dialog:file",
  "host:start", "host:stop", "host:status", "host:logs", "host:capabilities", "chatgpt:open",
  "update:get-state", "update:check", "update:download", "update:install",
]);

function registerHostIpc({
  ipcMain,
  settingsStore,
  dialog,
  getWindow,
  runtimeSupervisor,
  getStatus,
  getLogs,
  capabilitiesService,
  shell,
  updateService,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("ipcMain is required");
  const activeCapabilitiesService = capabilitiesService || createCapabilitiesService({ getStatus });
  ipcMain.handle("settings:load", () => settingsStore.loadSettings());
  ipcMain.handle("settings:save", async (_event, payload) => {
    if (!payload || typeof payload !== "object") throw new Error("设置格式无效。");
    if (typeof payload.runtimeKey === "string" && payload.runtimeKey.trim()) await settingsStore.saveRuntimeKey(payload.runtimeKey.trim());
    return { ...(await settingsStore.writeSettings(payload)), hasRuntimeKey: settingsStore.hasRuntimeKey() };
  });
  ipcMain.handle("settings:clear-key", () => settingsStore.clearRuntimeKey());
  ipcMain.handle("dialog:directory", async () => (await dialog.showOpenDialog(getWindow(), { properties: ["openDirectory"] })).filePaths[0] || "");
  ipcMain.handle("dialog:file", async () => (await dialog.showOpenDialog(getWindow(), { properties: ["openFile"] })).filePaths[0] || "");
  ipcMain.handle("host:start", () => runtimeSupervisor.start());
  ipcMain.handle("host:stop", () => runtimeSupervisor.stop("ipc"));
  ipcMain.handle("host:status", () => getStatus());
  ipcMain.handle("host:logs", () => getLogs());
  ipcMain.handle("host:capabilities", () => activeCapabilitiesService.capabilities());
  ipcMain.handle("chatgpt:open", () => shell.openExternal("https://chatgpt.com/"));
  ipcMain.handle("update:get-state", () => updateService.getState());
  ipcMain.handle("update:check", () => updateService.checkForUpdates());
  ipcMain.handle("update:download", () => updateService.downloadUpdate());
  ipcMain.handle("update:install", () => updateService.installUpdateAndRestart());
  return () => {
    if (typeof ipcMain.removeHandler !== "function") return;
    for (const name of HANDLERS) ipcMain.removeHandler(name);
  };
}

module.exports = { HANDLERS, registerHostIpc };
