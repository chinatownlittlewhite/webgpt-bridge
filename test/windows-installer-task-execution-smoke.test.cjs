const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer smoke validates and executes the environment-backed SYSTEM task action", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "windows-installer-smoke.ps1"), "utf8");

  assert.match(smoke, /\$taskExecuteRaw\s*=\s*\(\[string\]\$taskActions\[0\]\.Execute\)\.Trim/);
  assert.match(smoke, /\[Environment\]::ExpandEnvironmentVariables\(\$taskExecuteRaw\)/);
  assert.match(smoke, /scheduled-task execution precondition[\s\S]*capability_ace_missing/);
  assert.match(smoke, /Start-ScheduledTask\s+-TaskName\s+\$taskName/);
  assert.match(smoke, /scheduled task did not restore host preparation to ready/);
});
