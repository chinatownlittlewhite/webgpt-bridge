const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REQUIRED_METRICS = [
  "totalBytes",
  "frameworksBytes",
  "resourcesBytes",
  "appAsarBytes",
  "appAsarUnpackedBytes",
  "agentRuntimeBytes",
  "nodePtyBytes",
  "agentNativeBytes",
  "tunnelClientBytes",
  "windowsNodeRuntimeBytes",
];

function report(value = 1_000_000) {
  return Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, value]));
}

test("size budget allows bounded change and reports every component delta", () => {
  const { evaluateSizeBudget } = require("../scripts/package-size-budget.cjs");
  const baseline = report();
  const current = report(1_040_000);
  const result = evaluateSizeBudget({ current, baseline, maxGrowthRatio: 0.05, maxGrowthBytes: 20_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.components), REQUIRED_METRICS);
  assert.equal(result.components.totalBytes.deltaBytes, 40_000);
  assert.equal(result.components.totalBytes.limitBytes, 1_050_000);
});

test("size budget fails material component growth even when total remains within its own limit", () => {
  const { evaluateSizeBudget } = require("../scripts/package-size-budget.cjs");
  const baseline = report();
  const current = report();
  current.nodePtyBytes = 1_080_000;
  const result = evaluateSizeBudget({ current, baseline, maxGrowthRatio: 0.05, maxGrowthBytes: 20_000 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((failure) => failure.metric), ["nodePtyBytes"]);
});

test("size budget fails closed on missing or invalid metrics", () => {
  const { evaluateSizeBudget } = require("../scripts/package-size-budget.cjs");
  const baseline = report();
  const missing = report();
  delete missing.agentRuntimeBytes;
  assert.throws(() => evaluateSizeBudget({ current: missing, baseline }), /agentRuntimeBytes/);
  const invalid = report();
  invalid.totalBytes = -1;
  assert.throws(() => evaluateSizeBudget({ current: invalid, baseline }), /totalBytes/);
});

test("committed size baseline names the previous formal release and covers all package variants", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "package-size-baseline.json"), "utf8"));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.previousFormalRelease, "v0.4.11");
  assert.deepEqual(Object.keys(baseline.variants).sort(), ["mac-arm64", "mac-universal", "mac-x64", "win-x64"]);
  for (const variant of Object.values(baseline.variants)) {
    for (const metric of REQUIRED_METRICS) assert.equal(Number.isSafeInteger(variant[metric]), true, metric);
  }
});

test("dist commands gate workflow uploads through the shared package-size verifier", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(pkg.scripts["dist:mac"], /verify:package-sizes:mac/);
  assert.match(pkg.scripts["dist:win"], /verify:package-sizes:win/);
  assert.match(pkg.scripts["verify:package-sizes:mac"], /verify-package-sizes\.cjs macos/);
  assert.match(pkg.scripts["verify:package-sizes:win"], /verify-package-sizes\.cjs windows/);

  const verifier = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-package-sizes.cjs"), "utf8");
  assert.match(verifier, /package-size-budget\.cjs/);
  assert.match(verifier, /package-size-\$\{variant\}\.json/);

  for (const name of ["build-desktop.yml", "release-desktop.yml"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");
    const macDist = source.indexOf("npm run dist:mac");
    const winDist = source.indexOf("npm run dist:win");
    const macUpload = source.indexOf("actions/upload-artifact@v4", macDist);
    const winUpload = source.indexOf("actions/upload-artifact@v4", winDist);
    assert.ok(macDist >= 0 && macUpload > macDist, `${name} must upload macOS only after dist:mac size gate`);
    assert.ok(winDist >= 0 && winUpload > winDist, `${name} must upload Windows only after dist:win size gate`);
  }
});
