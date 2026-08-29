const test = require("node:test");
const assert = require("node:assert/strict");

function fakeWindowHarness() {
  const events = new Map();
  const webEvents = new Map();
  let openHandler;
  const instance = {
    hidden: false,
    shown: false,
    focused: false,
    destroyed: false,
    webContents: {
      setWindowOpenHandler(fn) { openHandler = fn; },
      on(name, fn) { webEvents.set(name, fn); },
    },
    on(name, fn) { events.set(name, fn); },
    loadFile(file) { this.loaded = file; },
    show() { this.shown = true; },
    focus() { this.focused = true; },
    hide() { this.hidden = true; },
    isDestroyed() { return this.destroyed; },
  };
  function BrowserWindow(options) { instance.options = options; return instance; }
  return { BrowserWindow, instance, events, webEvents, openHandler: () => openHandler };
}

test("window controller preserves renderer isolation, external-link handling, and hide-on-close", () => {
  const harness = fakeWindowHarness();
  const external = [];
  let nativeQuit = false;
  const { createWindowController } = require("../src/host/window-controller.cjs");
  const controller = createWindowController({
    BrowserWindow: harness.BrowserWindow,
    shell: { openExternal: (url) => external.push(url) },
    preloadPath: "/app/preload.cjs",
    rendererPath: "/app/renderer/index.html",
    platform: "darwin",
    nativeQuitAllowed: () => nativeQuit,
  });
  controller.showWindow();
  assert.equal(harness.instance.options.webPreferences.contextIsolation, true);
  assert.equal(harness.instance.options.webPreferences.nodeIntegration, false);
  assert.equal(harness.instance.options.webPreferences.sandbox, true);
  assert.equal(harness.instance.loaded, "/app/renderer/index.html");
  assert.equal(harness.instance.shown, true);
  assert.equal(harness.instance.focused, true);
  assert.deepEqual(harness.openHandler()({ url: "https://chatgpt.com/" }), { action: "deny" });
  assert.deepEqual(external, ["https://chatgpt.com/"]);
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  harness.webEvents.get("will-navigate")(nav);
  assert.equal(nav.prevented, true);
  const close = { prevented: false, preventDefault() { this.prevented = true; } };
  harness.events.get("close")(close);
  assert.equal(close.prevented, true);
  assert.equal(harness.instance.hidden, true);
  nativeQuit = true;
  const nativeClose = { prevented: false, preventDefault() { this.prevented = true; } };
  harness.events.get("close")(nativeClose);
  assert.equal(nativeClose.prevented, false);
});

test("IPC controller stores runtime key before sanitized settings and delegates host/update actions", async () => {
  const handlers = new Map();
  const removed = [];
  const calls = [];
  const { registerHostIpc } = require("../src/host/ipc-controller.cjs");
  const dispose = registerHostIpc({
    ipcMain: {
      handle(name, fn) { handlers.set(name, fn); },
      removeHandler(name) { removed.push(name); handlers.delete(name); },
    },
    settingsStore: {
      loadSettings: async () => ({ workspacePath: "/workspace" }),
      saveRuntimeKey: async (key) => calls.push(["key", key]),
      writeSettings: async (payload) => { calls.push(["settings", payload.workspacePath]); return { workspacePath: payload.workspacePath }; },
      hasRuntimeKey: () => true,
      clearRuntimeKey: async () => ({ hasRuntimeKey: false }),
    },
    dialog: { showOpenDialog: async (_window, options) => ({ filePaths: [options.properties[0] === "openDirectory" ? "/dir" : "/file"] }) },
    getWindow: () => ({ id: 1 }),
    runtimeSupervisor: { start: async () => "started", stop: async () => "stopped" },
    getStatus: () => ({ connected: false }),
    getLogs: () => [{ line: "x" }],
    shell: { openExternal: async (url) => calls.push(["external", url]) },
    updateService: {
      getState: () => ({ status: "idle" }),
      checkForUpdates: async () => "checked",
      downloadUpdate: async () => "downloaded",
      installUpdateAndRestart: async () => "installed",
    },
  });
  const saved = await handlers.get("settings:save")(null, { workspacePath: "/next", runtimeKey: "1234567890abcdef" });
  assert.deepEqual(calls.slice(0, 2), [["key", "1234567890abcdef"], ["settings", "/next"]]);
  assert.equal(saved.hasRuntimeKey, true);
  assert.equal(await handlers.get("dialog:directory")(), "/dir");
  assert.equal(await handlers.get("dialog:file")(), "/file");
  assert.equal(await handlers.get("host:start")(), "started");
  assert.equal(await handlers.get("update:check")(), "checked");
  await handlers.get("chatgpt:open")();
  assert.deepEqual(calls.at(-1), ["external", "https://chatgpt.com/"]);
  dispose();
  assert.ok(removed.includes("settings:save"));
  assert.ok(removed.includes("update:install"));
});

test("tray controller delegates start stop show and quit actions without owning runtime state", () => {
  const { createTrayController } = require("../src/host/tray-controller.cjs");
  const actions = [];
  let template;
  const tray = { on() {}, setToolTip(value) { this.tooltip = value; }, setContextMenu(value) { this.menu = value; } };
  const controller = createTrayController({
    Tray: function Tray() { return tray; },
    Menu: { buildFromTemplate(value) { template = value; return value; } },
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    trayIconDataUrl: () => "data:image/svg+xml;base64,AA==",
    platform: "linux",
    getStatus: () => ({ connected: false, server: false, tunnel: false }),
    getUpdateState: () => ({ status: "idle" }),
    showWindow: () => actions.push("show"),
    start: () => { actions.push("start"); return Promise.resolve(); },
    stop: () => actions.push("stop"),
    requestQuit: () => { actions.push("quit"); return Promise.resolve(); },
    appendLog() {},
  });
  controller.createTray();
  template.find((item) => item.label === "显示控制器").click();
  template.find((item) => item.label === "启动连接").click();
  template.find((item) => item.label === "停止服务").click();
  template.find((item) => item.label === "退出 WebGPT Bridge").click();
  assert.deepEqual(actions, ["show", "start", "stop", "quit"]);
});
