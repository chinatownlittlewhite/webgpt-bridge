function registerHostIpc({ ipcMain, settingsStore, dialog, getWindow, runtimeSupervisor, getStatus, getLogs, diagnosticsService, shell, updateService }) {
  const channels = [];
  const handle = (channel, handler) => {
    channels.push(channel);
    ipcMain.handle(channel, handler);
  };

  handle("settings:load", () => settingsStore.loadSettings());
  handle("settings:save", async (_event, payload) => {
    if (!payload || typeof payload !== "object") throw new Error("设置格式无效。");
    if (typeof payload.runtimeKey === "string" && payload.runtimeKey.trim()) {
      await settingsStore.saveRuntimeKey(payload.runtimeKey.trim());
    }
    return { ...(await settingsStore.writeSettings(payload)), hasRuntimeKey: settingsStore.hasRuntimeKey() };
  });
  handle("settings:clear-key", () => settingsStore.clearRuntimeKey());
  handle("dialog:directory", async () => (await dialog.showOpenDialog(getWindow(), { properties: ["openDirectory"] })).filePaths[0] || "");
  handle("dialog:file", async () => (await dialog.showOpenDialog(getWindow(), { properties: ["openFile"] })).filePaths[0] || "");
  handle("host:start", () => runtimeSupervisor.start());
  handle("host:stop", () => runtimeSupervisor.stop("ipc"));
  handle("host:status", () => getStatus());
  handle("host:logs", () => getLogs());
  handle("host:diagnostics", () => diagnosticsService.snapshot());
  handle("chatgpt:open", () => shell.openExternal("https://chatgpt.com/"));
  handle("update:get-state", () => updateService.getState());
  handle("update:check", () => updateService.checkForUpdates());
  handle("update:download", () => updateService.downloadUpdate());
  handle("update:install", () => updateService.installUpdateAndRestart());

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerHostIpc };
