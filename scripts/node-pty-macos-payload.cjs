const fs = require("node:fs");
const path = require("node:path");

const DARWIN_ARCHES = Object.freeze(["darwin-arm64", "darwin-x64"]);
const DARWIN_VARIANT_ARCHES = Object.freeze({
  arm64: Object.freeze(["darwin-arm64"]),
  x64: Object.freeze(["darwin-x64"]),
  universal: DARWIN_ARCHES,
});
const SHORT_HELPER_DIR = "node-pty-helper";
const SHORT_HELPER_PATCH_MARKER = "webgpt-bridge:darwin-short-spawn-helper";
const UNIX_TERMINAL_ANCHOR = "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";

function invalid(message) {
  const error = new Error(message);
  error.code = "NATIVE_PTY_PAYLOAD_INVALID";
  return error;
}

function normalizeMacPackageVariant(value = "universal") {
  const variant = String(value || "universal").trim();
  if (!Object.hasOwn(DARWIN_VARIANT_ARCHES, variant)) {
    throw invalid(`macOS package variant must be arm64, x64, or universal: ${variant || "(missing)"}`);
  }
  return variant;
}

function darwinArchesForVariant(variant = "universal") {
  return DARWIN_VARIANT_ARCHES[normalizeMacPackageVariant(variant)];
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

function inspectNodePtyMacPayload(appRoot, { variant = "universal" } = {}) {
  const root = payloadRoot(appRoot);
  const arches = darwinArchesForVariant(variant);
  const helpers = [];
  const nativeModules = [];
  for (const arch of arches) {
    const archRoot = path.join(root, arch);
    helpers.push(assertRegularFile(root, path.join(archRoot, "spawn-helper"), `${arch} spawn-helper`));
    nativeModules.push(assertRegularFile(root, path.join(archRoot, "pty.node"), `${arch} pty.node`));
  }
  return Object.freeze({
    root,
    variant: normalizeMacPackageVariant(variant),
    arches,
    helpers: Object.freeze(helpers),
    nativeModules: Object.freeze(nativeModules),
  });
}

function inspectPackagedNodePtyMacPayload(appRoot, { variant = "universal" } = {}) {
  const base = inspectNodePtyMacPayload(appRoot, { variant });
  const shortRoot = shortHelperRoot(appRoot);
  const shortHelpers = base.arches.map((arch) => (
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

function stageShortHelpers(appRoot, payload) {
  const root = shortHelperRoot(appRoot);
  const sourceByArch = new Map(payload.arches.map((arch, index) => [arch, payload.helpers[index].path]));
  fs.rmSync(root, { recursive: true, force: true });
  for (const arch of payload.arches) {
    const source = sourceByArch.get(arch);
    const sourceInfo = payload.helpers[payload.arches.indexOf(arch)];
    const dir = path.join(root, arch);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "spawn-helper");
    fs.copyFileSync(source, target);
    fs.chmodSync(target, sourceInfo.mode | 0o111);
  }
}

function normalizeNodePtyMacPayload(appRoot, { variant = "universal" } = {}) {
  const normalizedVariant = normalizeMacPackageVariant(variant);
  const before = inspectNodePtyMacPayload(appRoot, { variant: normalizedVariant });
  for (const helper of before.helpers) {
    const nextMode = helper.mode | 0o111;
    if (nextMode !== helper.mode) fs.chmodSync(helper.path, nextMode);
  }

  const executable = inspectNodePtyMacPayload(appRoot, { variant: normalizedVariant });
  for (const helper of executable.helpers) {
    if ((helper.mode & 0o111) !== 0o111) {
      throw invalid(`spawn-helper is not executable after normalization: ${helper.path}`);
    }
  }

  stageShortHelpers(appRoot, executable);
  patchUnixTerminalForShortHelper(appRoot);
  return inspectPackagedNodePtyMacPayload(appRoot, { variant: normalizedVariant });
}

module.exports = {
  DARWIN_ARCHES,
  darwinArchesForVariant,
  inspectNodePtyMacPayload,
  inspectPackagedNodePtyMacPayload,
  normalizeMacPackageVariant,
  normalizeNodePtyMacPayload,
};
