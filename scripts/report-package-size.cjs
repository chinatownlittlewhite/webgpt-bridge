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
  return {
    totalBytes: treeBytes(rootPath),
    frameworksBytes: treeBytes(path.join(rootPath, "Contents", "Frameworks")),
    resourcesBytes: treeBytes(path.join(rootPath, "Contents", "Resources")),
    appAsarBytes: treeBytes(path.join(rootPath, "Contents", "Resources", "app.asar")),
    appAsarUnpackedBytes: treeBytes(path.join(rootPath, "Contents", "Resources", "app.asar.unpacked")),
    tunnelClientBytes: treeBytes(path.join(rootPath, "Contents", "Resources", "tunnel-client")),
  };
}

if (require.main === module) {
  const rootPath = process.argv[2];
  if (!rootPath || !path.isAbsolute(rootPath)) throw new Error("Usage: node scripts/report-package-size.cjs <absolute-app-root>");
  process.stdout.write(`${JSON.stringify(collectPackageSizes(rootPath), null, 2)}\n`);
}

module.exports = { collectPackageSizes, treeBytes };
