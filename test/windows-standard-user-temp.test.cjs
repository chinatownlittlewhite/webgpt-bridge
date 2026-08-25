const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function readWindowsJob(file, nextJob) {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", file), "utf8");
  const start = workflow.indexOf("  windows:");
  assert.ok(start >= 0, `${file} must define a Windows job`);
  const end = nextJob ? workflow.indexOf(nextJob, start) : -1;
  return workflow.slice(start, end >= 0 ? end : undefined);
}

for (const [name, windows] of [
  ["PR CI", readWindowsJob("build-desktop.yml")],
  ["formal release", readWindowsJob("release-desktop.yml", "\n  macos:")],
]) {
  test(`${name} standard-user Windows acceptance uses a workspace-owned temp`, () => {
    assert.match(windows, /\$acceptanceTemp\s*=\s*Join-Path\s+\$env:GITHUB_WORKSPACE\s+"\.ci-windows-standard-user-temp"/);
    assert.match(windows, /New-Item\s+-ItemType\s+Directory\s+-Path\s+\$acceptanceTemp\s+-Force/);
    assert.match(windows, /\$previousTemp\s*=\s*\$env:TEMP/);
    assert.match(windows, /\$previousTmp\s*=\s*\$env:TMP/);
    assert.match(windows, /\$env:TEMP\s*=\s*\$acceptanceTemp/);
    assert.match(windows, /\$env:TMP\s*=\s*\$acceptanceTemp/);

    const tempSet = windows.indexOf("$env:TEMP = $acceptanceTemp");
    const processStart = windows.indexOf("$process = Start-Process");
    assert.ok(tempSet >= 0 && processStart > tempSet, "TEMP/TMP must be set before the credentialed acceptance process starts");

    const cleanup = windows.slice(windows.indexOf("finally {"));
    assert.match(cleanup, /\$env:TEMP\s*=\s*\$previousTemp/);
    assert.match(cleanup, /\$env:TMP\s*=\s*\$previousTmp/);
    assert.match(cleanup, /Remove-Item\s+-LiteralPath\s+\$acceptanceTemp\s+-Recurse\s+-Force/);
    assert.match(cleanup, /Remove-LocalUser/);

    assert.doesNotMatch(windows, /icacls\.exe[^\n]*(?:System32|Program Files)/i, "standard-user acceptance must not rewrite shared executable ACLs");
  });
}
