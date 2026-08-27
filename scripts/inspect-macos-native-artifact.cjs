const path = require("node:path");
const { inspectPackagedNodePtyMacPayload } = require("./node-pty-macos-payload.cjs");

function verifyMacNativeArtifact(appRoot) {
  return inspectPackagedNodePtyMacPayload(appRoot);
}

if (require.main === module) {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error("Usage: node scripts/inspect-macos-native-artifact.cjs <path-to-app>");
    process.exit(2);
  }
  try {
    const result = verifyMacNativeArtifact(path.resolve(appRoot));
    const originalModes = result.helpers
      .map((item) => `${path.basename(path.dirname(item.path))}:${item.mode.toString(8)}`)
      .join(", ");
    const shortModes = result.shortHelpers
      .map((item) => `${path.basename(path.dirname(item.path))}:${item.mode.toString(8)}`)
      .join(", ");
    console.log(`macOS native PTY artifact OK (original=${originalModes}; short=${shortModes})`);
  } catch (error) {
    console.error(`${error.code || "NATIVE_PTY_PAYLOAD_INVALID"}: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verifyMacNativeArtifact };
