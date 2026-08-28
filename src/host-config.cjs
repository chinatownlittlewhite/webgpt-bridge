const { normalizeSshAllowedHosts } = require("./ssh-policy.cjs");

function normalizeHttpsProxy(value = "") {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new TypeError("HTTPS 代理必须是字符串或端口。");
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("HTTPS 代理端口必须在 1–65535 之间。");
    return `http://127.0.0.1:${port}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("HTTPS 代理 URL 格式无效。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new TypeError("HTTPS 代理仅支持 http/https 协议。");
  if (parsed.username || parsed.password) throw new TypeError("HTTPS 代理 URL 不允许包含凭据。");
  if (!parsed.hostname) throw new TypeError("HTTPS 代理 URL 缺少主机名。");
  if (parsed.pathname && parsed.pathname !== "/") throw new TypeError("HTTPS 代理 URL 不允许包含路径。");
  if (parsed.search || parsed.hash) throw new TypeError("HTTPS 代理 URL 不允许包含 query/hash。");
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeSettings(input = {}, defaults = {}) {
  const proxyValue = Object.hasOwn(input, "httpsProxy") ? input.httpsProxy : defaults.httpsProxy;
  const sshHostsValue = Object.hasOwn(input, "sshAllowedHosts") ? input.sshAllowedHosts : defaults.sshAllowedHosts;
  return {
    ...defaults,
    ...input,
    agentMode: "bundled",
    developmentPath: "",
    httpsProxy: normalizeHttpsProxy(proxyValue),
    sshEnabled: input.sshEnabled === true,
    sshAllowedHosts: normalizeSshAllowedHosts(sshHostsValue),
    approvalMode: ["cautious", "development", "auto", "full_control"].includes(input.approvalMode) ? input.approvalMode : "development",
    designIssueJournal: input.designIssueJournal === true,
  };
}

function validateDevelopmentRuntime(settings) {
  return { mode: "bundled", workspacePath: settings.workspacePath, runtimePath: settings.runtimePath };
}

module.exports = { normalizeHttpsProxy, normalizeSettings, validateDevelopmentRuntime };
