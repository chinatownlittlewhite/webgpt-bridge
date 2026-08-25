const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");

test("renderer update IPC has no URL repository path or installer arguments", () => {
  for (const channel of ["update:get-state", "update:check", "update:download", "update:install"]) {
    assert.match(main, new RegExp(channel.replace(":", "\\:")));
  }
  assert.match(preload, /getUpdateState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:get-state"\)/);
  assert.match(preload, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:check"\)/);
  assert.match(preload, /downloadUpdate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:download"\)/);
  assert.match(preload, /installUpdateAndRestart:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:install"\)/);
  assert.doesNotMatch(preload, /setFeedURL|feedURL|installerPath|repository|publisherName/);
});

test("update installation marks quit intent before electron-updater closes windows", () => {
  assert.match(main, /setQuitting:\s*\(value\)\s*=>\s*\{\s*isQuitting\s*=\s*Boolean\(value\)/s);
  assert.match(main, /createUpdateService/);
  assert.match(main, /autoUpdater/);
});

test("main process does not expose host-prep mutation through update IPC", () => {
  const updateSection = main.slice(main.indexOf("update:get-state"));
  assert.doesNotMatch(updateSection, /windows-host-prep|--apply|--remove|schtasks/i);
});

test("macOS child shutdown waits for real exit before fallback kill", () => {
  const processLive = main.match(/function processIsLive\(child\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(processLive, /child\.exitCode\s*===\s*null/);
  assert.doesNotMatch(processLive, /child\.killed/);

  const stopStart = main.indexOf("async function stopChild");
  const stopEnd = main.indexOf("async function stopAll", stopStart);
  const stop = main.slice(stopStart, stopEnd);
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
