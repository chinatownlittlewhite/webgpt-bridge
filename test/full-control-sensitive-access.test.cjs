const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("full control cannot bypass explicit Host consent boundaries", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "host", "host-security.cjs"), "utf8");
  const explicitConsent = source.indexOf("const explicitConsent =");
  const sensitiveGuard = source.indexOf('request?.kind === "sensitive-access"', explicitConsent);
  const knownFolderGuard = source.indexOf('request?.kind === "known-folder-access"', explicitConsent);
  const hostPathGuard = source.indexOf('request?.kind === "host-path-access"', explicitConsent);
  const fullControl = source.indexOf('if (!explicitConsent && approvalMode === "full_control")', explicitConsent);

  assert.ok(explicitConsent >= 0, "explicit Host consent must be classified before approval presets");
  assert.ok(sensitiveGuard >= 0, "sensitive access needs an explicit confirmation guard");
  assert.ok(knownFolderGuard >= 0, "known-folder access needs an explicit confirmation guard");
  assert.ok(hostPathGuard >= 0, "ordinary Host access needs an explicit confirmation guard");
  assert.ok(fullControl >= 0, "full control may auto-approve only non-explicit consent requests");
  assert.ok(
    Math.max(sensitiveGuard, knownFolderGuard, hostPathGuard) < fullControl,
    "explicit Host boundaries must be classified before full-control auto approval",
  );
});
