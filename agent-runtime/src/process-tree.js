import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function windowsSystemExecutable(name, env = process.env) {
  const root = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

export async function killProcessTree(child, {
  platform = process.platform,
  force = true,
  env = process.env,
} = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;

  if (platform === "win32") {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // taskkill below is the authoritative Windows tree cleanup path.
    }
    return await new Promise((resolve) => {
      const taskkill = spawn(
        windowsSystemExecutable("taskkill.exe", env),
        ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      taskkill.once("error", () => resolve(false));
      taskkill.once("close", (code) => resolve(code === 0 || code === 128));
    });
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

export function wrapWithParentGuard(argv, {
  platform = process.platform,
  parentPid = process.pid,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("parent guard argv must be non-empty");
  if (platform !== "darwin") return [...argv];
  const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "parent-guard.js");
  return [process.execPath, guard, String(parentPid), "--", ...argv];
}

export const processTreeSecurityNotes = Object.freeze({
  windows: "taskkill-tree-plus-native-job-object-and-parent-monitor-when-sandboxed",
  macos: "dedicated-process-group-plus-trusted-parent-guard",
  linux: "dedicated-process-group-plus-bubblewrap-die-with-parent-when-sandboxed",
});
