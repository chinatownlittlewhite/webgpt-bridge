const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");

test("Windows distribution prepares and ships a pinned Node 22 runtime", () => {
  const manifestPath = path.join(__dirname, "..", "scripts", "node-runtime-release.json");
  assert.ok(fs.existsSync(manifestPath), "pinned Node runtime manifest must exist");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, "22.23.2");
  assert.equal(manifest.assets["windows-x64"].file, "node-v22.23.2-win-x64.zip");
  assert.equal(manifest.assets["windows-x64"].sha256, "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97");
  assert.equal(manifest.assets["windows-x64"].nodeSha256, "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4");

  assert.equal(packageJson.scripts["prepare:node-runtime:win"], "node scripts/prepare-node-runtime.cjs windows-x64");
  assert.match(packageJson.scripts["dist:win"], /prepare:node-runtime:win/);

  const config = createBuilderConfig({});
  assert.ok((config.win.extraResources || []).some((item) => item.from === "build/node-runtime" && item.to === "node-runtime"));

  const preparePath = path.join(__dirname, "..", "scripts", "prepare-node-runtime.cjs");
  assert.ok(fs.existsSync(preparePath), "Node runtime preparation script must exist");
  const prepare = fs.readFileSync(preparePath, "utf8");
  assert.match(prepare, /SHA-256 mismatch/);
  assert.match(prepare, /nodeSha256/);
  assert.match(prepare, /BUNDLED_SOURCE\.json/);
  assert.match(prepare, /LICENSE/);
});

test("packaged Windows host routes its bundled Node manifest through StartupPreflight", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(mainSource, /defaultBundledNodePath/);
  assert.match(mainSource, /node-runtime/);
  assert.match(mainSource, /BUNDLED_SOURCE\.json/);
  assert.match(mainSource, /nodeSha256/);
  assert.match(mainSource, /bundledNodeManifest:\s*\(\)\s*=>\s*loadBundledNodeManifest\(\)/);
  assert.match(mainSource, /startupPreflight\.prepare/);
});

test("Windows installer smoke proves the installed bundled Node actually runs", () => {
  const smoke = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-installer-smoke.ps1"), "utf8");
  assert.match(smoke, /node-runtime\\node\.exe/);
  assert.match(smoke, /--version/);
  assert.match(smoke, /v22\.23\.2/);
  assert.match(smoke, /bundledNodeBytes/);
});
