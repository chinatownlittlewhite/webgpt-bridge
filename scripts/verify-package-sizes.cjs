const fs = require("node:fs");
const path = require("node:path");
const { collectPackageSizes } = require("./report-package-size.cjs");
const { evaluateSizeBudget } = require("./package-size-budget.cjs");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_ROOT = path.join(ROOT, "release");
const BASELINE_PATH = path.join(ROOT, "build", "package-size-baseline.json");

function findNamedDirectories(root, targetName) {
  const found = [];
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.name === targetName) found.push(child);
    else found.push(...findNamedDirectories(child, targetName));
  }
  return found;
}

function macVariantForApp(appRoot) {
  const parent = path.basename(path.dirname(appRoot));
  if (parent === "mac-arm64") return "mac-arm64";
  if (parent === "mac-universal") return "mac-universal";
  if (parent === "mac") return "mac-x64";
  throw new Error(`unrecognized electron-builder macOS app output: ${appRoot}`);
}

function loadBaseline() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  if (baseline.schemaVersion !== 1 || !baseline.variants || typeof baseline.variants !== "object") {
    throw new Error("package-size-baseline.json schemaVersion 1 is required");
  }
  return baseline;
}

function verifyOne({ appRoot, platform, variant, baselineDocument }) {
  const baseline = baselineDocument.variants[variant];
  if (!baseline) throw new Error(`package size baseline missing variant: ${variant}`);
  const report = collectPackageSizes(appRoot, { platform });
  const reportPath = path.join(RELEASE_ROOT, `package-size-${variant}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const policy = baselineDocument.policy || {};
  const result = evaluateSizeBudget({
    current: report,
    baseline,
    maxGrowthRatio: policy.maxGrowthRatio,
    maxGrowthBytes: policy.maxGrowthBytes,
  });
  if (!result.ok) {
    const detail = result.failures
      .map((failure) => `${failure.metric}: ${failure.currentBytes} > ${failure.limitBytes} (baseline ${failure.baselineBytes})`)
      .join("; ");
    throw new Error(`package size budget exceeded for ${variant}: ${detail}`);
  }
  console.log(JSON.stringify({ variant, reportPath, previousFormalRelease: baselineDocument.previousFormalRelease, ...report }));
  return { variant, reportPath, report, result };
}

function verifyMacPackages({ releaseRoot = RELEASE_ROOT, baselineDocument = loadBaseline() } = {}) {
  const apps = findNamedDirectories(releaseRoot, "WebGPT Bridge.app");
  const byVariant = new Map();
  for (const appRoot of apps) {
    const variant = macVariantForApp(appRoot);
    if (byVariant.has(variant)) throw new Error(`duplicate staged macOS app for ${variant}`);
    byVariant.set(variant, appRoot);
  }
  const expected = ["mac-arm64", "mac-x64", "mac-universal"];
  for (const variant of expected) {
    if (!byVariant.has(variant)) throw new Error(`missing staged macOS app for ${variant}`);
  }
  if (byVariant.size !== expected.length) throw new Error(`unexpected staged macOS package variants: ${[...byVariant.keys()].join(", ")}`);
  return expected.map((variant) => verifyOne({
    appRoot: byVariant.get(variant),
    platform: "darwin",
    variant,
    baselineDocument,
  }));
}

function verifyWindowsPackage({ releaseRoot = RELEASE_ROOT, baselineDocument = loadBaseline() } = {}) {
  const appRoot = path.join(releaseRoot, "win-unpacked");
  if (!fs.statSync(appRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`missing staged Windows app: ${appRoot}`);
  }
  return verifyOne({ appRoot, platform: "win32", variant: "win-x64", baselineDocument });
}

if (require.main === module) {
  const target = process.argv[2];
  if (target === "macos") verifyMacPackages();
  else if (target === "windows") verifyWindowsPackage();
  else throw new Error("Usage: node scripts/verify-package-sizes.cjs <macos|windows>");
}

module.exports = {
  findNamedDirectories,
  macVariantForApp,
  verifyMacPackages,
  verifyOne,
  verifyWindowsPackage,
};
