import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { killProcessTree } from "./process-tree.js";
import { normalizeSandboxAdapter, wrapWithSandbox } from "./sandbox.js";
import { createWorkspaceTemp, resolveWorkspace } from "./workspace.js";

function listenLoopback() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function runProbe({ adapter, workspace, outsidePath, port, timeoutMs }) {
  const script = `
import fs from "node:fs";
import net from "node:net";
const [insidePath, outsidePath, portText] = process.argv.slice(1);
const result = { insideWrite: false, outsideReadBlocked: false, outsideWriteBlocked: false, networkBlocked: false };
try { fs.writeFileSync(insidePath, "inside", "utf8"); result.insideWrite = true; } catch {}
try { fs.readFileSync(outsidePath, "utf8"); } catch { result.outsideReadBlocked = true; }
try { fs.writeFileSync(outsidePath, "modified", "utf8"); } catch { result.outsideWriteBlocked = true; }
await new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(portText) });
  const finish = (blocked) => { result.networkBlocked = blocked; socket.destroy(); resolve(); };
  socket.once("connect", () => finish(false));
  socket.once("error", () => finish(true));
  setTimeout(() => finish(true), 750).unref();
});
process.stdout.write(JSON.stringify(result));
`;

  const insidePath = path.join(createWorkspaceTemp(workspace), "sandbox-verification-inside.txt");
  const argv = [process.execPath, "--input-type=module", "-e", script, insidePath, outsidePath, String(port)];
  const wrapped = wrapWithSandbox(adapter, {
    argv,
    cwd: workspace,
    workspace,
    extraReadPaths: [path.dirname(process.execPath)],
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(wrapped[0], wrapped.slice(1), {
      cwd: workspace,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        LANG: process.env.LANG ?? "C.UTF-8",
        HOME: workspace,
        TMPDIR: createWorkspaceTemp(workspace),
        TEMP: createWorkspaceTemp(workspace),
        TMP: createWorkspaceTemp(workspace),
        ...(process.platform === "win32" ? {
          SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        } : {}),
      },
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child, { platform: process.platform, force: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve({ ok: false, code, signal, stdout, stderr, timedOut });
        return;
      }
      try {
        resolve({ ok: true, result: JSON.parse(stdout), stderr });
      } catch (error) {
        resolve({ ok: false, error: `invalid probe output: ${error.message}`, stdout, stderr });
      }
    });
  });
}

export async function verifySandboxAdapter({
  adapter,
  workspace,
  timeoutMs = 5_000,
  requireNetworkBlocked = true,
} = {}) {
  const normalized = normalizeSandboxAdapter(adapter);
  if (!normalized.enforced) {
    return {
      passed: false,
      adapter: normalized,
      reason: "sandbox adapter is not enforced",
      checks: null,
    };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new RangeError("sandbox verification timeout must be between 500 and 30000 ms");
  }
  if (typeof requireNetworkBlocked !== "boolean") {
    throw new TypeError("requireNetworkBlocked must be a boolean");
  }

  const root = resolveWorkspace(workspace);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-sandbox-canary-"));
  const outsidePath = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outsidePath, "sandbox-canary-secret", "utf8");
  const { server, port } = await listenLoopback();
  let loopbackConnected = false;
  server.on("connection", (socket) => {
    loopbackConnected = true;
    socket.destroy();
  });

  try {
    const probe = await runProbe({
      adapter: normalized,
      workspace: root,
      outsidePath,
      port,
      timeoutMs,
    });
    if (!probe.ok) {
      return {
        passed: false,
        adapter: normalized,
        reason: "sandbox probe failed to execute",
        probe,
        checks: null,
      };
    }

    const observedNetworkBlocked = probe.result.networkBlocked === true && !loopbackConnected;
    const checks = {
      insideWrite: probe.result.insideWrite === true,
      outsideReadBlocked: probe.result.outsideReadBlocked === true,
      outsideWriteBlocked: probe.result.outsideWriteBlocked === true,
      networkPolicySatisfied: requireNetworkBlocked ? observedNetworkBlocked : true,
    };
    const passed = Object.values(checks).every(Boolean);
    return {
      passed,
      adapter: normalized,
      reason: passed ? "all sandbox checks passed" : "one or more sandbox checks failed",
      checks,
      observedNetworkBlocked,
      requireNetworkBlocked,
      stderr: probe.stderr,
    };
  } finally {
    server.close();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}

export function promoteVerifiedSandboxAdapter(adapter, verification) {
  const normalized = normalizeSandboxAdapter(adapter);
  if (
    !verification ||
    verification.passed !== true ||
    verification.adapter?.name !== normalized.name ||
    verification.adapter?.verificationId !== normalized.verificationId
  ) {
    throw new Error("a passing verification report for this exact sandbox configuration is required");
  }
  return Object.freeze({
    ...normalized,
    autoRunSafe: true,
  });
}
