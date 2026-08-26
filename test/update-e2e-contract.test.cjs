const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("production app has no runtime update feed override", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
  assert.doesNotMatch(main, /WEBGPT_UPDATE_FEED|setFeedURL\(/);
  assert.doesNotMatch(preload, /feed|repository|installerPath/i);
});

test("production package excludes E2E control while generated E2E config opts in only at build time", () => {
  const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
  const production = createBuilderConfig({});
  assert.ok(production.files.includes("!src/update-e2e-control.cjs"));

  const { createE2EConfig } = require("../scripts/update-e2e-feed.cjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-update-e2e-config-"));
  const out = path.join(temp, "old.cjs");
  const sentinel = path.join(temp, "sentinel.json");
  const config = createE2EConfig({
    env: {},
    url: "http://127.0.0.1:18181/",
    version: "90.0.0",
    expectedVersion: "90.0.1",
    sentinel,
    out,
  });
  assert.deepEqual(config.publish, [{ provider: "generic", url: "http://127.0.0.1:18181/" }]);
  assert.equal(config.files.includes("!src/update-e2e-control.cjs"), false);
  assert.equal(config.extraMetadata.WEBGPT_UPDATE_E2E_BUILD, true);
  assert.equal(config.extraMetadata.WEBGPT_UPDATE_E2E_EXPECTED_VERSION, "90.0.1");
  assert.equal(config.extraMetadata.WEBGPT_UPDATE_E2E_SENTINEL, sentinel);
  assert.equal(config.extraMetadata.version, "90.0.0");
  assert.equal(config.directories.output, path.join(temp, "old"));
  assert.ok(production.files.includes("!src/update-e2e-control.cjs"), "E2E config generation must not mutate production config");
  fs.rmSync(temp, { recursive: true, force: true });
});

test("E2E config generator refuses non-loopback feeds", () => {
  const { createE2EConfig } = require("../scripts/update-e2e-feed.cjs");
  assert.throws(() => createE2EConfig({
    env: {},
    url: "https://example.com/updates/",
    version: "90.0.0",
    expectedVersion: "90.0.1",
    sentinel: path.resolve("sentinel.json"),
    out: path.resolve("old.cjs"),
  }), /127\.0\.0\.1/);
});

test("E2E control uses packaged metadata and the same explicit updater methods", () => {
  const control = fs.readFileSync(path.join(root, "src", "update-e2e-control.cjs"), "utf8");
  assert.match(control, /WEBGPT_UPDATE_E2E_BUILD/);
  assert.match(control, /WEBGPT_UPDATE_E2E_EXPECTED_VERSION/);
  assert.match(control, /WEBGPT_UPDATE_E2E_SENTINEL/);
  assert.match(control, /updateService\.checkForUpdates\(\)/);
  assert.match(control, /updateService\.downloadUpdate\(\)/);
  assert.match(control, /updateService\.installUpdateAndRestart\(\)/);
  assert.doesNotMatch(control, /setFeedURL|WEBGPT_UPDATE_FEED|process\.env/);
});

test("E2E assertion server is loopback-only and rejects nested or traversal paths", () => {
  const { safeRequestName } = require("../scripts/update-e2e-assert.cjs");
  assert.equal(safeRequestName("/latest.yml"), "latest.yml");
  assert.equal(safeRequestName("/WebGPT%20Bridge-90.0.1-win-x64.exe"), "WebGPT Bridge-90.0.1-win-x64.exe");
  for (const value of ["/../secret", "/%2e%2e/secret", "/nested/file", "/%2Fetc%2Fpasswd", "//server/share"]) {
    assert.throws(() => safeRequestName(value), /unsafe update E2E request path/);
  }
  const script = fs.readFileSync(path.join(root, "scripts", "update-e2e-assert.cjs"), "utf8");
  assert.match(script, /127\.0\.0\.1/);
  assert.match(script, /Accept-Ranges/);
});

test("formal platform jobs gate artifact upload on signed packaged updater E2E", () => {
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release-desktop.yml"), "utf8");
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  for (const section of [windows, mac]) {
    const e2e = section.indexOf("update-e2e-feed.cjs");
    const assertion = section.indexOf("update-e2e-assert.cjs", e2e);
    const upload = section.indexOf("actions/upload-artifact@v4");
    assert.ok(e2e >= 0 && assertion > e2e && upload > assertion, "packaged updater E2E must finish before artifact upload");
    assert.match(section, /90\.0\.0/);
    assert.match(section, /90\.0\.1/);
  }
});

test("release publication uploads only validated top-level files", () => {
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release-desktop.yml"), "utf8");
  const publish = release.slice(release.indexOf("  publish:"));
  assert.match(publish, /find release-win release-mac -maxdepth 1 -type f/);
  assert.doesNotMatch(publish, /release-win\/\* release-mac\/\*/);
});
