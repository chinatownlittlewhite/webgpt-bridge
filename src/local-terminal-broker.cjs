const { spawn } = require("node:child_process");
const path = require("node:path");
const { classifyLocalTerminalApproval, normalizeApprovalMode } = require("./local-policy.cjs");

const BLOCKED_EXECUTABLES = new Set([
  "sudo", "su", "doas", "ssh", "scp", "sftp",
  "sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh",
]);
const MAX_OUTPUT_BYTES = 256 * 1024;

function assertArgv(argv, { fullControl = false } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("argv 必须是非空字符串数组，不能传入 shell 命令文本。");
  for (const value of argv) {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError("argv 每项必须是非空且不含 NUL 的字符串。");
  }
  if (!fullControl && (argv[0].includes("/") || argv[0].includes("\\"))) throw new TypeError("可执行文件必须通过受信任的 PATH 名称解析，不能提供路径。");
  if (!fullControl && BLOCKED_EXECUTABLES.has(argv[0].toLowerCase())) throw new Error(`${argv[0]} 不允许通过本机终端代理执行。`);
}

function defaultSpawnCommand(argv, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let size = 0;
    function collect(target, chunk) {
      if (size >= MAX_OUTPUT_BYTES) return;
      const limited = Buffer.from(chunk).subarray(0, MAX_OUTPUT_BYTES - size);
      size += limited.length;
      target.push(limited);
    }
    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({
      code: code ?? -1,
      signal: signal || undefined,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      truncated: size >= MAX_OUTPUT_BYTES,
    }));
  });
}

function needsNativeConfirmation(argv, classification, approvalMode) {
  return classifyLocalTerminalApproval({ argv, classification, approvalMode }).decision !== "allow";
}

function normalizeTrustedExecutables(bindings = {}) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new TypeError("trustedExecutables 必须是对象。");
  const normalized = {};
  for (const [name, executable] of Object.entries(bindings)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new TypeError("受信任可执行名称格式无效。");
    if (typeof executable !== "string" || !executable || executable.includes("\0") || !path.isAbsolute(executable)) {
      throw new TypeError(`受信任可执行文件 ${name} 必须是绝对路径。`);
    }
    normalized[name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "")] = executable;
  }
  return Object.freeze(normalized);
}

function createLocalTerminalBroker({ approvalMode = "cautious", classifyCommand, confirm = async () => false, spawnCommand = defaultSpawnCommand, pathPolicy, trustedExecutables = {} } = {}) {
  if (typeof classifyCommand !== "function") throw new TypeError("本机终端代理需要现有 Agent 的命令分类器。");
  const trusted = normalizeTrustedExecutables(trustedExecutables);

  async function run({ argv, cwd } = {}) {
    const mode = normalizeApprovalMode(approvalMode);
    assertArgv(argv, { fullControl: mode === "full_control" });
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new TypeError("cwd 必须是绝对目录路径。");
    if (pathPolicy) {
      const result = pathPolicy(cwd, { operation: "terminal" });
      if (result.decision !== "allow") throw new Error(result.reason || "终端工作目录不允许访问。");
      cwd = result.path || cwd;
    }
    const classification = mode === "full_control"
      ? { decision: "allow", reason: "完全控制模式允许本机终端执行。", rule: "full-control" }
      : classifyCommand(argv);
    if (!classification || classification.decision === "deny") throw new Error(classification?.reason || "此终端命令被默认策略拒绝。");
    const request = { kind: "terminal-command", argv: [...argv], cwd, policy: classification, approvalMode: mode };
    if (needsNativeConfirmation(argv, classification, mode) && !await confirm(request)) {
      throw new Error("用户取消了本机终端命令。 ");
    }
    const logicalCommand = path.basename(argv[0]).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
    const trustedExecutable = trusted[logicalCommand];
    const spawnArgv = trustedExecutable ? [trustedExecutable, ...argv.slice(1)] : [...argv];
    return spawnCommand(spawnArgv, { cwd, shell: false, windowsHide: true });
  }

  return { run };
}

module.exports = { assertArgv, createLocalTerminalBroker, defaultSpawnCommand, needsNativeConfirmation, normalizeTrustedExecutables };
