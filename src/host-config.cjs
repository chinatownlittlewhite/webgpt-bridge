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

function boundedString(value, fallback = "", maxLength = 4096) {
  const selected = value == null ? fallback : value;
  if (selected == null) return "";
  if (typeof selected !== "string") throw new TypeError("设置值必须是字符串。");
  return selected.slice(0, maxLength);
}

function selected(input, defaults, key) {
  return Object.hasOwn(input, key) ? input[key] : defaults[key];
}

function copyOptionalString(result, input, defaults, key, maxLength = 4096) {
  if (!Object.hasOwn(input, key) && !Object.hasOwn(defaults, key)) return;
  result[key] = boundedString(selected(input, defaults, key), "", maxLength);
}

function normalizeSettings(input = {}, defaults = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("设置必须是对象。");
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) throw new TypeError("默认设置必须是对象。");
  const proxyValue = selected(input, defaults, "httpsProxy");
  const sshHostsValue = selected(input, defaults, "sshAllowedHosts");
  const result = {
    agentMode: "bundled",
    developmentPath: "",
    httpsProxy: normalizeHttpsProxy(proxyValue),
    sshEnabled: selected(input, defaults, "sshEnabled") === true,
    sshAllowedHosts: normalizeSshAllowedHosts(sshHostsValue),
    approvalMode: ["cautious", "development", "auto", "full_control"].includes(selected(input, defaults, "approvalMode"))
      ? selected(input, defaults, "approvalMode")
      : "development",
    designIssueJournal: selected(input, defaults, "designIssueJournal") === true,
  };
  for (const key of ["workspacePath", "runtimePath", "tunnelClientPath", "nodePath"]) {
    copyOptionalString(result, input, defaults, key, 4096);
  }
  for (const key of ["tunnelId", "profile"]) copyOptionalString(result, input, defaults, key, 512);
  return result;
}

function validateDevelopmentRuntime(settings) {
  return { mode: "bundled", workspacePath: settings.workspacePath, runtimePath: settings.runtimePath };
}

module.exports = { normalizeHttpsProxy, normalizeSettings, validateDevelopmentRuntime };
