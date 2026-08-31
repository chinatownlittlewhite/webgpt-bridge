const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("ordinary Desktop verification automatically includes every v0.5 UI and diagnostics contract", () => {
  const verifier = read("scripts/verify-desktop.cjs");
  assert.match(verifier, /readdirSync\(testDir\)/);
  assert.match(verifier, /endsWith\(["']\.test\.cjs["']\)/);
  assert.match(verifier, /--test/);

  for (const name of [
    "renderer-ui.test.cjs",
    "renderer-layout.test.cjs",
    "capabilities-aggregate-health.test.cjs",
    "capabilities-error-taxonomy.test.cjs",
    "renderer-capability-boundary.test.cjs",
    "capabilities-github-async.test.cjs",
    "capabilities-github-worker.test.cjs",
    "logs-cursor.test.cjs",
    "renderer-incremental-logs.test.cjs",
  ]) {
    assert.equal(fs.existsSync(path.join(root, "test", name)), true, `${name} must be in the normal Desktop test directory`);
  }
});

test("distribution commands retain Desktop Agent and package-size acceptance gates", () => {
  const pkg = JSON.parse(read("package.json"));
  const macBuilder = read("scripts/build-macos-variants.cjs");

  assert.match(pkg.scripts["dist:mac"], /verify:desktop/);
  assert.match(pkg.scripts["dist:mac"], /agent-runtime run acceptance/);
  assert.match(pkg.scripts["dist:mac"], /build-macos-variants\.cjs/);
  assert.match(macBuilder, /verifyMacPackages/);
  assert.match(macBuilder, /runMacDistribution/);
  assert.match(pkg.scripts["dist:win"], /verify:desktop/);
  assert.match(pkg.scripts["dist:win"], /agent-runtime run acceptance/);
  assert.match(pkg.scripts["dist:win"], /verify:package-sizes:win/);
});

test("permanent workflows retain three macOS variants Windows native and release validation", () => {
  const build = read(".github/workflows/build-desktop.yml");
  const release = read(".github/workflows/release-desktop.yml");
  const combined = `${build}\n${release}`;

  for (const variant of ["mac-arm64", "mac-x64", "mac-universal"]) assert.match(combined, new RegExp(variant));
  assert.match(build, /npm run dist:mac/);
  assert.match(build, /npm run dist:win/);
  assert.match(release, /npm run dist:mac/);
  assert.match(release, /npm run dist:win/);
  assert.match(combined, /verify:mac-native-artifact/);
  assert.match(combined, /verify:mac-packaged-pty/);
  assert.match(release, /scripts\/validate-release-assets\.cjs/);
  assert.match(release, /latest-mac\.yml/);
});
