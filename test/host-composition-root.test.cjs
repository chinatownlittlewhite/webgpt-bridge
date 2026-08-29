const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const mainPath = path.join(root, "src", "main.cjs");
const main = fs.readFileSync(mainPath, "utf8");
const hostModules = [
  "settings-store.cjs",
  "host-security.cjs",
  "broker-server.cjs",
  "runtime-host.cjs",
  "window-controller.cjs",
  "tray-controller.cjs",
  "ipc-controller.cjs",
];

test("main.cjs is a Host composition root rather than an implementation owner", () => {
  for (const file of hostModules) {
    const modulePath = path.join(root, "src", "host", file);
    assert.equal(fs.existsSync(modulePath), true, `${file} must exist`);
  }

  for (const symbol of [
    "createHostSettingsStore",
    "createHostSecurity",
    "createHostBrokerServer",
    "createRuntimeHost",
    "createWindowController",
    "createTrayController",
    "registerHostIpc",
  ]) {
    assert.match(main, new RegExp(symbol));
  }

  for (const implementation of [
    "function confirmLocalOperation",
    "function startLocalBroker",
    "function attachLocalBrokerConnection",
    "function startRuntimeAgent",
    "function startRuntimeTunnel",
    "function stopChild",
    "function createWindow",
    "function createTray",
    "function trayIcon",
  ]) {
    assert.doesNotMatch(main, new RegExp(implementation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.doesNotMatch(main, /\bnet\.createServer\b/);
  assert.doesNotMatch(main, /\bspawn\(/);
  assert.ok(main.split(/\r?\n/).length < 500, "composition root should remain bounded");
});
