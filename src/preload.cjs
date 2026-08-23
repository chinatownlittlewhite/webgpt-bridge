const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localAgentHost", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  clearKey: () => ipcRenderer.invoke("settings:clear-key"),
  chooseDirectory: () => ipcRenderer.invoke("dialog:directory"),
  chooseFile: () => ipcRenderer.invoke("dialog:file"),
  start: () => ipcRenderer.invoke("host:start"),
  stop: () => ipcRenderer.invoke("host:stop"),
  openChatGPT: () => ipcRenderer.invoke("chatgpt:open"),
  status: () => ipcRenderer.invoke("host:status"),
  logs: () => ipcRenderer.invoke("host:logs"),
  onEvent: (callback) => ipcRenderer.on("host:event", (_event, value) => callback(value)),
});
