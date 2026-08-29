const net = require("node:net");
const { authorizeSecurityOperation } = require("../shared/security-policy-core.cjs");

const SSH_FORCED_OPTIONS = Object.freeze([
  "BatchMode=yes",
  "PasswordAuthentication=no",
  "KbdInteractiveAuthentication=no",
  "StrictHostKeyChecking=yes",
  "ClearAllForwardings=yes",
  "ForwardAgent=no",
  "ForwardX11=no",
]);

function normalizeSshAllowedHosts(value = []) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]+/) : [];
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const host = String(entry || "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (host.length > 253 || /[\s\/@]/.test(host)) throw new TypeError("SSH 允许列表只能包含主机名或 IP 地址。");
    if (!seen.has(host)) {
      seen.add(host);
      normalized.push(host);
    }
  }
  if (normalized.length > 128) throw new TypeError("SSH 允许列表最多包含 128 个主机。");
  return Object.freeze(normalized);
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 169 && parts[1] === 254 ||
    parts[0] === 192 && parts[1] === 168 ||
    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function isPrivateIpv6(host) {
  const lower = host.toLowerCase();
  if (lower === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  return false;
}

function isLocalOrPrivateHost(host) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

function parseTarget(target) {
  if (typeof target !== "string" || !target || target.includes("\0") || /[\r\n]/.test(target)) throw new TypeError("SSH 目标格式无效。");
  const at = target.lastIndexOf("@");
  const user = at >= 0 ? target.slice(0, at) : "";
  let host = at >= 0 ? target.slice(at + 1) : target;
  if (user && !/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new TypeError("SSH 用户名格式无效。");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.toLowerCase().replace(/\.$/, "");
  if (!host || /[\s\/@]/.test(host)) throw new TypeError("SSH 主机格式无效。");
  return { host, user };
}

function isAllowedSshHost(host, allowedHosts = []) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  return isLocalOrPrivateHost(normalized) || normalizeSshAllowedHosts(allowedHosts).includes(normalized);
}

function validateRemoteCommand(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error("SSH 必须提供非交互远程命令。");
  for (const arg of args) {
    if (typeof arg !== "string" || !arg || arg.includes("\0") || /[\r\n]/.test(arg)) throw new TypeError("SSH 远程命令参数格式无效。");
  }
}

function validateSshCommand(argv, { allowedHosts = [] } = {}) {
  if (!Array.isArray(argv) || argv.length < 2 || argv[0] !== "ssh") throw new TypeError("SSH 命令必须使用逻辑可执行名 ssh。");
  let index = 1;
  const retainedOptions = [];
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index];
    if (option !== "-p") throw new Error(`SSH 选项 ${option} 不允许；端口转发、跳板、配置/身份文件、TTY、后台与代理命令均被禁用。`);
    const portText = argv[index + 1];
    if (!/^\d+$/.test(String(portText || ""))) throw new TypeError("SSH 端口必须是 1–65535 的整数。");
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("SSH 端口必须是 1–65535 的整数。");
    retainedOptions.push("-p", String(port));
    index += 2;
  }

  const target = argv[index];
  if (!target) throw new TypeError("SSH 缺少目标主机。");
  const { host } = parseTarget(target);
  const targetAllowed = isAllowedSshHost(host, allowedHosts);
  const remoteCommand = argv.slice(index + 1);
  const authorization = authorizeSecurityOperation({
    type: "ssh",
    safeOptions: true,
    targetAllowed,
    hasRemoteCommand: remoteCommand.length > 0,
  });
  if (authorization.decision === "deny") {
    if (!targetAllowed) throw new Error("SSH 目标必须是私有/本地主机或出现在明确允许列表中。");
    if (remoteCommand.length === 0) throw new Error("SSH 必须提供非交互远程命令。");
    throw new Error(authorization.reason);
  }
  validateRemoteCommand(remoteCommand);

  const forced = SSH_FORCED_OPTIONS.flatMap((option) => ["-o", option]);
  return Object.freeze({
    host,
    argv: Object.freeze(["ssh", "-T", ...forced, ...retainedOptions, target, ...remoteCommand]),
  });
}

module.exports = {
  SSH_FORCED_OPTIONS,
  isAllowedSshHost,
  isLocalOrPrivateHost,
  normalizeSshAllowedHosts,
  validateSshCommand,
};
