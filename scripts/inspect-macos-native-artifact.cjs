const path = require("node:path");
const { inspectNodePtyMacPayload } = require("./node-pty-macos-payload.cjs");

function invalid(message) {
  const error = new Error(message);
  error.code = "NATIVE_PTY_PAYLOAD_INVALID";
  return error;
}

function verifyMacNativeArtifact(appRoot) {
  const inspected = inspectNodePtyMacPayload(appRoot);
  for (const helper of inspected.helpers) {
    if ((helper.mode & 0o111) !== 0o111) {
      throw invalid(`final macOS artifact spawn-helper is not executable: ${helper.path}`);
    }
  }
  return inspected;
}

if (require.main === module) {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error("Usage: node scripts/inspect-macos-native-artifact.cjs <path-to-app>");
    process.exit(2);
  }
  try {
    const result = verifyMacNativeArtifact(path.resolve(appRoot));
    const modes = result.helpers
      .map((item) => `${path.basename(path.dirname(item.path))}:${item.mode.toString(8)}`)
      .join(", ");
    console.log(`macOS native PTY artifact OK (${modes})`);
  } catch (error) {
    console.error(`${error.code || "NATIVE_PTY_PAYLOAD_INVALID"}: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verifyMacNativeArtifact };
