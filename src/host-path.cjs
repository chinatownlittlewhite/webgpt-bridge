const fs = require("node:fs");
const path = require("node:path");

function inheritedPath(env, delimiter) {
  return String(env.PATH ?? env.Path ?? env.path ?? "").split(delimiter).filter(Boolean);
}

function buildTrustedCommandPath({
  nodePath = "",
  additionalPaths = [],
  env = process.env,
  platform = process.platform,
  isDirectory = (candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true,
} = {}) {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const candidates = [
    path.isAbsolute(nodePath) ? path.dirname(nodePath) : "",
    ...additionalPaths,
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] : []),
    ...(platform === "win32" ? [path.join(env.ProgramFiles || "C:\\Program Files", "nodejs")] : []),
    ...inheritedPath(env, delimiter),
  ];
  return [...new Set(candidates.filter((candidate) => candidate && isDirectory(candidate)))].join(delimiter);
}

module.exports = { buildTrustedCommandPath };
