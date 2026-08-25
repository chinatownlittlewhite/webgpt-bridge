const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer smoke replays failed task registration with bounded diagnostics", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "windows-installer-smoke.ps1"), "utf8");
  const installFailure = smoke.indexOf("silent NSIS installation failed");
  assert.ok(installFailure > 0, "smoke must retain an explicit silent-install failure branch");
  const diagnosticWindow = smoke.slice(Math.max(0, installFailure - 1800), installFailure + 500);

  assert.match(smoke, /\$installedTaskXml\s*=\s*Join-Path \$InstallRoot "resources\\windows-host-prep-task\.xml"/);
  assert.match(diagnosticWindow, /schtasks\.exe"\s+\/Create\s+\/TN\s+\$taskName\s+\/XML\s+\$installedTaskXml\s+\/F\s+2>&1/);
  assert.match(diagnosticWindow, /\$taskDiagnosticExit\s*=\s*\$LASTEXITCODE/);
  assert.match(diagnosticWindow, /Substring\(0,\s*4096\)/);
  assert.match(diagnosticWindow, /task registration diagnostic exit/);
});
