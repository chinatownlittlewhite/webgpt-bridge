const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_METRICS = Object.freeze([
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
]);

const DEFAULT_MAX_GROWTH_RATIO = 0.05;
const DEFAULT_MAX_GROWTH_BYTES = 5 * 1024 * 1024;

function requireReport(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error(`${label} size report must be an object`);
  for (const metric of REQUIRED_METRICS) {
    const value = report[metric];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}.${metric} must be a non-negative safe integer`);
  }
}

function evaluateSizeBudget({
  current,
  baseline,
  maxGrowthRatio = DEFAULT_MAX_GROWTH_RATIO,
  maxGrowthBytes = DEFAULT_MAX_GROWTH_BYTES,
} = {}) {
  requireReport(current, "current");
  requireReport(baseline, "baseline");
  if (!Number.isFinite(maxGrowthRatio) || maxGrowthRatio < 0) throw new Error("maxGrowthRatio must be a non-negative number");
  if (!Number.isSafeInteger(maxGrowthBytes) || maxGrowthBytes < 0) throw new Error("maxGrowthBytes must be a non-negative safe integer");

  const components = {};
  const failures = [];
  for (const metric of REQUIRED_METRICS) {
    const baselineBytes = baseline[metric];
    const currentBytes = current[metric];
    const allowanceBytes = Math.max(maxGrowthBytes, Math.ceil(baselineBytes * maxGrowthRatio));
    const limitBytes = baselineBytes + allowanceBytes;
    const component = {
      baselineBytes,
      currentBytes,
      deltaBytes: currentBytes - baselineBytes,
      allowanceBytes,
      limitBytes,
      ok: currentBytes <= limitBytes,
    };
    components[metric] = component;
    if (!component.ok) failures.push({ metric, ...component });
  }
  return { ok: failures.length === 0, components, failures };
}

function readJson(filePath, label) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function runCli() {
  const currentPath = path.resolve(argument("--current") || "");
  const baselinePath = path.resolve(argument("--baseline") || "");
  const variant = argument("--variant");
  if (!argument("--current") || !argument("--baseline") || !variant) {
    throw new Error("Usage: node scripts/package-size-budget.cjs --current <report.json> --baseline <baseline.json> --variant <name>");
  }
  const current = readJson(currentPath, "current");
  const baselineDocument = readJson(baselinePath, "baseline");
  if (baselineDocument.schemaVersion !== 1 || !baselineDocument.variants || typeof baselineDocument.variants !== "object") {
    throw new Error("package size baseline schemaVersion 1 with variants is required");
  }
  const baseline = baselineDocument.variants[variant];
  if (!baseline) throw new Error(`package size baseline missing variant: ${variant}`);
  const policy = baselineDocument.policy || {};
  const result = evaluateSizeBudget({
    current,
    baseline,
    maxGrowthRatio: policy.maxGrowthRatio ?? DEFAULT_MAX_GROWTH_RATIO,
    maxGrowthBytes: policy.maxGrowthBytes ?? DEFAULT_MAX_GROWTH_BYTES,
  });
  process.stdout.write(`${JSON.stringify({ variant, previousFormalRelease: baselineDocument.previousFormalRelease, ...result }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
  DEFAULT_MAX_GROWTH_BYTES,
  DEFAULT_MAX_GROWTH_RATIO,
  REQUIRED_METRICS,
  evaluateSizeBudget,
  requireReport,
};
