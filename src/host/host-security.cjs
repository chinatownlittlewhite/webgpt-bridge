const { approvalPrompt } = require("../approval-prompt.cjs");
const { createApprovalSession } = require("../approval-session.cjs");
const { classifyHostCommandApproval, normalizeApprovalMode } = require("../local-policy.cjs");

function createHostSecurity({
  dialog,
  dialogOwner = () => undefined,
  appendLog = () => {},
  approvalSession = createApprovalSession(),
  initialApprovalMode = "development",
} = {}) {
  if (!dialog || typeof dialog.showMessageBox !== "function") throw new TypeError("dialog.showMessageBox is required");
  if (typeof dialogOwner !== "function") throw new TypeError("dialogOwner is required");
  if (typeof appendLog !== "function") throw new TypeError("appendLog is required");

  let approvalMode = normalizeApprovalMode(initialApprovalMode);

  function setApprovalMode(mode) {
    approvalMode = normalizeApprovalMode(mode);
    return approvalMode;
  }

  function getApprovalMode() {
    return approvalMode;
  }

  function clearApprovals() {
    approvalSession.clear();
  }

  async function confirmLocalOperation(request) {
    const explicitConsent = request?.kind === "sensitive-access" || request?.kind === "known-folder-access" || request?.kind === "host-path-access";
    if (!explicitConsent && approvalMode === "full_control") {
      appendLog("local-broker", "完全控制模式：自动批准本机权限请求");
      return true;
    }
    const prompt = approvalPrompt(request, approvalMode);
    if (approvalSession.isRemembered(prompt)) {
      appendLog("local-broker", `已按本次连接记忆自动批准：${prompt.message}`);
      return true;
    }
    const options = {
      type: "warning",
      buttons: ["取消", "允许"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "WebGPT Bridge · 权限请求",
      message: prompt.message,
      detail: prompt.detail,
    };
    const owner = dialogOwner();
    const response = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    const approved = response.response === 1;
    approvalSession.record(prompt, { approved });
    return approved;
  }

  async function confirmHostCommandApproval(params) {
    const request = params?.request;
    if (!request || typeof request !== "object" || !Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((value) => typeof value !== "string" || !value || value.includes("\0"))) {
      throw new Error("Agent 审批请求格式无效。");
    }
    if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Agent 审批请求缺少工作目录。");
    const authorization = classifyHostCommandApproval(request, approvalMode);
    if (authorization.decision === "deny") {
      appendLog("local-broker", `Agent 命令审批：已拒绝（${authorization.reason}）`);
      return { approved: false };
    }
    if (authorization.decision === "allow") {
      appendLog("local-broker", `Agent 命令审批：自动批准（${authorization.reason}）`);
      return { approved: true };
    }
    const approved = await confirmLocalOperation({
      kind: "terminal-command",
      argv: request.argv,
      cwd: request.cwd,
      policy: { ...request.policy, reason: authorization.reason || request.policy?.reason },
      rememberKey: authorization.rememberScope === "connection" ? authorization.permissionClass : undefined,
    });
    appendLog("local-broker", `Agent 命令审批：${approved ? "已批准" : "已取消"}`);
    return { approved };
  }

  return Object.freeze({
    setApprovalMode,
    getApprovalMode,
    clearApprovals,
    confirmLocalOperation,
    confirmHostCommandApproval,
  });
}

module.exports = { createHostSecurity };
