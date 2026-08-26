const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer smoke remains compatible with Windows PowerShell 5.1", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "windows-installer-smoke.ps1"), "utf8");
  const buildWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "build-desktop.yml"), "utf8");
  const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release-desktop.yml"), "utf8");

  assert.match(buildWorkflow, /WindowsPowerShell\\v1\.0\\powershell\.exe[\s\S]*windows-installer-smoke\.ps1/);
  assert.match(releaseWorkflow, /WindowsPowerShell\\v1\.0\\powershell\.exe[\s\S]*windows-installer-smoke\.ps1/);
  assert.doesNotMatch(smoke, /\?\?/, "Windows PowerShell 5.1 does not support the null-coalescing operator");
});

test("Windows installer smoke discovers the updater-safe release basename", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "windows-installer-smoke.ps1"), "utf8");

  assert.match(smoke, /-Filter "WebGPT-Bridge-\*-win-x64\.exe"/);
  assert.doesNotMatch(smoke, /-Filter "WebGPT Bridge-\*-win-x64\.exe"/);
});
