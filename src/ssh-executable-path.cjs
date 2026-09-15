const fs = require("node:fs");
const path = require("node:path");

function resolveSshExecutable({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === "win32") {
    const rawSystemRoot = env.SystemRoot || env.WINDIR;
    if (typeof rawSystemRoot !== "string" || !rawSystemRoot) return "";
    const systemRoot = path.win32.normalize(rawSystemRoot);
    const driveRoot = path.win32.parse(systemRoot).root;
    if (!/^[A-Za-z]:\\$/.test(driveRoot)) return "";
    const candidate = path.win32.join(systemRoot, "System32", "OpenSSH", "ssh.exe");
    return exists(candidate) ? candidate : "";
  }
  const candidate = "/usr/bin/ssh";
  return exists(candidate) ? candidate : "";
}

module.exports = { resolveSshExecutable };
