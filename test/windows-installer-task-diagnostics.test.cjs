const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer preserves scheduled-task registration diagnostics", () => {
  const installer = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  const customInstallStart = installer.indexOf("!macro customInstall");
  const customInstallEnd = installer.indexOf("!macroend", customInstallStart);
  assert.ok(customInstallStart >= 0 && customInstallEnd > customInstallStart);
  const customInstall = installer.slice(customInstallStart, customInstallEnd);

  assert.match(customInstall, /nsExec::ExecToStack[\s\S]*schtasks\.exe[\s\S]*\/Create[\s\S]*\/XML/);
  assert.match(customInstall, /Pop\s+\$1[\s\S]*Pop\s+\$2/);
  assert.match(customInstall, /Unable to register WebGPT Bridge Windows host preparation task \(exit \$1\): \$2/);
  assert.doesNotMatch(customInstall, /\/TR\s/);
  assert.doesNotMatch(customInstall, /ExecWait[\s\S]*schtasks\.exe[\s\S]*\/Create/);
});
