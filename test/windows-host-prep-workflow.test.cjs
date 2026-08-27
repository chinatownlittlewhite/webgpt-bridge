const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const name of ["build-desktop.yml", "release-desktop.yml"]) {
  test(`${name} uses the combined Windows host subcommand for every host-prep operation`, () => {
    const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");
    const windows = workflow.slice(workflow.indexOf("  windows:"));
    assert.doesNotMatch(windows, /&\s+\$prep\s+--(?:apply|remove|check)\b/);
    assert.match(windows, /&\s+\$prep\s+host-prep\s+--apply/);
    assert.match(windows, /&\s+\$prep\s+host-prep\s+--remove/);
    assert.match(windows, /&\s+\$prep\s+host-prep\s+--check\s+--json/);
  });
}
