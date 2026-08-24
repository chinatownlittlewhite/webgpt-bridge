const path = require("node:path");

function bundledTunnelClientPath({ resourcesPath, platform = process.platform, pathImpl = path } = {}) {
  const executable = platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  return pathImpl.join(resourcesPath || "", "tunnel-client", executable);
}

function resolveTunnelClientPath({ customPath = "", bundledPath = "", isFile } = {}) {
  const check = typeof isFile === "function" ? isFile : () => false;
  const custom = typeof customPath === "string" ? customPath.trim() : "";
  if (custom && check(custom)) return custom;
  if (bundledPath && check(bundledPath)) return bundledPath;
  return "";
}

module.exports = { bundledTunnelClientPath, resolveTunnelClientPath };
