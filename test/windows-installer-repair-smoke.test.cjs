const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer lifecycle smoke exercises repair before uninstall", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "windows-installer-smoke.ps1"), "utf8");
  const uninstallerLookup = smoke.indexOf("$uninstaller = Get-ChildItem");
  assert.ok(uninstallerLookup > 0, "smoke must locate the uninstaller after install/repair checks");
  const beforeUninstall = smoke.slice(0, uninstallerLookup);
  const installerStarts = beforeUninstall.match(/Start-Process -FilePath \$installer\.FullName -ArgumentList @\("\/S", "\/D=\$InstallRoot"\) -Wait -PassThru/g) || [];

  assert.equal(installerStarts.length, 2, "smoke must run the same NSIS installer once for install and once for repair");
  assert.match(beforeUninstall, /\$repair\s*=\s*Start-Process -FilePath \$installer\.FullName/);
  assert.match(beforeUninstall, /silent NSIS repair installation failed/);
  assert.match(beforeUninstall, /post-repair host preparation is not ready/);
});
