const fs = require("node:fs");
const path = require("node:path");

function inheritedPath(env, delimiter) {
  return String(env.PATH ?? env.Path ?? env.path ?? "").split(delimiter).filter(Boolean);
}

function uniqueCandidates(values) {
  return [...new Set(values.filter(Boolean))];
}

function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version || "").trim());
  return match ? Number.parseInt(match[1], 10) : 0;
}

function selectSupportedNode(candidates, versionOf) {
  return candidates.find((candidate) => candidate && nodeMajor(versionOf(candidate)) >= 20) || "";
}

function windowsNodeCandidates({ env = process.env } = {}) {
  const impl = path.win32;
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA || "";
  const scoop = env.SCOOP || (env.USERPROFILE ? impl.join(env.USERPROFILE, "scoop") : "");
  const fromPath = inheritedPath(env, ";").map((directory) => {
    const unquoted = String(directory).trim().replace(/^"(.*)"$/, "$1");
    return unquoted ? impl.join(unquoted, "node.exe") : "";
  });

  return uniqueCandidates([
    env.NVM_SYMLINK ? impl.join(env.NVM_SYMLINK, "node.exe") : "",
    env.FNM_MULTISHELL_PATH ? impl.join(env.FNM_MULTISHELL_PATH, "node.exe") : "",
    env.VOLTA_HOME ? impl.join(env.VOLTA_HOME, "bin", "node.exe") : "",
    impl.join(programFiles, "nodejs", "node.exe"),
    impl.join(programFiles, "Volta", "node.exe"),
    localAppData ? impl.join(localAppData, "Volta", "bin", "node.exe") : "",
    localAppData ? impl.join(localAppData, "Programs", "nodejs", "node.exe") : "",
    scoop ? impl.join(scoop, "apps", "nodejs-lts", "current", "node.exe") : "",
    scoop ? impl.join(scoop, "apps", "nodejs", "current", "node.exe") : "",
    ...fromPath,
  ]);
}

function preferredNodeCandidates({
  settingsNodePath = "",
  lpcNodePath = "",
  bundledNodePath = "",
  platform = process.platform,
  env = process.env,
  nvmCandidates = [],
} = {}) {
  const automatic = platform === "win32"
    ? windowsNodeCandidates({ env })
    : platform === "darwin"
      ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", ...nvmCandidates]
      : [...nvmCandidates];

  return uniqueCandidates([
    settingsNodePath,
    lpcNodePath,
    bundledNodePath,
    ...automatic,
    "node",
  ]);
}

function buildTrustedCommandPath({
  nodePath = "",
  additionalPaths = [],
  env = process.env,
  platform = process.platform,
  isDirectory = (candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true,
} = {}) {
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = [
    path.isAbsolute(nodePath) ? path.dirname(nodePath) : "",
    ...additionalPaths,
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] : []),
    ...(platform === "win32" ? [path.join(env.ProgramFiles || "C:\\Program Files", "nodejs")] : []),
    ...inheritedPath(env, delimiter),
  ];
  return [...new Set(candidates.filter((candidate) => candidate && isDirectory(candidate)))].join(delimiter);
}

module.exports = {
  buildTrustedCommandPath,
  preferredNodeCandidates,
  selectSupportedNode,
  windowsNodeCandidates,
};
