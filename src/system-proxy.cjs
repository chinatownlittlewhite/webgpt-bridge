const { spawnSync: defaultSpawnSync } = require("node:child_process");

const LOOPBACK_NO_PROXY = Object.freeze(["127.0.0.1", "localhost", "::1"]);

function proxyEnvironmentFromUrl(proxyUrl, extraNoProxy = []) {
  if (!proxyUrl) return {};
  const noProxy = [...new Set([...LOOPBACK_NO_PROXY, ...extraNoProxy.map((value) => String(value).trim()).filter(Boolean)])];
  return Object.freeze({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: noProxy.join(","),
  });
}

function readScalar(output, key) {
  const match = String(output || "").match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^\\n]+)`));
  return match ? match[1].trim() : "";
}

function proxyUrl(host, port) {
  const normalizedHost = String(host || "").trim();
  const normalizedPort = Number(port);
  if (!normalizedHost || !Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) return "";
  const authority = normalizedHost.includes(":") && !normalizedHost.startsWith("[") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${authority}:${normalizedPort}`;
}

function parseExceptions(output) {
  const match = String(output || "").match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/);
  if (!match) return [];
  const values = [];
  const linePattern = /^\s*\d+\s*:\s*(.+?)\s*$/gm;
  let entry;
  while ((entry = linePattern.exec(match[1]))) values.push(entry[1]);
  return values;
}

function parseScutilProxy(output) {
  const httpEnabled = readScalar(output, "HTTPEnable") === "1";
  const httpsEnabled = readScalar(output, "HTTPSEnable") === "1";
  const httpProxy = httpEnabled ? proxyUrl(readScalar(output, "HTTPProxy"), readScalar(output, "HTTPPort")) : "";
  const httpsProxy = httpsEnabled ? proxyUrl(readScalar(output, "HTTPSProxy"), readScalar(output, "HTTPSPort")) : "";
  const exceptions = parseExceptions(output);
  return Object.freeze({ httpProxy, httpsProxy, exceptions: Object.freeze(exceptions) });
}

function resolveSystemProxyEnvironment({ explicitProxy = "", platform = process.platform, spawnSync = defaultSpawnSync } = {}) {
  if (explicitProxy) return proxyEnvironmentFromUrl(explicitProxy);
  if (platform !== "darwin") return {};
  const result = spawnSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!result || result.status !== 0) return {};
  const parsed = parseScutilProxy(result.stdout);
  if (!parsed.httpProxy && !parsed.httpsProxy) return {};
  const noProxy = [...new Set([...LOOPBACK_NO_PROXY, ...parsed.exceptions.map((value) => String(value).trim()).filter(Boolean)])].join(",");
  return Object.freeze({
    ...(parsed.httpProxy ? { HTTP_PROXY: parsed.httpProxy } : {}),
    ...(parsed.httpsProxy ? { HTTPS_PROXY: parsed.httpsProxy } : {}),
    NO_PROXY: noProxy,
  });
}

module.exports = { LOOPBACK_NO_PROXY, parseScutilProxy, proxyEnvironmentFromUrl, resolveSystemProxyEnvironment };
