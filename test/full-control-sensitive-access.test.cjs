const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("full control cannot bypass the one-time sensitive-access confirmation", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  const start = source.indexOf("async function confirmLocalOperation");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  const sensitiveGuard = body.indexOf('request?.kind === "sensitive-access"');
  const fullControl = body.indexOf('localApprovalMode === "full_control"');
  assert.ok(sensitiveGuard >= 0, "sensitive access needs an explicit confirmation guard");
  assert.ok(fullControl >= 0);
  assert.ok(sensitiveGuard < fullControl, "sensitive access must be handled before full-control auto approval");
});
