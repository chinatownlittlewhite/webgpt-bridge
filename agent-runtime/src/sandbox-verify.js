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

export function createSandboxProbeEnvironment(
  workspace,
  { platform = process.platform, sourceEnv = process.env } = {},
) {
  const temp = createWorkspaceTemp(workspace);
  const env = {
    PATH: sourceEnv.PATH ?? "",
    LANG: sourceEnv.LANG ?? "C.UTF-8",
    HOME: workspace,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
  };
  if (platform !== "win32") return env;

  // AppContainer process creation resolves profile storage through LOCALAPPDATA.
  // Keep that required host variable inside the workspace rather than exposing
  // the user's real profile directories to the sandboxed child.
  const profile = path.join(temp, "windows-profile");
  const appDataRoot = path.join(profile, "AppData");
  const appData = path.join(appDataRoot, "Roaming");
  const localAppData = path.join(appDataRoot, "Local");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  return {
    ...env,
    SystemRoot: sourceEnv.SystemRoot ?? sourceEnv.WINDIR ?? "C:\\Windows",
    WINDIR: sourceEnv.WINDIR ?? sourceEnv.SystemRoot ?? "C:\\Windows",
    PATHEXT: sourceEnv.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: profile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
}

function runProbe({ adapter, workspace, outsidePath, port, timeoutMs }) {
  const script = `
import fs from "node:fs";
import net from "node:net";
const [insidePath, outsidePath, portText] = process.argv.slice(1);
const result = { insideWrite: false, outsideReadBlocked: false, outsideWriteBlocked: false, loopbackAllowed: false, externalNetworkBlocked: false, nullDeviceReadWrite: process.platform !== "win32", nullDeviceFailure: null };
try { fs.writeFileSync(insidePath, "inside", "utf8"); result.insideWrite = true; } catch {}
if (process.platform === "win32") {
  let fd;
  let nullDeviceStage = "open";
  try {
    fd = fs.openSync("NUL", "r+");
    nullDeviceStage = "write";
    fs.writeSync(fd, Buffer.from("bridge-null-device-probe"));
    nullDeviceStage = "read";
    fs.readSync(fd, Buffer.alloc(1), 0, 1, null);
    result.nullDeviceReadWrite = true;
  } catch (error) {
    result.nullDeviceFailure = {
      stage: nullDeviceStage,
      code: error?.code ?? null,
      errno: error?.errno ?? null,
      syscall: error?.syscall ?? null,
      path: error?.path ?? null,
      message: typeof error?.message === "string" ? error.message.slice(0, 500) : null,
    };
  }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
try { fs.readFileSync(outsidePath, "utf8"); } catch { result.outsideReadBlocked = true; }
try { fs.writeFileSync(outsidePath, "modified", "utf8"); } catch { result.outsideWriteBlocked = true; }
await new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(portText) });
  const finish = (allowed) => { result.loopbackAllowed = allowed; socket.destroy(); resolve(); };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  setTimeout(() => finish(false), 750).unref();
});
await new Promise((resolve) => {
  const socket = net.createConnection({ host: "203.0.113.1", port: 443 });
  const finish = (blocked) => { result.externalNetworkBlocked = blocked; socket.destroy(); resolve(); };
  socket.once("connect", () => finish(false));
  socket.once("error", (error) => finish(error?.code === "EPERM" || error?.code === "EACCES"));
  setTimeout(() => finish(false), 750).unref();
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
      env: createSandboxProbeEnvironment(workspace),
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

export function evaluateSandboxProbeChecks({
  probeResult,
  loopbackConnected,
  requireNetworkBlocked = true,
  requireLoopback = true,
  requireNullDevice = false,
} = {}) {
  if (!probeResult || typeof probeResult !== "object") throw new TypeError("probeResult must be an object");
  if (typeof loopbackConnected !== "boolean") throw new TypeError("loopbackConnected must be a boolean");
  if (typeof requireNetworkBlocked !== "boolean") throw new TypeError("requireNetworkBlocked must be a boolean");
  if (typeof requireLoopback !== "boolean") throw new TypeError("requireLoopback must be a boolean");
  if (typeof requireNullDevice !== "boolean") throw new TypeError("requireNullDevice must be a boolean");

  const observedNetworkBlocked = probeResult.externalNetworkBlocked === true;
  const observedLoopbackAllowed = probeResult.loopbackAllowed === true && loopbackConnected;
  const loopbackPolicySatisfied = requireLoopback ? observedLoopbackAllowed : true;
  const checks = {
    insideWrite: probeResult.insideWrite === true,
    outsideReadBlocked: probeResult.outsideReadBlocked === true,
    outsideWriteBlocked: probeResult.outsideWriteBlocked === true,
    networkPolicySatisfied: requireNetworkBlocked
      ? loopbackPolicySatisfied && observedNetworkBlocked
      : true,
    nullDeviceReadWrite: requireNullDevice ? probeResult.nullDeviceReadWrite === true : true,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    observedNetworkBlocked,
    observedLoopbackAllowed,
  };
}

export async function verifySandboxAdapter({
  adapter,
  workspace,
  timeoutMs = 5_000,
  requireNetworkBlocked = true,
  requireLoopback = true,
  requireNullDevice = false,
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
  if (typeof requireLoopback !== "boolean") {
    throw new TypeError("requireLoopback must be a boolean");
  }
  if (typeof requireNullDevice !== "boolean") {
    throw new TypeError("requireNullDevice must be a boolean");
  }

  const root = resolveWorkspace(workspace);
  const probeWorkspace = fs.mkdtempSync(path.join(createWorkspaceTemp(root), "sandbox-probe-"));
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
      workspace: probeWorkspace,
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

    const evaluation = evaluateSandboxProbeChecks({
      probeResult: probe.result,
      loopbackConnected,
      requireNetworkBlocked,
      requireLoopback,
      requireNullDevice,
    });
    return {
      passed: evaluation.passed,
      adapter: normalized,
      reason: evaluation.passed ? "all sandbox checks passed" : "one or more sandbox checks failed",
      checks: evaluation.checks,
      observedNetworkBlocked: evaluation.observedNetworkBlocked,
      observedLoopbackAllowed: evaluation.observedLoopbackAllowed,
      requireNetworkBlocked,
      requireLoopback,
      requireNullDevice,
      nullDeviceFailure: requireNullDevice && !evaluation.checks.nullDeviceReadWrite
        ? probe.result.nullDeviceFailure ?? null
        : null,
      stderr: probe.stderr,
    };
  } finally {
    server.close();
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(probeWorkspace, { recursive: true, force: true });
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
