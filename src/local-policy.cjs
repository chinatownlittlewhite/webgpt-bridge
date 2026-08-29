const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { authorizeSecurityOperation, normalizeApprovalPreset } = require("../shared/security-policy-core.cjs");

const SENSITIVE_FILE_NAMES = new Set([
  ".env", ".npmrc", ".netrc", ".pypirc", ".pgpass", ".git-credentials",
]);

function normalizeApprovalMode(mode) {
  return normalizeApprovalPreset(mode);
}

function canonicalPath(input, fsImpl = fs) {
  const absolute = path.resolve(input);
  try {
    return fsImpl.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent, fsImpl), path.basename(absolute));
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function defaultSensitiveRoots(homeDir, platform) {
  const roots = [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".kube"),
  ];
  if (platform === "darwin") {
    roots.push(
      path.join(homeDir, "Library", "Keychains"),
      path.join(homeDir, "Library", "Safari"),
      path.join(homeDir, "Library", "Application Support", "Google", "Chrome"),
      path.join(homeDir, "Library", "Application Support", "Firefox"),
      path.join(homeDir, "Library", "Containers"),
    );
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    roots.push(
      path.join(homeDir, ".ssh"),
      path.join(appData, "Microsoft", "Credentials"),
      path.join(localAppData, "Google", "Chrome", "User Data"),
      path.join(appData, "Mozilla", "Firefox", "Profiles"),
    );
  }
  return roots;
}

function defaultSystemRoots(platform) {
  if (platform === "win32") return ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"];
  if (platform === "darwin") return ["/System", "/bin", "/sbin", "/usr"];
  return ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr"];
}

function classifyLocalPath(inputPath, options = {}) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    return { decision: "deny", reason: "路径必须是非空字符串。", sensitive: false };
  }
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const fsImpl = options.fsImpl || fs;
  const operation = options.operation;
  const target = canonicalPath(inputPath, fsImpl);
  const sensitiveRoots = [
    ...defaultSensitiveRoots(homeDir, platform),
    ...(options.appDataRoots || []),
    ...(options.sensitiveRoots || []),
  ].filter((entry) => typeof entry === "string" && entry).map((entry) => canonicalPath(entry, fsImpl));
  const systemRoots = (options.systemRoots || defaultSystemRoots(platform))
    .filter((entry) => typeof entry === "string" && entry)
    .map((entry) => canonicalPath(entry, fsImpl));
  const knownFolderRoots = (Array.isArray(options.knownFolderRoots)
    ? options.knownFolderRoots
    : Object.values(options.knownFolderRoots || {}))
    .filter((entry) => typeof entry === "string" && entry)
    .map((entry) => canonicalPath(entry, fsImpl));
  const workspaceRoot = typeof options.workspaceRoot === "string" && options.workspaceRoot
    ? canonicalPath(options.workspaceRoot, fsImpl)
    : "";

  let scope = "ordinary-host";
  if (systemRoots.some((root) => isWithin(target, root))) scope = "system";
  else if (sensitiveRoots.some((root) => isWithin(target, root)) || SENSITIVE_FILE_NAMES.has(path.basename(target).toLowerCase())) scope = "sensitive";
  else if (workspaceRoot && isWithin(target, workspaceRoot)) scope = "workspace";
  else if (knownFolderRoots.some((root) => isWithin(target, root))) scope = "known-folder";

  const authorization = authorizeSecurityOperation({
    type: "filesystem-path",
    scope,
    kind: operation || "read",
  });
  return {
    ...authorization,
    sensitive: scope === "system" || scope === "sensitive",
    path: target,
    scope,
  };
}

function classifyLocalAction({ kind, approvalMode, sensitive = false, network = false, withinWorkspace = false } = {}) {
  return authorizeSecurityOperation({
    type: "filesystem-action",
    kind,
    preset: normalizeApprovalMode(approvalMode),
    sensitive,
    network,
    withinWorkspace,
  });
}

function hasExpandedSandboxAccess(sandboxAccess) {
  return Boolean(
    Array.isArray(sandboxAccess?.read) && sandboxAccess.read.length > 0 ||
    Array.isArray(sandboxAccess?.write) && sandboxAccess.write.length > 0
  );
}

function sandboxAccessScopeKey(sandboxAccess = {}) {
  const read = Array.isArray(sandboxAccess.read) ? [...sandboxAccess.read].sort().join(",") : "";
  const write = Array.isArray(sandboxAccess.write) ? [...sandboxAccess.write].sort().join(",") : "";
  return `read:${read}|write:${write}`;
}

function isVerifiedSandboxRequest(request) {
  return request?.sandbox?.enforced === true && request?.sandbox?.autoRunSafe === true;
}

function isSafeDependencySync(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return false;
  const command = path.basename(argv[0]).toLowerCase();
  if (!["npm", "pnpm", "yarn"].includes(command)) return false;
  return argv.includes("--ignore-scripts") && (
    command === "npm" && ["ci", "install"].includes(argv[1]) ||
    command === "pnpm" && argv[1] === "install" ||
    command === "yarn" && argv[1] === "install"
  );
}

function gitSubcommand(argv) {
  if (!Array.isArray(argv) || path.basename(argv[0] || "").toLowerCase() !== "git") return "";
  return argv[1] || "";
}

function isGitRemoteOperation(argv) {
  return new Set(["push", "pull", "fetch", "clone", "remote", "submodule", "ls-remote"]).has(gitSubcommand(argv));
}

function isGitTrustedSync(argv) {
  return new Set(["fetch", "ls-remote", "pull"]).has(gitSubcommand(argv));
}

function isGitReadOnlyRemote(argv) {
  return new Set(["fetch", "ls-remote"]).has(gitSubcommand(argv));
}

function isGitPush(argv) {
  return gitSubcommand(argv) === "push";
}

function isGitRiskyRemoteOperation(argv) {
  return new Set(["clone", "remote", "submodule"]).has(gitSubcommand(argv));
}

function isDevelopmentGitMutation(argv) {
  const subcommand = gitSubcommand(argv);
  if (["add", "commit", "restore"].includes(subcommand)) return true;
  if (subcommand === "branch") {
    const args = argv.slice(2);
    return args.length > 0 && !args.some((arg) => ["-d", "-D", "--delete", "-f", "--force"].includes(arg));
  }
  if (subcommand === "switch") {
    return !argv.slice(2).some((arg) => ["-C", "--force-create", "--discard-changes", "-f", "--force"].includes(arg));
  }
  if (subcommand === "worktree") return new Set(["add", "remove"]).has(argv[2] || "");
  return false;
}

function isGitHubExternalWrite(argv) {
  if (!Array.isArray(argv) || path.basename(argv[0] || "").toLowerCase() !== "gh") return false;
  return argv[1] === "pr" && argv[2] === "create" ||
    argv[1] === "issue" && argv[2] === "create" ||
    argv[1] === "release" && argv[2] === "create";
}

function isGitHubRead(argv) {
  if (!Array.isArray(argv) || path.basename(argv[0] || "").toLowerCase() !== "gh") return false;
  return argv[1] === "run" && argv[2] === "list" ||
    argv[1] === "pr" && argv[2] === "view" ||
    argv[1] === "issue" && argv[2] === "view" ||
    argv[1] === "release" && argv[2] === "view";
}

function isProjectPackageScript(argv) {
  if (!Array.isArray(argv) || argv.length < 3) return false;
  const command = path.basename(argv[0] || "").toLowerCase();
  return ["npm", "pnpm", "yarn"].includes(command) && argv[1] === "run" && typeof argv[2] === "string" && argv[2] && !argv[2].startsWith("-");
}

function isSafeWorkspaceUtility(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const command = path.basename(argv[0] || "").toLowerCase();
  return new Set(["pwd", "ls", "find", "grep", "rg", "cat", "head", "tail", "wc", "stat", "mkdir"]).has(command);
}

function isHighAutonomyWorkspaceUtility(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  return path.basename(argv[0] || "").toLowerCase() === "codesign";
}

function classifyLocalTerminalApproval({ argv, classification, approvalMode } = {}) {
  const command = path.basename(Array.isArray(argv) ? argv[0] || "" : "").toLowerCase();
  return authorizeSecurityOperation({
    type: "terminal-command",
    preset: normalizeApprovalMode(approvalMode),
    baseDecision: classification ? classification.decision : "deny",
    baseRule: classification?.rule || "default-ask",
    baseReason: classification?.reason,
    projectScript: isProjectPackageScript(argv),
    networkCommand: ["curl", "wget"].includes(command) || classification?.rule === "network",
    githubRead: isGitHubRead(argv),
    gitReadOnlyRemote: isGitReadOnlyRemote(argv),
    safeDependencySync: isSafeDependencySync(argv),
    safeWorkspaceUtility: isSafeWorkspaceUtility(argv),
  });
}

function classifyHostCommandApproval(request, approvalMode) {
  const argv = Array.isArray(request?.argv) ? request.argv : [];
  const command = path.basename(argv[0] || "").toLowerCase();
  const rule = request?.policy?.rule || "default-ask";
  return authorizeSecurityOperation({
    type: "host-command",
    preset: normalizeApprovalMode(approvalMode),
    baseDecision: request?.policy?.decision,
    baseRule: rule,
    baseReason: request?.policy?.reason,
    commandName: command || rule,
    sandboxVerified: isVerifiedSandboxRequest(request),
    sandboxExpanded: hasExpandedSandboxAccess(request?.sandboxAccess),
    sandboxScopeKey: sandboxAccessScopeKey(request?.sandboxAccess),
    projectScript: isProjectPackageScript(argv),
    safeDependencySync: isSafeDependencySync(argv),
    gitTrustedSync: isGitTrustedSync(argv),
    gitReadOnlyRemote: isGitReadOnlyRemote(argv),
    developmentGitMutation: isDevelopmentGitMutation(argv),
    gitPush: isGitPush(argv),
    gitRiskyRemote: isGitRiskyRemoteOperation(argv),
    githubRead: isGitHubRead(argv),
    githubExternalWrite: isGitHubExternalWrite(argv),
    safeWorkspaceUtility: isSafeWorkspaceUtility(argv),
    highAutonomyUtility: isHighAutonomyWorkspaceUtility(argv),
    networkCommand: ["curl", "wget"].includes(command),
    workspaceFileMutation: ["rm", "mv", "cp"].includes(command),
  });
}

module.exports = {
  canonicalPath,
  classifyHostCommandApproval,
  classifyLocalTerminalApproval,
  classifyLocalAction,
  classifyLocalPath,
  normalizeApprovalMode,
};
