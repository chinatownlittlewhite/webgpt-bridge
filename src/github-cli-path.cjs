const fs = require("node:fs");
const path = require("node:path");

function pathEntries(env, platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(env.PATH ?? env.Path ?? env.path ?? "").split(delimiter).filter(Boolean);
}

function defaultFindInPath(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const extensions = platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of pathEntries(env, platform)) {
    for (const extension of extensions) {
      const filename = platform === "win32" ? `${name}${extension.toLowerCase()}` : name;
      const candidate = impl.resolve(directory, filename);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveDesktopGitHubCli({
  platform = process.platform,
  env = process.env,
  appToolsBin = "",
  exists = fs.existsSync,
  findInPath = (name) => defaultFindInPath(name, { env, platform, exists }),
} = {}) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const executableName = platform === "win32" ? "gh.exe" : "gh";
  const candidates = [];
  if (appToolsBin) candidates.push(impl.join(appToolsBin, executableName));
  if (platform === "win32") {
    if (env.ProgramFiles) candidates.push(path.win32.join(env.ProgramFiles, "GitHub CLI", "gh.exe"));
    if (env.LOCALAPPDATA) {
      candidates.push(path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"));
      candidates.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe"));
    }
  }
  const fromPath = findInPath("gh");
  if (fromPath) candidates.push(fromPath);

  for (const candidate of [...new Set(candidates)]) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "";
}

module.exports = { defaultFindInPath, resolveDesktopGitHubCli };
