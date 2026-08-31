const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { createUpdateService } = require("../src/update-service.cjs");
const { resolveDesktopGitHubCli } = require("../src/github-cli-path.cjs");

function updaterReturning(result) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => result;
  updater.downloadUpdate = async () => [];
  updater.quitAndInstall = () => {};
  return updater;
}

function serviceWith(updater) {
  return createUpdateService({ updater, currentVersion: "0.3.7", isPackaged: true, stopRuntime: async () => {}, setQuitting: () => {} });
}

test("resolved no-update result always settles the UI as up to date", async () => {
  const state = await serviceWith(updaterReturning({ isUpdateAvailable: false, updateInfo: { version: "0.3.7" } })).checkForUpdates();
  assert.equal(state.status, "up_to_date");
  assert.equal(state.canCheck, true);
  assert.equal(state.canDownload, false);
  assert.equal(state.canInstall, false);
  assert.equal(state.availableVersion, "");
});

test("resolved update result can recover the available state even if provider event is absent", async () => {
  const state = await serviceWith(updaterReturning({ isUpdateAvailable: true, updateInfo: { version: "0.3.8", releaseDate: "2026-08-26T00:00:00Z", releaseNotes: "<b>GitHub release</b>" } })).checkForUpdates();
  assert.equal(state.status, "available");
  assert.equal(state.availableVersion, "0.3.8");
  assert.equal(state.releaseNotes, "GitHub release");
  assert.equal(state.canCheck, true);
});

test("desktop GitHub CLI resolver finds Homebrew gh even when Finder PATH omits Homebrew", () => {
  const homebrewGh = "/opt/homebrew/bin/gh";
  const resolved = resolveDesktopGitHubCli({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    appToolsBin: "/Users/test/Library/Application Support/local-agent-host/tools/bin",
    exists: (candidate) => candidate === homebrewGh,
    findInPath: () => null,
  });
  assert.equal(resolved, homebrewGh);
});

test("available update action sends the user to the exact GitHub Release for manual installation", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  assert.match(html, /data-release-base="https:\/\/github\.com\/chinatownlittlewhite\/webgpt-bridge\/releases\/tag\/v"/);
  assert.match(renderer, /在 GitHub 下载/);
  assert.match(renderer, /window\.open\(/);
  const handler = renderer.slice(renderer.indexOf('byId("updateAction").addEventListener'));
  assert.doesNotMatch(handler, /downloadUpdate|installUpdateAndRestart/);
});

test("tag release workflow requires macOS signing notarization and Gatekeeper gates", () => {
  const release = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release-desktop.yml"), "utf8");
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*-\s*["']v\*["']/);
  assert.match(release, /gh release edit[^\n]*--draft=false[^\n]*--prerelease=false[^\n]*--latest/);
  assert.match(release, /WEBGPT_FORMAL_RELEASE:\s*macos/);
  assert.match(release, /CSC_LINK:\s*\$\{\{\s*secrets\.MACOS_CSC_LINK\s*\}\}/);
  assert.match(release, /APPLE_ID:\s*\$\{\{\s*secrets\.APPLE_ID\s*\}\}/);
  assert.match(release, /codesign\s+--verify/);
  assert.match(release, /stapler\s+validate/);
  assert.match(release, /spctl\s+--assess/);
});
