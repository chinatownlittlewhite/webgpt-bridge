const fs = require("node:fs");
const path = require("node:path");

const DARWIN_ARCHES = Object.freeze(["darwin-arm64", "darwin-x64"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "NATIVE_PTY_PAYLOAD_INVALID";
  return error;
}

function payloadRoot(appRoot) {
  if (!appRoot || !path.isAbsolute(appRoot)) throw invalid("macOS app root must be an absolute path");
  return path.join(
    appRoot,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
}

function assertRegularFile(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalid(`${label} escapes the node-pty prebuild root`);
  }
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    throw invalid(`missing ${label}: ${candidate}`);
  }
  if (!stat.isFile()) throw invalid(`${label} must be a regular file: ${candidate}`);
  return Object.freeze({ path: candidate, mode: stat.mode & 0o777, size: stat.size });
}

function inspectNodePtyMacPayload(appRoot) {
  const root = payloadRoot(path.resolve(appRoot));
  const helpers = [];
  const nativeModules = [];
  for (const arch of DARWIN_ARCHES) {
    const archRoot = path.join(root, arch);
    helpers.push(assertRegularFile(root, path.join(archRoot, "spawn-helper"), `${arch} spawn-helper`));
    nativeModules.push(assertRegularFile(root, path.join(archRoot, "pty.node"), `${arch} pty.node`));
  }
  return Object.freeze({
    root,
    helpers: Object.freeze(helpers),
    nativeModules: Object.freeze(nativeModules),
  });
}

function normalizeNodePtyMacPayload(appRoot) {
  const before = inspectNodePtyMacPayload(appRoot);
  for (const helper of before.helpers) {
    const nextMode = helper.mode | 0o111;
    if (nextMode !== helper.mode) fs.chmodSync(helper.path, nextMode);
  }
  const after = inspectNodePtyMacPayload(appRoot);
  for (const helper of after.helpers) {
    if ((helper.mode & 0o111) !== 0o111) {
      throw invalid(`spawn-helper is not executable after normalization: ${helper.path}`);
    }
  }
  return after;
}

module.exports = {
  DARWIN_ARCHES,
  inspectNodePtyMacPayload,
  normalizeNodePtyMacPayload,
};
