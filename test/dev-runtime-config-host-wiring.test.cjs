const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop main process applies development isolation before userData and runtime port consumers", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/dev-runtime-config\.cjs"\)/);
  assert.match(main, /resolveDevelopmentRuntimeConfig\(\{[\s\S]{0,400}isPackaged:\s*app\.isPackaged[\s\S]{0,400}env:\s*process\.env[\s\S]{0,400}defaultUserDataPath:/);
  assert.match(main, /app\.setPath\("userData",\s*desktopRuntimeConfig\.userDataPath\)/);
  assert.match(main, /const MCP_PORT = desktopRuntimeConfig\.mcpPort;/);
  assert.match(main, /const TUNNEL_HEALTH_PORT = desktopRuntimeConfig\.tunnelHealthPort;/);
});

test("desktop ownership lock precedes primary runtime construction and startup wiring", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  const setUserData = main.indexOf('app.setPath("userData", desktopRuntimeConfig.userDataPath)');
  const ownership = main.indexOf("establishSingleInstanceOwnership({");
  const whenReady = main.indexOf("app.whenReady().then");
  const supervisor = main.indexOf("runtimeSupervisor = createRuntimeSupervisor({");
  const hostStart = main.indexOf('ipcMain.handle("host:start"');

  assert.ok(setUserData >= 0, "development userData must be selected before ownership");
  assert.ok(ownership > setUserData, "single-instance ownership must be acquired after the selected userData profile");
  assert.ok(whenReady > ownership, "secondary instances must stop before primary ready initialization is registered");
  assert.ok(supervisor > whenReady, "runtime supervisor must only be constructed on the primary ready path");
  assert.ok(hostStart > supervisor, "host start IPC must be wired only after primary runtime construction");
});
