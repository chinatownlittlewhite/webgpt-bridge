const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");

test("main.cjs is a Host composition root rather than an implementation owner", () => {
  for (const factory of [
    "createHostSettingsStore",
    "createHostSecurity",
    "createHostBrokerServer",
    "createRuntimeHost",
    "createWindowController",
    "createTrayController",
    "registerHostIpc",
    "createRuntimeSupervisor",
    "createAppLifecycleCoordinator",
    "createUpdateService",
  ]) {
    assert.match(main, new RegExp(`${factory}\\b`), `${factory} must be wired by main.cjs`);
  }

  const ownership = main.indexOf("establishSingleInstanceOwnership");
  const ready = main.indexOf("app.whenReady().then");
  assert.ok(ownership >= 0 && ready > ownership, "single-instance ownership must be established before ready-time services");
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/);

  for (const forbidden of [
    /net\.createServer\(/,
    /createBrokerChallenge\(/,
    /verifyBrokerProof\(/,
    /createHostCapabilityStore\(/,
    /createLocalFileBroker\(/,
    /createLocalTerminalBroker\(/,
    /safeStorage\.encryptString\(/,
    /safeStorage\.decryptString\(/,
    /new BrowserWindow\(/,
    /new Tray\(/,
    /ipcMain\.handle\(/,
    /child\.kill\(/,
    /spawn\(/,
  ]) assert.doesNotMatch(main, forbidden);
});
