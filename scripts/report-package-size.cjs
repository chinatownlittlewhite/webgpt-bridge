const fs = require("node:fs");
const path = require("node:path");

function treeBytes(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return fs.readdirSync(target).sort().reduce((sum, name) => sum + treeBytes(path.join(target, name)), 0);
}

function resolveLayout(rootPath, platform) {
  const normalizedPlatform = platform || (fs.statSync(path.join(rootPath, "Contents", "Resources"), { throwIfNoEntry: false })?.isDirectory() ? "darwin" : "win32");
  if (normalizedPlatform === "darwin") {
    return {
      platform: normalizedPlatform,
      resourcesRoot: path.join(rootPath, "Contents", "Resources"),
      frameworksRoot: path.join(rootPath, "Contents", "Frameworks"),
    };
  }
  if (normalizedPlatform === "win32") {
    return {
      platform: normalizedPlatform,
      resourcesRoot: path.join(rootPath, "resources"),
      frameworksRoot: null,
    };
  }
  throw new Error(`unsupported package platform: ${normalizedPlatform}`);
}

function collectPackageSizes(rootPath, { platform } = {}) {
  if (!rootPath || !path.isAbsolute(rootPath)) throw new Error("package root must be an absolute path");
  const layout = resolveLayout(rootPath, platform);
  const unpackedRoot = path.join(layout.resourcesRoot, "app.asar.unpacked");
  const agentRuntimeRoot = path.join(unpackedRoot, "agent-runtime");
  return {
    totalBytes: treeBytes(rootPath),
    frameworksBytes: layout.frameworksRoot ? treeBytes(layout.frameworksRoot) : 0,
    resourcesBytes: treeBytes(layout.resourcesRoot),
    appAsarBytes: treeBytes(path.join(layout.resourcesRoot, "app.asar")),
    appAsarUnpackedBytes: treeBytes(unpackedRoot),
    agentRuntimeBytes: treeBytes(agentRuntimeRoot),
    nodePtyBytes: treeBytes(path.join(agentRuntimeRoot, "node_modules", "node-pty")),
    agentNativeBytes: treeBytes(path.join(agentRuntimeRoot, "native")),
    tunnelClientBytes: treeBytes(path.join(layout.resourcesRoot, "tunnel-client")),
    windowsNodeRuntimeBytes: layout.platform === "win32" ? treeBytes(path.join(layout.resourcesRoot, "node-runtime")) : 0,
  };
}

if (require.main === module) {
  const rootPath = process.argv[2];
  const platformArg = process.argv[3] || undefined;
  if (!rootPath || !path.isAbsolute(rootPath)) {
    throw new Error("Usage: node scripts/report-package-size.cjs <absolute-app-root> [darwin|win32]");
  }
  process.stdout.write(`${JSON.stringify(collectPackageSizes(rootPath, { platform: platformArg }), null, 2)}\n`);
}

module.exports = { collectPackageSizes, resolveLayout, treeBytes };
