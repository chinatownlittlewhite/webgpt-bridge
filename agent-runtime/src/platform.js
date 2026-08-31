import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR } from "./workspace.js";

const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_RUNTIME_REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 100,
});

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

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function copyTrustedRuntimePackage(sourceRoot, destinationRoot) {
  const canonicalSource = fs.realpathSync(sourceRoot);
  fs.cpSync(canonicalSource, destinationRoot, {
    recursive: true,
    dereference: true,
    filter(source) {
      const canonicalEntry = fs.realpathSync(source);
      if (!isInside(canonicalSource, canonicalEntry)) {
        throw new Error("trusted runtime package contains a symlink escape");
      }
      const entry = fs.lstatSync(source);
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error("trusted runtime package contains an unsupported filesystem entry");
      }
      return true;
    },
  });
}

export function stageWindowsNodeCliRuntime(platformCommand, {
  workspace,
  platform = process.platform,
} = {}) {
  if (platform !== "win32" || !["npm", "npx"].includes(platformCommand?.logicalCommand)) {
    return platformCommand;
  }
  if (!platformCommand?.resolved || platformCommand.usedTrustedShim !== true) {
    throw new Error("Windows Node CLI runtime staging requires a resolved trusted shim");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new TypeError("workspace is required for Windows Node CLI runtime staging");
  }
  const workspaceRoot = fs.realpathSync(path.resolve(workspace));
  const cliName = platformCommand.logicalCommand === "npx" ? "npx-cli.js" : "npm-cli.js";
  const cli = platformCommand.argv?.[3];
  if (typeof cli !== "string" || path.basename(cli).toLowerCase() !== cliName) {
    throw new Error(`resolved ${platformCommand.logicalCommand} shim does not reference ${cliName}`);
  }
  const sourceNodeArg = platformCommand.argv?.[0];
  if (typeof sourceNodeArg !== "string" || sourceNodeArg.length === 0) {
    throw new Error(`resolved ${platformCommand.logicalCommand} shim does not reference Node`);
  }
  const sourceNode = fs.realpathSync(sourceNodeArg);
  if (!fs.statSync(sourceNode).isFile()) {
    throw new Error("resolved Windows Node runtime is not a regular file");
  }
  const sourceNodeDirectory = path.dirname(sourceNode);
  const sourcePackageRoot = fs.realpathSync(path.dirname(path.dirname(cli)));
  if (isInside(workspaceRoot, sourcePackageRoot) && isInside(workspaceRoot, sourceNode)) {
    const trustedPathEntries = [...new Set([
      ...(platformCommand.trustedPathEntries ?? []),
      path.dirname(sourceNode),
    ].map((entry) => path.resolve(entry)))];
    return Object.freeze({
      ...platformCommand,
      trustedPathEntries: Object.freeze(trustedPathEntries),
    });
  }

  const packageJsonPath = path.join(sourcePackageRoot, "package.json");
  const packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw);
  if (packageJson?.name !== "npm" || typeof packageJson.version !== "string" || !/^[0-9A-Za-z._+-]{1,64}$/.test(packageJson.version)) {
    throw new Error("resolved Windows npm runtime package metadata is invalid");
  }

  const stageKey = createHash("sha256")
    .update(sourceNode)
    .update("\0")
    .update(sourcePackageRoot)
    .update("\0")
    .update(packageJsonRaw)
    .digest("hex")
    .slice(0, 16);
  const runtimeParent = path.join(workspaceRoot, INTERNAL_STATE_DIR, "runtime", "npm");
  const stageRoot = path.join(runtimeParent, `${packageJson.version}-${stageKey}`);
  const stagedNodeDirectory = path.join(stageRoot, "node");
  const stagedNode = path.join(stagedNodeDirectory, path.basename(sourceNode));
  const stagedPackageRoot = path.join(stageRoot, "package");
  fs.mkdirSync(runtimeParent, { recursive: true });
  fs.rmSync(stageRoot, WINDOWS_RUNTIME_REMOVE_OPTIONS);
  fs.mkdirSync(stagedNodeDirectory, { recursive: true });
  try {
    fs.copyFileSync(sourceNode, stagedNode);
    copyTrustedRuntimePackage(sourcePackageRoot, stagedPackageRoot);
  } catch (error) {
    fs.rmSync(stageRoot, WINDOWS_RUNTIME_REMOVE_OPTIONS);
    throw error;
  }
  const stagedCli = path.join(stagedPackageRoot, "bin", cliName);
  if (!fs.statSync(stagedNode).isFile() || !fs.statSync(stagedCli).isFile()) {
    fs.rmSync(stageRoot, WINDOWS_RUNTIME_REMOVE_OPTIONS);
    throw new Error(`staged Windows npm runtime is incomplete for ${cliName}`);
  }

  const trustedReadPaths = (platformCommand.trustedReadPaths ?? [])
    .filter((entry) => {
      try {
        const canonicalEntry = fs.realpathSync(entry);
        return !isInside(sourcePackageRoot, canonicalEntry) && !isInside(sourceNodeDirectory, canonicalEntry);
      } catch {
        return false;
      }
    });
  trustedReadPaths.push(stagedNodeDirectory, stagedPackageRoot);
  const trustedPathEntries = [...new Set([
    ...(platformCommand.trustedPathEntries ?? []),
    stagedNodeDirectory,
  ].map((entry) => path.resolve(entry)))];
  return Object.freeze({
    ...platformCommand,
    argv: Object.freeze([
      stagedNode,
      ...platformCommand.argv.slice(1, 3),
      stagedCli,
      ...platformCommand.argv.slice(4),
    ]),
    trustedReadPaths: Object.freeze([...new Set(trustedReadPaths.map((entry) => path.resolve(entry)))]),
    trustedPathEntries: Object.freeze(trustedPathEntries),
    stagedRuntimeRoots: Object.freeze([stageRoot]),
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