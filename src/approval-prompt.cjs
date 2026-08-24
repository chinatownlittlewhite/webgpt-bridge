const path = require("node:path");

function commandName(argv) {
  return path.basename(Array.isArray(argv) ? argv[0] || "" : "").toLowerCase();
}

function redactedArgv(argv) {
  if (!Array.isArray(argv)) return [];
  let redactNext = false;
  return argv.slice(0, 20).map((raw) => {
    const value = String(raw);
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (/^--?(?:password|passwd|token|secret|api[-_]?key|authorization)$/i.test(value)) {
      redactNext = true;
      return value;
    }
    return value
      .replace(/(Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, "$1[REDACTED]@");
  });
}

function networkTarget(argv) {
  for (const raw of Array.isArray(argv) ? argv : []) {
    const value = String(raw);
    if (!/^https?:\/\//i.test(value)) continue;
    try {
      const hostname = new URL(value).hostname;
      if (hostname) return hostname.length > 80 ? `${hostname.slice(0, 77)}…` : hostname;
    } catch {
      // Fall through to the generic external-service label.
    }
  }
  return "外部服务";
}

function shortSensitivePath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const hiddenIndex = parts.findIndex((part) => part.startsWith(".") && part.length > 1);
  if (hiddenIndex >= 0) return parts.slice(hiddenIndex, hiddenIndex + 3).join("/");
  return parts.slice(-2).join("/") || "敏感位置";
}

function projectScriptName(argv) {
  const script = String(argv?.[2] || "项目脚本");
  return script.length > 64 ? `${script.slice(0, 61)}…` : script;
}

function isGitRemote(argv) {
  return commandName(argv) === "git" && new Set(["push", "pull", "fetch", "clone", "remote", "submodule", "ls-remote"]).has(argv?.[1] || "");
}

function isSafeDependencySync(argv) {
  const command = commandName(argv);
  return ["npm", "pnpm", "yarn"].includes(command) && argv.includes("--ignore-scripts");
}

function terminalPresentation(request, mode) {
  const argv = request.argv || [];
  const rule = request.policy?.rule || "default-ask";
  const command = commandName(argv);
  let message = "允许执行当前项目操作？";
  let operation = "受控本机操作";
  let scope = "当前项目";
  let rememberKey = null;

  if (rule === "network" || command === "curl" || command === "wget") {
    message = "允许访问外部网络？";
    operation = `目标：${networkTarget(argv)}`;
    scope = "外部网络";
  } else if (rule === "git-mutation") {
    if (isGitRemote(argv)) {
      message = "允许修改远端 Git 仓库？";
      operation = "操作：Git 远端操作";
      scope = "远端仓库";
    } else {
      message = "允许修改当前项目的 Git 状态？";
      operation = "操作：本地 Git 变更";
      if (mode !== "cautious") rememberKey = "terminal:git-local";
    }
  } else if (rule === "package-manager") {
    if (argv[1] === "run") {
      message = "允许执行当前项目脚本？";
      operation = `操作：${projectScriptName(argv)}`;
    } else if (isSafeDependencySync(argv)) {
      message = "允许更新当前项目依赖？";
      operation = "操作：更新依赖（安装脚本已禁用）";
      if (mode !== "cautious") rememberKey = "terminal:dependency-sync";
    } else {
      message = "允许修改当前项目依赖？";
      operation = "操作：运行包管理器";
    }
  } else if (rule === "runtime-execution") {
    message = "允许执行当前项目代码？";
    operation = "操作：运行项目代码";
  } else if (rule === "sensitive-command") {
    message = "允许执行高风险项目操作？";
    operation = "操作：高风险工作区变更";
  }

  return {
    message,
    detail: `${operation}\n范围：${scope}`,
    rememberKey,
  };
}

function fileBatchPresentation(request, mode) {
  const changes = Array.isArray(request.changes) ? request.changes : [];
  const labels = { create: "新建", update: "更新", delete: "删除", move: "移动" };
  const counts = new Map();
  for (const change of changes) counts.set(change.type, (counts.get(change.type) || 0) + 1);
  const summary = ["create", "update", "delete", "move"]
    .filter((kind) => counts.has(kind))
    .map((kind) => `${labels[kind]} ${counts.get(kind)}`)
    .join(" · ");
  const destructive = changes.some((change) => change.type === "delete" || change.type === "move");
  const scope = request.scope === "outside-workspace" ? "工作区外" : "当前项目";
  return {
    message: destructive ? "允许删除或移动项目文件？" : "允许修改当前项目文件？",
    detail: `操作：${summary || "文件更新"}\n范围：${scope}`,
    rememberKey: request.rememberable !== false && mode !== "cautious" && destructive ? "files:destructive" : null,
  };
}

function sensitivePresentation(request) {
  return {
    message: request.operation === "list" ? "允许查看敏感目录？" : "允许读取敏感位置？",
    detail: `位置：${shortSensitivePath(request.path)}\n范围：仅本次访问`,
    rememberKey: null,
  };
}

function approvalPrompt(request, approvalMode = "cautious") {
  if (request?.kind === "terminal-command") return terminalPresentation(request, approvalMode);
  if (request?.kind === "local-file-batch") return fileBatchPresentation(request, approvalMode);
  return sensitivePresentation(request || {});
}

module.exports = { approvalPrompt, redactedArgv };
