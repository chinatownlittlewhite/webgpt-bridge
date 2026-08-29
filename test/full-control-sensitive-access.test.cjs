const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("full control cannot bypass the one-time sensitive-access confirmation", () => {
  const windowsSource = fs.readFileSync(path.join(__dirname, "..", "src", "host", "host-security.cjs"), "utf8").replace(/\r?\n/g, "\r\n");
  const source = windowsSource.replace(/\r\n/g, "\n");
  const start = source.indexOf("async function confirmLocalOperation");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  const sensitiveGuard = body.indexOf('request?.kind === "sensitive-access"');
  const knownFolderGuard = body.indexOf('request?.kind === "known-folder-access"');
  const hostPathGuard = body.indexOf('request?.kind === "host-path-access"');
  const fullControl = body.indexOf('approvalMode === "full_control"');
  assert.ok(sensitiveGuard >= 0, "sensitive access needs an explicit confirmation guard");
  assert.ok(knownFolderGuard >= 0, "known-folder access needs an explicit confirmation guard");
  assert.ok(hostPathGuard >= 0, "ordinary Host access needs an explicit confirmation guard");
  assert.ok(fullControl >= 0);
  assert.ok(Math.max(sensitiveGuard, knownFolderGuard, hostPathGuard) < fullControl, "explicit Host boundaries must be handled before full-control auto approval");
});
