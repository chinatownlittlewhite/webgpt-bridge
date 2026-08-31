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

test("desktop workflows gate package upload on size reports and budget checks", () => {
  for (const name of ["build-desktop.yml", "release-desktop.yml"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");
    const size = source.indexOf("package-size-budget.cjs");
    const upload = source.indexOf("actions/upload-artifact@v4", Math.max(0, size));
    assert.ok(size >= 0, `${name} must run the package-size budget gate`);
    assert.ok(upload > size, `${name} must gate artifact upload on package-size budget`);
    assert.match(source, /package-size-mac-arm64\.json/);
    assert.match(source, /package-size-mac-x64\.json/);
    assert.match(source, /package-size-mac-universal\.json/);
    assert.match(source, /package-size-win-x64\.json/);
  }
});
