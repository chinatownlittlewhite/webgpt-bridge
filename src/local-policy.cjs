const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APPROVAL_MODES = new Set(["cautious", "development", "auto", "full_control"]);
const DESTRUCTIVE_ACTIONS = new Set(["delete", "move", "overwrite"]);
const SENSITIVE_FILE_NAMES = new Set([
  ".env", ".npmrc", ".netrc", ".pypirc", ".pgpass", ".git-credentials",
]);

function normalizeApprovalMode(mode) {
  return APPROVAL_MODES.has(mode) ? mode : "development";
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
  const target = canonicalPath(inputPath, fsImpl);
  const sensitiveRoots = [
    ...defaultSensitiveRoots(homeDir, platform),
    ...(options.appDataRoots || []),
    ...(options.sensitiveRoots || []),
  ].map((entry) => canonicalPath(entry, fsImpl));
  const systemRoots = (options.systemRoots || defaultSystemRoots(platform)).map((entry) => canonicalPath(entry, fsImpl));

  const fullControl = normalizeApprovalMode(options.approvalMode) === "full_control";
  if (sensitiveRoots.some((root) => isWithin(target, root))) {
    return fullControl
      ? { decision: "allow", reason: "完全控制模式允许访问敏感位置。", sensitive: true, path: target }
      : { decision: "deny", reason: "该路径属于默认排除的敏感位置。", sensitive: true, path: target };
  }
  if (systemRoots.some((root) => isWithin(target, root))) {
    return fullControl
      ? { decision: "allow", reason: "完全控制模式允许访问系统路径。", sensitive: true, path: target }
      : { decision: "deny", reason: "系统路径不允许由本机代理访问。", sensitive: true, path: target };
  }
  if (SENSITIVE_FILE_NAMES.has(path.basename(target).toLowerCase())) {
    return fullControl
      ? { decision: "allow", reason: "完全控制模式允许访问敏感文件。", sensitive: true, path: target }
      : { decision: "deny", reason: "该文件名通常包含凭据或密钥。", sensitive: true, path: target };
  }
  return { decision: "allow", reason: "普通本机路径。", sensitive: false, path: target };
}

function classifyLocalAction({ kind, approvalMode, sensitive = false, network = false, withinWorkspace = false } = {}) {
  const mode = normalizeApprovalMode(approvalMode);
  if (mode === "full_control") return { decision: "allow", reason: "完全控制模式不要求本机操作确认。" };
  if (sensitive) {
    if (kind === "read" || kind === "list") return { decision: "confirm", reason: "敏感位置仅可进行单次确认读取。" };
    return { decision: "deny", reason: "敏感位置不允许修改或执行。" };
  }
  if (network || kind === "network") return { decision: "confirm", reason: "任意网络操作仍需要确认。" };
  if (DESTRUCTIVE_ACTIONS.has(kind)) {
    return mode !== "cautious" && withinWorkspace
      ? { decision: "allow", reason: "当前模式允许工作区内的删除、移动或覆盖。" }
      : { decision: "confirm", reason: "工作区外的删除、移动或覆盖仍需要确认。" };
  }
  if (kind === "read" || kind === "list") return { decision: "allow", reason: "普通读取无需确认。" };
  if (kind === "update" || kind === "create") {
    return { decision: "allow", reason: "普通文件新建或更新无需确认。" };
  }
  return { decision: "confirm", reason: "未知操作需要确认。" };
}

function hasExpandedSandboxAccess(sandboxAccess) {
  return Boolean(
    Array.isArray(sandboxAccess?.read) && sandboxAccess.read.length > 0 ||
    Array.isArray(sandboxAccess?.write) && sandboxAccess.write.length > 0
  );
}

function sandboxAccessPermissionKey(sandboxAccess = {}) {
  const read = Array.isArray(sandboxAccess.read) ? [...sandboxAccess.read].sort().join(",") : "";
  const write = Array.isArray(sandboxAccess.write) ? [...sandboxAccess.write].sort().join(",") : "";
  return `host:sandbox-expansion:read:${read}|write:${write}`;
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
  return argv[1] === "pr" && argv[2] === "create" || argv[1] === "issue" && argv[2] === "create";
}

function isGitHubRead(argv) {
  if (!Array.isArray(argv) || path.basename(argv[0] || "").toLowerCase() !== "gh") return false;
  return argv[1] === "run" && argv[2] === "list" || argv[1] === "pr" && argv[2] === "view" || argv[1] === "issue" && argv[2] === "view";
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
  const mode = normalizeApprovalMode(approvalMode);
  const command = path.basename(Array.isArray(argv) ? argv[0] || "" : "").toLowerCase();
  if (mode === "full_control") return { decision: "allow", reason: "完全控制模式不要求本机终端确认。" };
  if (!classification || classification.decision === "deny") return { decision: "deny", reason: classification?.reason || "命令策略已拒绝该操作。" };
  if (classification.rule === "runtime-execution" || isProjectPackageScript(argv)) return { decision: "allow", reason: "项目运行和项目脚本不再要求执行确认。" };
  if (["curl", "wget"].includes(command) || classification.rule === "network") return { decision: "confirm", reason: "本机终端网络命令需要确认。" };
  if (classification.decision === "allow") return { decision: "allow", reason: "命令分类器已允许该本机操作。" };
  if (isGitHubRead(argv)) return { decision: "allow", reason: "只读 GitHub 查询可由 App-owned broker 自动执行。" };
  if (isGitReadOnlyRemote(argv)) return { decision: "allow", reason: "只读或仅更新 Git 元数据的远端查询可自动执行。" };
  if (isSafeDependencySync(argv)) return { decision: "allow", reason: "禁用安装脚本的依赖同步可自动执行。" };
  if (isSafeWorkspaceUtility(argv)) return { decision: "allow", reason: "低风险工作区工具无需确认。" };
  return { decision: "confirm", reason: "宿主终端命令未在低风险自动批准范围内。" };
}

function classifyHostCommandApproval(request, approvalMode) {
  const mode = normalizeApprovalMode(approvalMode);
  const argv = Array.isArray(request?.argv) ? request.argv : [];
  const command = path.basename(argv[0] || "").toLowerCase();
  const rule = request?.policy?.rule || "default-ask";

  if (mode === "full_control") return { decision: "allow", reason: "完全控制模式自动批准所有 Host 请求。" };
  if (request?.policy?.decision === "deny") return { decision: "deny", reason: "命令策略已拒绝该操作。" };
  if (!isVerifiedSandboxRequest(request)) return { decision: "confirm", reason: "只有已验证的系统沙箱命令可以自动审批。", rememberKey: `host:unverified-execution:${command || rule}` };
  if (hasExpandedSandboxAccess(request?.sandboxAccess)) return { decision: "confirm", reason: "扩大沙箱访问范围需要确认。", rememberKey: sandboxAccessPermissionKey(request.sandboxAccess) };
  if (rule === "runtime-execution" || isProjectPackageScript(argv)) return { decision: "allow", reason: "受验证沙箱内的项目运行不再要求执行确认。" };
  if (request?.policy?.decision === "allow") return { decision: "allow", reason: "命令分类器已确认该操作为低风险。" };
  if (isGitTrustedSync(argv)) return { decision: "allow", reason: "已验证沙箱内的受控 Git 同步自动批准。" };
  if (isGitHubRead(argv)) return { decision: "allow", reason: "已验证网络沙箱内的只读 GitHub 操作自动批准。" };
  if (isSafeDependencySync(argv)) return { decision: "allow", reason: "禁用安装脚本的依赖同步自动批准。" };
  if (isSafeWorkspaceUtility(argv)) return { decision: "allow", reason: "已验证沙箱内的常规工作区工具自动批准。" };
  if (mode === "cautious") return { decision: "confirm", reason: "谨慎模式只确认具有明显副作用或跨边界的权限。" };
  if (["curl", "wget"].includes(command) || isGitPush(argv) || isGitRiskyRemoteOperation(argv) || isGitHubExternalWrite(argv)) {
    return { decision: "confirm", reason: "自由网络访问或远端写入需要确认。" };
  }
  if (rule === "package-manager") {
    return isSafeDependencySync(argv) || isProjectPackageScript(argv)
      ? { decision: "allow", reason: "已验证沙箱内的项目脚本或禁用安装脚本的依赖同步自动批准。" }
      : { decision: "confirm", reason: "依赖安装脚本或非标准包管理操作需要确认。" };
  }
  if (rule === "git-mutation") {
    if (isDevelopmentGitMutation(argv)) return { decision: "allow", reason: "已验证沙箱内的受控本地 Git 变更自动批准。" };
    return { decision: "confirm", reason: "可能丢失工作区内容的 Git 变更需要确认。" };
  }
  if (rule === "runtime-execution") return { decision: "allow", reason: "已验证沙箱内的项目运行时命令自动批准。" };
  if (rule === "sensitive-command") {
    if (["rm", "mv", "cp"].includes(command)) {
      return { decision: "allow", reason: "已验证沙箱把文件变更限制在工作区内。" };
    }
    return { decision: "confirm", reason: "Docker 或权限类命令仍需要确认。" };
  }
  if (mode !== "cautious" && isHighAutonomyWorkspaceUtility(argv)) {
    return { decision: "allow", reason: "已验证沙箱内的签名/验证工具自动批准。" };
  }
  return { decision: "confirm", reason: "未知命令仍需要确认。" };
}

module.exports = {
  canonicalPath,
  classifyHostCommandApproval,
  classifyLocalTerminalApproval,
  classifyLocalAction,
  classifyLocalPath,
  normalizeApprovalMode,
};
