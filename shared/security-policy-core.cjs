const APPROVAL_PRESETS = new Set(["cautious", "development", "auto", "full_control"]);
const AGENT_IMMUTABLE_DENIED_EXECUTABLES = new Set([
  "sudo", "su", "scp", "sftp",
  "sh", "bash", "zsh", "fish",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const HOST_TERMINAL_IMMUTABLE_DENIED_EXECUTABLES = new Set([
  ...AGENT_IMMUTABLE_DENIED_EXECUTABLES,
  "doas",
]);

function normalizeExecutableName(value) {
  return String(value || "").trim().toLowerCase();
}

function isImmutableDeniedExecutable(value, surface = "agent") {
  const command = normalizeExecutableName(value);
  return surface === "host-terminal"
    ? HOST_TERMINAL_IMMUTABLE_DENIED_EXECUTABLES.has(command)
    : AGENT_IMMUTABLE_DENIED_EXECUTABLES.has(command);
}

function normalizeApprovalPreset(value) {
  return APPROVAL_PRESETS.has(value) ? value : "development";
}

function normalizeDecision(value) {
  if (value === "allow" || value === "deny" || value === "confirm") return value;
  if (value === "approval_required") return "confirm";
  return "confirm";
}

function result(decision, rule, reason, permissionClass = null, rememberScope = "none") {
  return Object.freeze({
    decision,
    rule,
    reason,
    permissionClass,
    rememberScope,
  });
}

function filesystemPath(operation) {
  const kind = operation.kind;
  const scope = operation.scope;
  const protectedRead = kind === "read" || kind === "list";
  if (scope === "system") {
    return result("deny", "system-path", "系统路径不允许由本机代理访问。");
  }
  if (scope === "sensitive") {
    return result("deny", "sensitive-path", "该路径属于默认排除的敏感位置。");
  }
  if (scope === "workspace") {
    return result("allow", "workspace-path", "当前工作区路径。");
  }
  if (scope === "known-folder") {
    return protectedRead
      ? result("confirm", "known-folder-read", "固定用户目录需要显式授权。", null, "connection")
      : result("allow", "known-folder-write", "普通本机路径。");
  }
  if (scope === "ordinary-host") {
    return protectedRead
      ? result("confirm", "ordinary-host-read", "工作区外的本机路径需要授权。", null, "connection")
      : result("allow", "ordinary-host-write", "普通本机路径。");
  }
  return result("deny", "invalid-path-scope", "未知本机路径范围被拒绝。");
}

function filesystemAction(operation) {
  const preset = normalizeApprovalPreset(operation.preset);
  const kind = operation.kind;
  if (operation.sensitive) {
    if (kind === "read" || kind === "list") {
      return result("confirm", "sensitive-read", "敏感位置仅可进行单次确认读取。", null, "single-use");
    }
    return result("deny", "sensitive-mutation", "敏感位置不允许修改或执行。");
  }
  if (preset === "full_control") {
    return result("allow", "full-control", "完全控制模式不要求普通本机操作确认。");
  }
  if (operation.network || kind === "network") {
    return result("confirm", "network", "任意网络操作仍需要确认。", null, "connection");
  }
  if (kind === "delete" || kind === "move" || kind === "overwrite") {
    return preset !== "cautious" && operation.withinWorkspace
      ? result("allow", "workspace-destructive", "当前模式允许工作区内的删除、移动或覆盖。")
      : result("confirm", "destructive", "工作区外的删除、移动或覆盖仍需要确认。", null, "connection");
  }
  if (kind === "read" || kind === "list") return result("allow", "ordinary-read", "普通读取无需确认。");
  if (kind === "update" || kind === "create") return result("allow", "ordinary-write", "普通文件新建或更新无需确认。");
  return result("confirm", "unknown-operation", "未知操作需要确认。", null, "connection");
}

function agentCommand(operation) {
  switch (operation.commandClass) {
    case "immutable-deny":
      return result("deny", "always-deny", "Command is blocked by the default policy");
    case "ssh":
      return result("confirm", "ssh-network", "SSH requires App-owned host validation and approval");
    case "git-read":
      return result("allow", "git-read-only", "Git operation is read-only");
    case "git-path-sensitive":
      return result("confirm", "git-path-sensitive", "Git options can access arbitrary paths, write output, or invoke external helpers");
    case "git-mutation":
      return result("confirm", "git-mutation", "Git mutations or path-sensitive operations require approval");
    case "project-check":
      return result("allow", "project-check", "Known project check");
    case "package-manager":
      return result("confirm", "package-manager", "Package-manager mutations or arbitrary scripts require approval");
    case "runtime-execution":
      return result("confirm", "runtime-execution", "Arbitrary runtime execution requires approval");
    case "sensitive-command":
      return result("confirm", "sensitive-command", "Command can modify the workspace or access external resources");
    default:
      return result("confirm", "default-ask", "Unknown commands require approval by default");
  }
}

function agentExecution(operation) {
  const baseDecision = normalizeDecision(operation.baseDecision);
  const baseRule = typeof operation.baseRule === "string" && operation.baseRule ? operation.baseRule : "default-ask";
  const baseReason = typeof operation.baseReason === "string" && operation.baseReason ? operation.baseReason : "Command policy requires approval";
  if (baseDecision === "deny") return result("deny", baseRule, baseReason);
  if (baseDecision !== "allow") return result("confirm", baseRule, baseReason);
  if (operation.sandboxVerified) return result("allow", baseRule, baseReason);
  const sandboxName = typeof operation.sandboxName === "string" && operation.sandboxName ? operation.sandboxName : "sandbox";
  return operation.sandboxEnforced
    ? result("confirm", "unverified-sandbox", `OS sandbox '${sandboxName}' is present but not verified for unattended execution`)
    : result("confirm", "unsandboxed-execution", `OS sandbox '${sandboxName}' is not enforced; host approval is required before spawning`);
}

function terminalCommand(operation) {
  const baseDecision = normalizeDecision(operation.baseDecision);
  const baseRule = typeof operation.baseRule === "string" && operation.baseRule ? operation.baseRule : "default-ask";
  const preset = normalizeApprovalPreset(operation.preset);
  if (baseDecision === "deny") return result("deny", baseRule, operation.baseReason || "命令策略已拒绝该操作。");
  if (preset === "full_control") return result("allow", "full-control", "完全控制模式不要求普通本机终端确认。");
  if (baseRule === "runtime-execution" || operation.projectScript) return result("allow", baseRule, "项目运行和项目脚本不再要求执行确认。");
  if (operation.networkCommand) return result("confirm", "network", "本机终端网络命令需要确认。", null, "connection");
  if (baseDecision === "allow") return result("allow", baseRule, "命令分类器已允许该本机操作。");
  if (operation.githubRead) return result("allow", baseRule, "只读 GitHub 查询可由 App-owned broker 自动执行。");
  if (operation.gitReadOnlyRemote) return result("allow", baseRule, "只读或仅更新 Git 元数据的远端查询可自动执行。");
  if (operation.safeDependencySync) return result("allow", baseRule, "禁用安装脚本的依赖同步可自动执行。");
  if (operation.safeWorkspaceUtility) return result("allow", baseRule, "低风险工作区工具无需确认。");
  return result("confirm", baseRule, "宿主终端命令未在低风险自动批准范围内。", null, "connection");
}

function hostCommand(operation) {
  const baseDecision = normalizeDecision(operation.baseDecision);
  const baseRule = typeof operation.baseRule === "string" && operation.baseRule ? operation.baseRule : "default-ask";
  const preset = normalizeApprovalPreset(operation.preset);
  const commandName = typeof operation.commandName === "string" && operation.commandName ? operation.commandName : baseRule;

  if (baseDecision === "deny") return result("deny", baseRule, operation.baseReason || "命令策略已拒绝该操作。");
  if (operation.sandboxExpanded) {
    const suffix = typeof operation.sandboxScopeKey === "string" && operation.sandboxScopeKey ? `:${operation.sandboxScopeKey}` : "";
    return result("confirm", "sandbox-expansion", "扩大沙箱访问范围需要确认。", `host:sandbox-expansion${suffix}`, "connection");
  }
  if (!operation.sandboxVerified) {
    return result("confirm", "unverified-sandbox", "只有已验证的系统沙箱命令可以自动审批。", `host:unverified-execution:${commandName}`, "connection");
  }
  if (preset === "full_control") return result("allow", "full-control", "完全控制模式自动批准已验证沙箱内的普通 Host 请求。");
  if (baseRule === "runtime-execution" || operation.projectScript) return result("allow", baseRule, "受验证沙箱内的项目运行不再要求执行确认。");
  if (baseDecision === "allow") return result("allow", baseRule, "命令分类器已确认该操作为低风险。");
  if (operation.gitTrustedSync) return result("allow", baseRule, "已验证沙箱内的受控 Git 同步自动批准。");
  if (operation.githubRead) return result("allow", baseRule, "已验证网络沙箱内的只读 GitHub 操作自动批准。");
  if (operation.safeDependencySync) return result("allow", baseRule, "禁用安装脚本的依赖同步自动批准。");
  if (operation.safeWorkspaceUtility) return result("allow", baseRule, "已验证沙箱内的常规工作区工具自动批准。");
  if (preset === "cautious") return result("confirm", baseRule, "谨慎模式只确认具有明显副作用或跨边界的权限。", null, "connection");
  if (operation.networkCommand || operation.gitPush || operation.gitRiskyRemote || operation.githubExternalWrite) {
    return result("confirm", baseRule, "自由网络访问或远端写入需要确认。", null, "connection");
  }
  if (baseRule === "package-manager") {
    return operation.safeDependencySync || operation.projectScript
      ? result("allow", baseRule, "已验证沙箱内的项目脚本或禁用安装脚本的依赖同步自动批准。")
      : result("confirm", baseRule, "依赖安装脚本或非标准包管理操作需要确认。", null, "connection");
  }
  if (baseRule === "git-mutation") {
    return operation.developmentGitMutation
      ? result("allow", baseRule, "已验证沙箱内的受控本地 Git 变更自动批准。")
      : result("confirm", baseRule, "可能丢失工作区内容的 Git 变更需要确认。", null, "connection");
  }
  if (baseRule === "runtime-execution") return result("allow", baseRule, "已验证沙箱内的项目运行时命令自动批准。");
  if (baseRule === "sensitive-command") {
    return operation.workspaceFileMutation
      ? result("allow", baseRule, "已验证沙箱把文件变更限制在工作区内。")
      : result("confirm", baseRule, "Docker 或权限类命令仍需要确认。", null, "connection");
  }
  if (preset !== "cautious" && operation.highAutonomyUtility) {
    return result("allow", baseRule, "已验证沙箱内的签名/验证工具自动批准。");
  }
  return result("confirm", baseRule, "未知命令仍需要确认。", null, "connection");
}

function ssh(operation) {
  if (!operation.safeOptions || !operation.targetAllowed || !operation.hasRemoteCommand) {
    return result("deny", "ssh-policy-deny", "SSH 请求不满足固定安全策略。");
  }
  return result("confirm", "ssh-network", "SSH requires App-owned host validation and approval", null, "connection");
}

function authorizeSecurityOperation(operation = {}) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return result("deny", "invalid-operation", "安全策略请求格式无效。");
  }
  switch (operation.type) {
    case "filesystem-path": return filesystemPath(operation);
    case "filesystem-action": return filesystemAction(operation);
    case "agent-command": return agentCommand(operation);
    case "agent-execution": return agentExecution(operation);
    case "terminal-command": return terminalCommand(operation);
    case "host-command": return hostCommand(operation);
    case "ssh": return ssh(operation);
    default: return result("deny", "invalid-operation", "未知安全策略操作被拒绝。");
  }
}

module.exports = {
  authorizeSecurityOperation,
  isImmutableDeniedExecutable,
  normalizeApprovalPreset,
};
