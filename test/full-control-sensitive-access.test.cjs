const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("full control short-circuits Bridge confirmation prompts for Host access", () => {
  const windowsSource = fs.readFileSync(path.join(__dirname, "..", "src", "host", "host-security.cjs"), "utf8").replace(/\r?\n/g, "\r\n");
  const source = windowsSource.replace(/\r\n/g, "\n");
  const start = source.indexOf("async function confirmLocalOperation");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  const fullControl = body.indexOf('approvalMode === "full_control"');
  const prompt = body.indexOf("approvalPrompt(request, approvalMode)");
  assert.ok(fullControl >= 0);
  assert.ok(prompt >= 0);
  assert.ok(fullControl < prompt, "full_control must return before any Bridge permission prompt is built");
  assert.doesNotMatch(body, /explicitConsent/, "full_control must not retain a hidden prompt-only Host access exception");
});
