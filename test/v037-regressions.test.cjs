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
  return createUpdateService({
    updater,
    currentVersion: "0.3.7",
    isPackaged: true,
    stopRuntime: async () => {},
    setQuitting: () => {},
  });
}

test("resolved no-update result always settles the UI as up to date", async () => {
  const service = serviceWith(updaterReturning({
    isUpdateAvailable: false,
    updateInfo: { version: "0.3.7" },
  }));

  const state = await service.checkForUpdates();
  assert.equal(state.status, "up_to_date");
  assert.equal(state.canCheck, true);
  assert.equal(state.canDownload, false);
  assert.equal(state.canInstall, false);
  assert.equal(state.availableVersion, "");
});

test("resolved update result can recover the available state even if provider event is absent", async () => {
  const service = serviceWith(updaterReturning({
    isUpdateAvailable: true,
    updateInfo: {
      version: "0.3.8",
      releaseDate: "2026-08-26T00:00:00Z",
      releaseNotes: "<b>GitHub release</b>",
    },
  }));

  const state = await service.checkForUpdates();
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

test("available update action sends the user to the exact GitHub Release instead of unsigned in-app install", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  assert.match(html, /data-release-base="https:\/\/github\.com\/chinatownlittlewhite\/webgpt-bridge\/releases\/tag\/v"/);
  assert.match(renderer, /在 GitHub 下载/);
  assert.match(renderer, /window\.open\(/);
  const handler = renderer.slice(renderer.indexOf('byId("updateAction").addEventListener'));
  assert.doesNotMatch(handler, /downloadUpdate|installUpdateAndRestart/);
});

test("tag release workflow publishes GitHub artifacts without external signing or notarization gates", () => {
  const release = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release-desktop.yml"), "utf8");
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*-\s*["']v\*["']/);
  assert.match(release, /gh release edit[^\n]*--draft=false[^\n]*--prerelease=false[^\n]*--latest/);
  assert.doesNotMatch(release, /desktop-release-windows|desktop-release-macos/);
  assert.doesNotMatch(release, /AZURE_|WEBGPT_WINDOWS_SIGN_|WEBGPT_MAC_IDENTITY|CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_/);
  assert.doesNotMatch(release, /Get-AuthenticodeSignature|codesign\s+--verify|stapler\s+validate|spctl\s+--assess/);
});
