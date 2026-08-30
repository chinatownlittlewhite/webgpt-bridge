const fs = require("node:fs");
const path = require("node:path");
const {
  DARWIN_ARCHES,
  darwinArchesForVariant,
  inspectPackagedNodePtyMacPayload,
  normalizeMacPackageVariant,
} = require("./node-pty-macos-payload.cjs");

function assertExactDarwinDirectories(root, expectedArches, label) {
  const expected = new Set(expectedArches);
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    const error = new Error(`${label} must be a real directory: ${root}`);
    error.code = "NATIVE_PTY_PAYLOAD_INVALID";
    throw error;
  }
  for (const arch of DARWIN_ARCHES) {
    const present = fs.lstatSync(path.join(root, arch), { throwIfNoEntry: false });
    if (expected.has(arch) && !present?.isDirectory()) {
      const error = new Error(`missing ${label} architecture: ${arch}`);
      error.code = "NATIVE_PTY_PAYLOAD_INVALID";
      throw error;
    }
    if (!expected.has(arch) && present) {
      const error = new Error(`unexpected ${label} architecture for selected macOS package variant: ${arch}`);
      error.code = "NATIVE_PTY_PAYLOAD_INVALID";
      throw error;
    }
  }
}

function verifyMacNativeArtifact(appRoot, variant = "universal") {
  const normalizedVariant = normalizeMacPackageVariant(variant);
  const result = inspectPackagedNodePtyMacPayload(appRoot, { variant: normalizedVariant });
  const expectedArches = darwinArchesForVariant(normalizedVariant);
  assertExactDarwinDirectories(result.root, expectedArches, "node-pty prebuild");
  assertExactDarwinDirectories(result.shortHelperRoot, expectedArches, "short helper");
  return result;
}

if (require.main === module) {
  const appRoot = process.argv[2];
  const variant = process.argv[3] || "universal";
  if (!appRoot) {
    console.error("Usage: node scripts/inspect-macos-native-artifact.cjs <path-to-app> [arm64|x64|universal]");
    process.exit(2);
  }
  try {
    const result = verifyMacNativeArtifact(path.resolve(appRoot), variant);
    const originalModes = result.helpers
      .map((item) => `${path.basename(path.dirname(item.path))}:${item.mode.toString(8)}`)
      .join(", ");
    const shortModes = result.shortHelpers
      .map((item) => `${path.basename(path.dirname(item.path))}:${item.mode.toString(8)}`)
      .join(", ");
    console.log(`macOS ${result.variant} native PTY artifact OK (original=${originalModes}; short=${shortModes})`);
  } catch (error) {
    console.error(`${error.code || "NATIVE_PTY_PAYLOAD_INVALID"}: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verifyMacNativeArtifact };
