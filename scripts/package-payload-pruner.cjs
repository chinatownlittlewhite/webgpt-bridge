const fs = require("node:fs");
const path = require("node:path");

const ERROR_CODE = "PACKAGE_PAYLOAD_INVALID";
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);
const SUPPORTED_DARWIN_ARCHES = new Set(["arm64", "x64", "universal"]);
const DARWIN_PTY_PREBUILDS = Object.freeze({
  arm64: new Set(["darwin-arm64"]),
  x64: new Set(["darwin-x64"]),
  universal: new Set(["darwin-arm64", "darwin-x64"]),
});
const WINDOWS_X64_PTY_PREBUILDS = new Set(["win32-x64"]);

function invalid(message) {
  const error = new Error(message);
  error.code = ERROR_CODE;
  return error;
}

function assertDirectory(target, label) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw invalid(`missing ${label}: ${target}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw invalid(`${label} must be a real directory: ${target}`);
  }
}

function assertDescendant(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalid(`package prune target escapes Agent runtime: ${target}`);
  }
  return relative.split(path.sep).join("/");
}

function treeBytesNoFollow(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const name of fs.readdirSync(target)) {
    total += treeBytesNoFollow(path.join(target, name));
  }
  return total;
}

function prunePackagedAgentRuntime({ resourcesRoot, platform, arch }) {
  if (!resourcesRoot || !path.isAbsolute(resourcesRoot)) {
    throw invalid("packaged resources root must be an absolute path");
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw invalid(`unsupported packaged platform: ${platform}`);
  }
  if (platform === "darwin" && !SUPPORTED_DARWIN_ARCHES.has(arch)) {
    throw invalid(`unsupported macOS packaged architecture: ${arch}`);
  }
  if (platform === "win32" && arch !== "x64") {
    throw invalid(`unsupported Windows packaged architecture: ${arch}`);
  }

  const agentRoot = path.join(resourcesRoot, "app.asar.unpacked", "agent-runtime");
  assertDirectory(agentRoot, "packaged Agent runtime");

  const removedPaths = [];
  let removedBytes = 0;

  function removeKnown(relative) {
    const target = path.join(agentRoot, ...relative.split("/"));
    const normalized = assertDescendant(agentRoot, target);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    removedBytes += treeBytesNoFollow(target);
    fs.rmSync(target, { recursive: true, force: true });
    removedPaths.push(normalized);
  }

  removeKnown("node_modules/@modelcontextprotocol/client");
  removeKnown("node_modules/zod/src/v3/tests");
  removeKnown("node_modules/zod/src/v4/classic/tests");
  removeKnown("node_modules/zod/src/v4/core/tests");
  removeKnown("node_modules/zod/src/v4/mini/tests");
  removeKnown("node_modules/isexe/test");
  removeKnown("node_modules/node-pty/deps");
  removeKnown("node_modules/node-pty/third_party");
  removeKnown("node_modules/node-pty/src");
  removeKnown("node_modules/node-pty/scripts");
  removeKnown("node_modules/node-pty/binding.gyp");

  if (platform === "darwin") {
    removeKnown("native/windows-host");
  }

  const prebuildsRoot = path.join(agentRoot, "node_modules", "node-pty", "prebuilds");
  const retainedPrebuilds = platform === "darwin" ? DARWIN_PTY_PREBUILDS[arch] : WINDOWS_X64_PTY_PREBUILDS;
  const prebuildsStat = fs.lstatSync(prebuildsRoot, { throwIfNoEntry: false });
  if (prebuildsStat?.isDirectory() && !prebuildsStat.isSymbolicLink()) {
    for (const name of fs.readdirSync(prebuildsRoot).sort()) {
      if (!retainedPrebuilds.has(name)) removeKnown(`node_modules/node-pty/prebuilds/${name}`);
    }
  }

  const nodeModulesRoot = path.join(agentRoot, "node_modules");
  const nodeModulesStat = fs.lstatSync(nodeModulesRoot, { throwIfNoEntry: false });
  if (nodeModulesStat?.isDirectory() && !nodeModulesStat.isSymbolicLink()) {
    const stack = [nodeModulesRoot];
    while (stack.length > 0) {
      const directory = stack.pop();
      for (const name of fs.readdirSync(directory).sort().reverse()) {
        const target = path.join(directory, name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          stack.push(target);
          continue;
        }
        if (!stat.isFile()) continue;
        if (!name.endsWith(".map") && !name.endsWith(".test.js")) continue;
        const relative = assertDescendant(agentRoot, target);
        removedBytes += stat.size;
        fs.rmSync(target, { force: true });
        removedPaths.push(relative);
      }
    }
  }

  removedPaths.sort();
  return Object.freeze({
    removedBytes,
    removedPaths: Object.freeze(removedPaths),
  });
}

module.exports = { prunePackagedAgentRuntime };
