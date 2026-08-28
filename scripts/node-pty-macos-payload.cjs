const fs = require("node:fs");
const path = require("node:path");

const DARWIN_ARCHES = Object.freeze(["darwin-arm64", "darwin-x64"]);
const SHORT_HELPER_DIR = "node-pty-helper";
const SHORT_HELPER_PATCH_MARKER = "webgpt-bridge:darwin-short-spawn-helper";
const UNIX_TERMINAL_ANCHOR = "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";

function invalid(message) {
  const error = new Error(message);
  error.code = "NATIVE_PTY_PAYLOAD_INVALID";
  return error;
}

function resourcesRoot(appRoot) {
  if (!appRoot || !path.isAbsolute(appRoot)) throw invalid("macOS app root must be an absolute path");
  return path.join(path.resolve(appRoot), "Contents", "Resources");
}

function nodePtyRoot(appRoot) {
  return path.join(
    resourcesRoot(appRoot),
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
  );
}

function payloadRoot(appRoot) {
  return path.join(nodePtyRoot(appRoot), "prebuilds");
}

function shortHelperRoot(appRoot) {
  return path.join(resourcesRoot(appRoot), SHORT_HELPER_DIR);
}

function assertRegularFile(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalid(`${label} escapes the expected root`);
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
  const root = payloadRoot(appRoot);
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

function inspectPackagedNodePtyMacPayload(appRoot) {
  const base = inspectNodePtyMacPayload(appRoot);
  const shortRoot = shortHelperRoot(appRoot);
  const shortHelpers = DARWIN_ARCHES.map((arch) => (
    assertRegularFile(shortRoot, path.join(shortRoot, arch, "spawn-helper"), `${arch} short spawn-helper`)
  ));
  for (const helper of [...base.helpers, ...shortHelpers]) {
    if ((helper.mode & 0o111) !== 0o111) {
      throw invalid(`packaged spawn-helper is not executable: ${helper.path}`);
    }
  }

  const packageRoot = nodePtyRoot(appRoot);
  const unixTerminalPath = path.join(packageRoot, "lib", "unixTerminal.js");
  const sourceInfo = assertRegularFile(packageRoot, unixTerminalPath, "node-pty unixTerminal.js");
  const source = fs.readFileSync(sourceInfo.path, "utf8");
  if (!source.includes(SHORT_HELPER_PATCH_MARKER) || !source.includes(`../../../../../${SHORT_HELPER_DIR}/`)) {
    throw invalid(`node-pty unixTerminal.js is missing the packaged short-helper resolver patch: ${sourceInfo.path}`);
  }

  return Object.freeze({
    ...base,
    shortHelperRoot: shortRoot,
    shortHelpers: Object.freeze(shortHelpers),
    unixTerminalPath: sourceInfo.path,
  });
}

function patchUnixTerminalForShortHelper(appRoot) {
  const packageRoot = nodePtyRoot(appRoot);
  const unixTerminalPath = path.join(packageRoot, "lib", "unixTerminal.js");
  assertRegularFile(packageRoot, unixTerminalPath, "node-pty unixTerminal.js");
  const source = fs.readFileSync(unixTerminalPath, "utf8");
  if (source.includes(SHORT_HELPER_PATCH_MARKER)) return;
  if (!source.includes(UNIX_TERMINAL_ANCHOR)) {
    throw invalid(`node-pty unixTerminal.js does not contain the expected helper-path anchor: ${unixTerminalPath}`);
  }

  const injected = `${UNIX_TERMINAL_ANCHOR}
if (process.platform === 'darwin') {
    /* ${SHORT_HELPER_PATCH_MARKER} */
    const webgptBridgeShortHelper = path.resolve(__dirname, '../../../../../${SHORT_HELPER_DIR}/' + process.platform + '-' + process.arch + '/spawn-helper');
    if (!fs.existsSync(webgptBridgeShortHelper)) {
        throw new Error('WebGPT Bridge packaged node-pty spawn-helper is missing: ' + webgptBridgeShortHelper);
    }
    helperPath = webgptBridgeShortHelper;
}`;
  fs.writeFileSync(unixTerminalPath, source.replace(UNIX_TERMINAL_ANCHOR, injected), "utf8");
}

function stageShortHelpers(appRoot, helpers) {
  const root = shortHelperRoot(appRoot);
  for (let index = 0; index < DARWIN_ARCHES.length; index += 1) {
    const arch = DARWIN_ARCHES[index];
    const source = helpers[index].path;
    const dir = path.join(root, arch);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "spawn-helper");
    fs.copyFileSync(source, target);
    fs.chmodSync(target, helpers[index].mode | 0o111);
  }
}

function normalizeNodePtyMacPayload(appRoot) {
  const before = inspectNodePtyMacPayload(appRoot);
  for (const helper of before.helpers) {
    const nextMode = helper.mode | 0o111;
    if (nextMode !== helper.mode) fs.chmodSync(helper.path, nextMode);
  }

  const executable = inspectNodePtyMacPayload(appRoot);
  for (const helper of executable.helpers) {
    if ((helper.mode & 0o111) !== 0o111) {
      throw invalid(`spawn-helper is not executable after normalization: ${helper.path}`);
    }
  }

  stageShortHelpers(appRoot, executable.helpers);
  patchUnixTerminalForShortHelper(appRoot);
  return inspectPackagedNodePtyMacPayload(appRoot);
}

module.exports = {
  DARWIN_ARCHES,
  inspectNodePtyMacPayload,
  inspectPackagedNodePtyMacPayload,
  normalizeNodePtyMacPayload,
};
