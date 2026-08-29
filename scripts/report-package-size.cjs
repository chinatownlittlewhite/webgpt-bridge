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

function collectPackageSizes(rootPath) {
  const resources = path.join(rootPath, "Contents", "Resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const agentRuntime = path.join(unpacked, "agent-runtime");
  return {
    totalBytes: treeBytes(rootPath),
    frameworksBytes: treeBytes(path.join(rootPath, "Contents", "Frameworks")),
    resourcesBytes: treeBytes(resources),
    appAsarBytes: treeBytes(path.join(resources, "app.asar")),
    appAsarUnpackedBytes: treeBytes(unpacked),
    agentRuntimeBytes: treeBytes(agentRuntime),
    nodePtyBytes: treeBytes(path.join(agentRuntime, "node_modules", "node-pty")),
    tunnelClientBytes: treeBytes(path.join(resources, "tunnel-client")),
  };
}

if (require.main === module) {
  const rootPath = process.argv[2];
  if (!rootPath || !path.isAbsolute(rootPath)) throw new Error("Usage: node scripts/report-package-size.cjs <absolute-app-root>");
  process.stdout.write(`${JSON.stringify(collectPackageSizes(rootPath), null, 2)}\n`);
}

module.exports = { collectPackageSizes, treeBytes };
