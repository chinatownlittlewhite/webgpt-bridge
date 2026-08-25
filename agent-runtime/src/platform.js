import fs from "node:fs";
import path from "node:path";

const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

export function normalizedPlatform(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return platform;
}

function assertCommandName(name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new TypeError("command name must be a non-empty string without NUL bytes");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new TypeError("command name must be resolved through the trusted PATH");
  }
}

function pathEntries(env, platform) {
  const value = env.PATH ?? env.Path ?? env.path ?? "";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return value.split(delimiter).filter(Boolean);
}

function windowsExtensions(name, env) {
  if (path.win32.extname(name)) return [""];
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean).map((entry) => entry.toLowerCase());
}

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function findExecutableInPath(name, { env = process.env, platform = process.platform } = {}) {
  assertCommandName(name);
  const impl = platformPath(platform);
  const entries = pathEntries(env, platform);
  const extensions = platform === "win32" ? windowsExtensions(name, env) : [""];

  for (const directory of entries) {
    for (const extension of extensions) {
      const candidate = impl.resolve(directory, platform === "win32" && extension ? `${name}${extension}` : name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue searching trusted PATH entries.
      }
    }
  }
  return null;
}

function existingFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function existingExecutableFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function macosDeveloperGit(executable, env) {
  if (executable !== "/usr/bin/git") return executable;
  const developerDir = typeof env.DEVELOPER_DIR === "string" && path.isAbsolute(env.DEVELOPER_DIR)
    ? env.DEVELOPER_DIR
    : null;
  return existingExecutableFile([
    developerDir ? path.join(developerDir, "usr", "bin", "git") : null,
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
  ]) ?? executable;
}

function windowsNpmCli(command, { env = process.env } = {}) {
  const cliName = command === "npx" ? "npx-cli.js" : "npm-cli.js";
  const envCli = typeof env.npm_execpath === "string" && path.win32.basename(env.npm_execpath).toLowerCase() === cliName
    ? env.npm_execpath
    : null;
  const shim = findExecutableInPath(command, { env, platform: "win32" });
  const shimDirectory = shim ? path.win32.dirname(shim) : null;
  return existingFile([
    envCli,
    shimDirectory ? path.win32.join(shimDirectory, "node_modules", "npm", "bin", cliName) : null,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", cliName),
  ]);
}

function windowsPackageManagerCli(command, { env = process.env } = {}) {
  const shim = findExecutableInPath(command, { env, platform: "win32" });
  if (shim && !WINDOWS_BATCH_EXTENSIONS.has(path.win32.extname(shim).toLowerCase())) {
    return { executable: shim, cli: null };
  }
  const shimDirectory = shim ? path.win32.dirname(shim) : null;
  const corepackName = command === "pnpm" ? "pnpm.js" : "yarn.js";
  const directCandidates = command === "pnpm"
    ? [
        shimDirectory ? path.win32.join(shimDirectory, "node_modules", "pnpm", "bin", "pnpm.cjs") : null,
        shimDirectory ? path.win32.join(shimDirectory, "node_modules", "pnpm", "bin", "pnpm.js") : null,
      ]
    : [
        shimDirectory ? path.win32.join(shimDirectory, "node_modules", "yarn", "bin", "yarn.js") : null,
      ];
  const corepackCandidates = [
    shimDirectory ? path.win32.join(shimDirectory, "node_modules", "corepack", "dist", corepackName) : null,
    path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", corepackName),
  ];
  const cli = existingFile([...directCandidates, ...corepackCandidates]);
  return cli ? { executable: path.resolve(process.execPath), cli } : null;
}

function resolveWindowsPython(argv, env) {
  const command = argv[0].toLowerCase();
  if (command !== "python3") return null;
  const python = findExecutableInPath("python", { env, platform: "win32" });
  if (python && !WINDOWS_BATCH_EXTENSIONS.has(path.win32.extname(python).toLowerCase())) {
    return [python, ...argv.slice(1)];
  }
  const py = findExecutableInPath("py", { env, platform: "win32" });
  if (py && !WINDOWS_BATCH_EXTENSIONS.has(path.win32.extname(py).toLowerCase())) {
    return [py, "-3", ...argv.slice(1)];
  }
  return null;
}

function trustedRuntimeReadPaths(runtimeValues, platform) {
  const impl = platformPath(platform);
  const roots = [];
  for (const value of runtimeValues) {
    if (typeof value !== "string" || !impl.isAbsolute(value)) continue;
    try {
      const stat = fs.statSync(value);
      roots.push(stat.isDirectory() ? value : impl.dirname(value));
      const resolvedTarget = fs.realpathSync(value);
      const segments = resolvedTarget.split(impl.sep);
      const nodeModulesIndex = segments.lastIndexOf("node_modules");
      if (nodeModulesIndex >= 0 && typeof segments[nodeModulesIndex + 1] === "string") {
        const packageEnd = segments[nodeModulesIndex + 1].startsWith("@")
          ? nodeModulesIndex + 3
          : nodeModulesIndex + 2;
        if (segments.length >= packageEnd) {
          roots.push(segments.slice(0, packageEnd).join(impl.sep));
        }
      }
    } catch {
      // Only runtime paths that actually exist are trusted.
    }
  }
  return [...new Set(roots.map((entry) => impl.resolve(entry)))];
}

function resolution({ platform, logicalCommand, argv, resolved, usedTrustedShim, trustedRuntimeValues = null }) {
  const platformName = normalizedPlatform(platform);
  const resolvedArgv = [...argv];
  const runtimeValues = trustedRuntimeValues ?? (resolvedArgv.length > 0 ? [resolvedArgv[0]] : []);
  return Object.freeze({
    platform: platformName,
    logicalCommand,
    argv: Object.freeze(resolvedArgv),
    resolved,
    usedTrustedShim,
    trustedReadPaths: Object.freeze(resolved ? trustedRuntimeReadPaths(runtimeValues, platform) : []),
  });
}

export function resolvePlatformArgv(argv, {
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("argv must be a non-empty array");
  assertCommandName(argv[0]);
  const logicalCommand = path.basename(argv[0]).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");

  if (platform !== "win32") {
    const executable = findExecutableInPath(argv[0], { env, platform });
    const resolvedExecutable = platform === "darwin" && logicalCommand === "git" && executable
      ? macosDeveloperGit(executable, env)
      : executable;
    return resolution({
      platform,
      logicalCommand,
      argv: resolvedExecutable ? [resolvedExecutable, ...argv.slice(1)] : [...argv],
      resolved: resolvedExecutable !== null,
      usedTrustedShim: false,
    });
  }

  if (["npm", "npx"].includes(logicalCommand)) {
    const cli = windowsNpmCli(logicalCommand, { env });
    if (!cli) throw new Error(`could not resolve trusted ${logicalCommand} CLI without using a command shell`);
    const node = path.resolve(nodePath);
    return resolution({
      platform,
      logicalCommand,
      argv: [node, "--preserve-symlinks", "--preserve-symlinks-main", cli, ...argv.slice(1)],
      resolved: true,
      usedTrustedShim: true,
      trustedRuntimeValues: [node, cli],
    });
  }

  if (["pnpm", "yarn"].includes(logicalCommand)) {
    const manager = windowsPackageManagerCli(logicalCommand, { env });
    if (!manager) throw new Error(`could not resolve trusted ${logicalCommand} CLI without using a command shell`);
    return resolution({
      platform,
      logicalCommand,
      argv: manager.cli
        ? [manager.executable, "--preserve-symlinks", "--preserve-symlinks-main", manager.cli, ...argv.slice(1)]
        : [manager.executable, ...argv.slice(1)],
      resolved: true,
      usedTrustedShim: manager.cli !== null,
      trustedRuntimeValues: manager.cli ? [manager.executable, manager.cli] : [manager.executable],
    });
  }

  const python = resolveWindowsPython(argv, env);
  if (python) {
    return resolution({ platform, logicalCommand, argv: python, resolved: true, usedTrustedShim: true });
  }

  const executable = findExecutableInPath(argv[0], { env, platform: "win32" });
  if (!executable) {
    return resolution({ platform, logicalCommand, argv: [...argv], resolved: false, usedTrustedShim: false });
  }
  const extension = path.win32.extname(executable).toLowerCase();
  if (WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    throw new Error(`refusing to execute ${extension} command '${argv[0]}' through a shell; add a trusted argv shim instead`);
  }
  return resolution({
    platform,
    logicalCommand,
    argv: [executable, ...argv.slice(1)],
    resolved: true,
    usedTrustedShim: false,
  });
}

export const platformSecurityNotes = Object.freeze({
  windowsShellForModelCommands: false,
  windowsBatchFilesRequireTrustedShim: true,
  npmUsesNodeCliShimOnWindows: true,
  pnpmYarnUseTrustedRuntimeShimWhenNeeded: true,
  trustedRuntimeReadPathsAreHostDerived: true,
});
