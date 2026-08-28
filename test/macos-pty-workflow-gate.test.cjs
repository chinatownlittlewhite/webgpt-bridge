const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// This contract intentionally lands before the workflow wiring so CI records the RED gate.
function workflow(name) {
  return fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");
}

function assertMacPtyGate(source, label) {
  const dist = source.indexOf("npm run dist:mac");
  const inspector = source.indexOf('npm run verify:mac-native-artifact -- "$APP"', dist);
  const smoke = source.indexOf('npm run verify:mac-packaged-pty -- "$APP"', dist);
  const upload = source.indexOf("actions/upload-artifact@v4", dist);
  assert.ok(dist >= 0, `${label} must build the macOS artifact`);
  assert.ok(inspector > dist, `${label} must inspect the final staged app after dist:mac`);
  assert.ok(smoke > inspector, `${label} must run packaged PTY smoke after final inspection`);
  assert.ok(upload > smoke, `${label} must not upload the macOS artifact before PTY gates pass`);
}

test("PR build gates macOS artifact upload on final PTY inspection and packaged smoke", () => {
  assertMacPtyGate(workflow("build-desktop.yml"), "Build desktop apps");
});

test("formal release gates macOS artifact upload on final PTY inspection and packaged smoke", () => {
  assertMacPtyGate(workflow("release-desktop.yml"), "Release desktop apps");
});
