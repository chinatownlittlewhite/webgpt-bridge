const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
const ipcController = fs.readFileSync(path.join(root, "src", "host", "ipc-controller.cjs"), "utf8");
const runtimeHost = fs.readFileSync(path.join(root, "src", "host", "runtime-host.cjs"), "utf8");
const trayController = fs.readFileSync(path.join(root, "src", "host", "tray-controller.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");

test("renderer update IPC has no URL repository path or installer arguments", () => {
  for (const channel of ["update:get-state", "update:check", "update:download", "update:install"]) {
    assert.match(ipcController, new RegExp(channel.replace(":", "\\:")));
  }
  assert.match(preload, /getUpdateState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:get-state"\)/);
  assert.match(preload, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:check"\)/);
  assert.match(preload, /downloadUpdate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:download"\)/);
  assert.match(preload, /installUpdateAndRestart:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:install"\)/);
  assert.doesNotMatch(preload, /setFeedURL|feedURL|installerPath|repository|publisherName/);
});

test("main process routes quit and update install through AppLifecycleCoordinator", () => {
  assert.match(main, /createAppLifecycleCoordinator/);
  assert.match(main, /appLifecycle\s*=\s*createAppLifecycleCoordinator\s*\(\s*\{[\s\S]*?supervisor:\s*runtimeSupervisor[\s\S]*?disposeHostServices:/);

  const updateStart = main.indexOf("updateService = createUpdateService");
  const updateEnd = main.indexOf("});", updateStart);
  const updateBlock = main.slice(updateStart, updateEnd);
  assert.match(updateBlock, /prepareForInstall:\s*\(\)\s*=>\s*appLifecycle\.prepareForUpdateInstall\(\)/);
  assert.doesNotMatch(updateBlock, /stopRuntime|setQuitting/);

  assert.match(main, /app\.on\("before-quit",\s*\(event\)\s*=>\s*\{?[^}]*appLifecycle\.handleBeforeQuit\(event\)/s);
  assert.match(main, /requestQuit:\s*\(reason\)\s*=>\s*appLifecycle\.requestQuit\(reason\)/);
  assert.match(trayController, /requestQuit\("tray-quit"\)/);
  assert.match(main, /appLifecycle\.nativeQuitAllowed\(\)/);
  assert.doesNotMatch(main, /let isQuitting\b/);
});

test("main process delegates runtime preparation to StartupPreflight without synchronous Node version probing", () => {
  assert.match(main, /createStartupPreflight/);
  assert.match(main, /startupPreflight\s*=\s*createStartupPreflight\s*\(/);
  assert.match(main, /createRuntimeHost\(\{[\s\S]*startupPreflight/);
  assert.match(runtimeHost, /startupPreflight\.prepare\s*\(/);
  assert.doesNotMatch(main, /function\s+nodeVersion\s*\(/);
  assert.doesNotMatch(main, /selectSupportedNode\s*\(/);
  assert.doesNotMatch(main, /spawnSync\([^\n]*\["--version"\]/);
});

test("tunnel startup reuses Host-owned profiles and connected waits for readyz", () => {
  assert.match(main, /ensureTunnelProfile/);
  assert.match(main, /tunnelProfileDir/);
  assert.doesNotMatch(main, /initializedTunnelPreflights/);

  const startIndex = runtimeHost.indexOf("async function startTunnel");
  const readyIndex = runtimeHost.indexOf("async function waitTunnelReady", startIndex);
  const stopIndex = runtimeHost.indexOf("async function stopResource", readyIndex);
  const startBlock = runtimeHost.slice(startIndex, readyIndex);
  const readyBlock = runtimeHost.slice(readyIndex, stopIndex);

  assert.match(startBlock, /tunnelProfile/);
  assert.match(startBlock, /"run"/);
  assert.match(startBlock, /"--profile-dir"/);
  assert.doesNotMatch(startBlock, /"init"|--force/);
  assert.match(readyBlock, /\/readyz/);
  assert.match(readyBlock, /statusCode\s*===\s*200/);
  assert.doesNotMatch(readyBlock, /return\s+processIsLive\(tunnel\)/);
});

test("main process does not expose host-prep mutation through update IPC", () => {
  assert.match(main, /registerHostIpc/);
  assert.doesNotMatch(ipcController, /windows-host-prep|--apply|--remove|schtasks/i);
});

test("macOS child shutdown waits for real exit before fallback kill", () => {
  const processLive = runtimeHost.match(/function processIsLive\(child\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(processLive, /child\.exitCode\s*===\s*null/);
  assert.doesNotMatch(processLive, /child\.killed/);

  const stopStart = runtimeHost.indexOf("async function stopChild");
  const stopEnd = runtimeHost.indexOf("async function prepare", stopStart);
  const stop = runtimeHost.slice(stopStart, stopEnd);
  const gracefulWait = stop.indexOf("waitForChildExit(child, 5000)");
  const term = stop.indexOf('child.kill("SIGTERM")');
  const forcedWait = stop.indexOf("waitForChildExit(child, 2000)");
  const kill = stop.indexOf('child.kill("SIGKILL")');
  assert.ok(gracefulWait >= 0 && term > gracefulWait, "exit waiter must be attached before SIGTERM");
  assert.ok(forcedWait > term && kill > forcedWait, "fallback exit waiter must be attached before SIGKILL");
});

test("update state subscription is removable", () => {
  assert.match(preload, /onUpdateState:\s*\(callback\)\s*=>\s*\{/);
  assert.match(preload, /ipcRenderer\.removeListener\("update:state",\s*listener\)/);
});

test("renderer exposes one bounded update panel and a fixed GitHub release action", () => {
  for (const id of ["updateCurrentVersion", "updateHeadline", "updateNotes", "updateProgress", "updateProgressBar", "updateMeta", "updateAction"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(renderer, /api\.getUpdateState\(\)/);
  assert.match(renderer, /api\.onUpdateState/);
  assert.match(renderer, /api\.checkForUpdates\(\)/);
  assert.match(html, /data-release-base="https:\/\/github\.com\/chinatownlittlewhite\/webgpt-bridge\/releases\/tag\/v"/);
  assert.match(renderer, /window\.open\(/);
  assert.match(renderer, /encodeURIComponent\(version\)/);
  assert.match(renderer, /updateNotes[^\n]*\.textContent|byId\(["']updateNotes["']\)\.textContent/);
  assert.doesNotMatch(renderer, /updateNotes[^\n]*\.innerHTML|byId\(["']updateNotes["']\)\.innerHTML/);
  assert.doesNotMatch(renderer, /fetch\(|XMLHttpRequest|setFeedURL|github\.com\/.*releases/i);
  assert.match(styles, /\.update-card/);
});

test("tray can surface a downloaded or available update without installing it", () => {
  assert.match(main, /createTrayController/);
  assert.match(trayController, /发现更新/);
  assert.match(trayController, /更新已下载/);
  const trayStart = trayController.indexOf("function updateTray");
  const trayEnd = trayController.indexOf("function createTray", trayStart);
  const tray = trayController.slice(trayStart, trayEnd);
  assert.doesNotMatch(tray, /update:install|installUpdateAndRestart|quitAndInstall/);
});
