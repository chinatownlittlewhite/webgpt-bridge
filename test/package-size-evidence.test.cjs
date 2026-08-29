const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function source(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

function assertMacSizeReporterReceivesAbsoluteApp(workflow) {
  assert.match(workflow, /APP="\$\(find release -type d -name 'WebGPT Bridge\.app' -print -quit\)"\n\s+APP="\$\(pwd -P\)\/\$APP"/);
  assert.match(workflow, /node scripts\/report-package-size\.cjs "\$APP" > release\/macos-package-size\.json/);
}

test("Windows installer smoke records app.asar and node-pty component sizes", () => {
  const smoke = source("scripts/windows-installer-smoke.ps1");
  assert.match(smoke, /appAsarBytes\s*=/);
  assert.match(smoke, /nodePtyBytes\s*=/);
  assert.match(smoke, /windows-install-size\.json/);
});

test("desktop PR packaging resolves an absolute macOS app before uploading machine-readable size evidence", () => {
  const workflow = source(".github/workflows/build-desktop.yml");
  assertMacSizeReporterReceivesAbsoluteApp(workflow);
  assert.match(workflow, /release\/macos-package-size\.json/);
  assert.match(workflow, /release\/windows-install-size\.json/);
});

test("formal release resolves an absolute macOS app and uploads size reports separately from publishable release assets", () => {
  const workflow = source(".github/workflows/release-desktop.yml");
  assert.match(workflow, /desktop-release-macos-size/);
  assert.match(workflow, /desktop-release-windows-size/);
  assertMacSizeReporterReceivesAbsoluteApp(workflow);

  const publish = workflow.split(/\n  publish:\s*\n/)[1] || "";
  assert.doesNotMatch(publish, /desktop-release-(?:macos|windows)-size/);
});
