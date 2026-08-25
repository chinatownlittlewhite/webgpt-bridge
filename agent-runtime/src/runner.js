import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createApprovalRequest, requestHostApproval } from "./approval.js";
import { discoverManagedWorktreeGitAccess } from "./git-metadata.js";
import { normalizedPlatform, resolvePlatformArgv, stageWindowsNodeCliRuntime } from "./platform.js";
import { classifyCommand } from "./policy.js";
import { killProcessTree, wrapWithParentGuard } from "./process-tree.js";
import { normalizeSandboxAdapter, sandboxSummary, wrapWithSandbox } from "./sandbox.js";
import { createWorkspaceTemp, INTERNAL_STATE_DIR, resolveModelWorkspaceCwd } from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const SAFE_ENV_KEYS = new Set(["CI", "NODE_ENV", "NO_COLOR", "FORCE_COLOR"]);

function audit(auditLogger, event) {
  try { auditLogger?.record?.(event); } catch {}
}

export function validateCommandEnvironment(additions = {}) {
  if (!additions || typeof additions !== "object" || Array.isArray(additions)) {
    throw new TypeError("env must be an object");
  }
  const validated = {};
  for (const [key, value] of Object.entries(additions)) {
    if (!SAFE_ENV_KEYS.has(key)) {
      throw new Error(`environment variable ${key} is not allowed`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError(`environment variable ${key} must be a string without NUL bytes`);
    }
    validated[key] = value;
  }
  return validated;
}

function ensurePlainDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) ensurePlainDirectory(parent);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`trusted host-private directory must not be a symbolic link: ${directory}`);
    }
    return directory;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(directory);
  return directory;
}

function trustedWindowsEnvironment(root, temp) {
  const profile = ensurePlainDirectory(path.join(root, INTERNAL_STATE_DIR, "windows-profile"));
  const appDataRoot = ensurePlainDirectory(path.join(profile, "AppData"));
  const appData = ensurePlainDirectory(path.join(appDataRoot, "Roaming"));
  const localAppData = ensurePlainDirectory(path.join(appDataRoot, "Local"));
  return {
    SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    OS: process.env.OS ?? "Windows_NT",
    USERPROFILE: profile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
  };
}

export function buildCommandEnvironment(root, additions = {}, platform = process.platform) {
  const temp = createWorkspaceTemp(root);
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: root,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    ...(platform === "win32" ? trustedWindowsEnvironment(root, temp) : {}),
    ...additions,
  };
}

function createCollector(maxBytes) {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    push(chunk) {
      if (truncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const kept = buffer.subarray(0, remaining);
      text += kept.toString("utf8");
      bytes += kept.length;
      if (kept.length < buffer.length) truncated = true;
    },
    result() {
      return { text, truncated, bytes };
    },
  };
}

export function effectiveCommandPolicy(basePolicy, sandbox) {
  if (basePolicy.decision !== "allow" || sandbox.autoRunSafe) return basePolicy;
  return {
    decision: "approval_required",
    reason: sandbox.enforced
      ? `OS sandbox '${sandbox.name}' is present but not verified for unattended execution`
      : `OS sandbox '${sandbox.name}' is not enforced; host approval is required before spawning`,
    rule: sandbox.enforced ? "unverified-sandbox" : "unsandboxed-execution",
    baseRule: basePolicy.rule,
  };
}

function relativeCwd(root, resolvedCwd) {
  return path.relative(root, resolvedCwd) || ".";
}

function normalizeTrustedExecutablePaths(bindings = {}, platform = process.platform) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError("trustedExecutablePaths must be an object");
  }
  const entries = Object.entries(bindings);
  if (entries.length > 16) throw new RangeError("trustedExecutablePaths may contain at most 16 entries");
  const normalized = {};
  for (const [rawName, rawPath] of entries) {
    if (typeof rawName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(rawName)) {
      throw new TypeError("trusted executable names must be simple command names");
    }
    if (typeof rawPath !== "string" || rawPath.includes("\0") || !(path.isAbsolute(rawPath) || (platform === "win32" && path.win32.isAbsolute(rawPath)))) {
      throw new TypeError(`trusted executable '${rawName}' must use an absolute path`);
    }
    normalized[rawName.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "")] = rawPath;
  }
  return Object.freeze(normalized);
}

function logicalCommandName(command) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0") || command.includes("/") || command.includes("\\")) {
    throw new Error("model command names must resolve through the trusted PATH and cannot select executable paths");
  }
  return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}

function normalizeSandboxAccessPaths(paths = [], label) {
  if (!Array.isArray(paths) || paths.length > 32) {
    throw new TypeError(`${label} must be an array with at most 32 trusted-host paths`);
  }
  return [...new Set(paths.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new TypeError(`${label} entries must be non-empty strings without NUL bytes`);
    }
    return path.resolve(entry);
  }))].sort();
}

function normalizeTrustedRuntimePathEntries(entries = [], root, platform = process.platform) {
  if (!Array.isArray(entries) || entries.length > 16) {
    throw new TypeError("trustedPathEntries must be an array with at most 16 trusted-host directories");
  }
  const impl = platform === "win32" ? path.win32 : path;
  const canonicalRoot = fs.realpathSync(root);
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.includes("\0") ||
      !(path.isAbsolute(entry) || (platform === "win32" && path.win32.isAbsolute(entry)))
    ) {
      throw new TypeError("trustedPathEntries entries must be absolute paths without NUL bytes");
    }
    const lexicalStat = fs.lstatSync(entry);
    if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
      throw new Error("trusted runtime PATH entries must be plain directories");
    }
    const canonicalEntry = fs.realpathSync(entry);
    const relative = impl.relative(canonicalRoot, canonicalEntry);
    if (relative.startsWith("..") || impl.isAbsolute(relative)) {
      throw new Error("trusted runtime PATH entries must remain inside the command cwd");
    }
    const key = platform === "win32" ? canonicalEntry.toLowerCase() : canonicalEntry;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(canonicalEntry);
    }
  }
  return normalized;
}

export function createCommandRunner({
  workspace,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  sandboxAdapter,
  platform = process.platform,
  auditLogger,
  trustedExecutablePaths = {},
  platformRuntimeStager = stageWindowsNodeCliRuntime,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${DEFAULT_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be a positive integer");
  }
  if (typeof platformRuntimeStager !== "function") {
    throw new TypeError("platformRuntimeStager must be a trusted host function");
  }
  const sandbox = normalizeSandboxAdapter(sandboxAdapter);
  const trustedExecutables = normalizeTrustedExecutablePaths(trustedExecutablePaths, platform);

  return async function runCommand({
    argv,
    cwd = ".",
    env = {},
    requestApproval,
    sandboxExtraReadPaths = [],
    sandboxExtraWritePaths = [],
  } = {}) {
    const basePolicy = classifyCommand(argv);
    const policy = effectiveCommandPolicy(basePolicy, sandbox);
    const sandboxInfo = sandboxSummary(sandbox);

    if (policy.decision === "deny") {
      audit(auditLogger, { type: "command_denied", argv, cwd, policy, sandbox: sandboxInfo });
      return { status: "denied", policy, sandbox: sandboxInfo };
    }

    const validatedEnv = validateCommandEnvironment(env);
    const { root, cwd: resolvedCwd } = resolveModelWorkspaceCwd(workspace, cwd, { platform });
    const normalizedCwd = relativeCwd(root, resolvedCwd);
    const trustedExtraReadPaths = normalizeSandboxAccessPaths(sandboxExtraReadPaths, "sandboxExtraReadPaths");
    const trustedExtraWritePaths = normalizeSandboxAccessPaths(sandboxExtraWritePaths, "sandboxExtraWritePaths");

    let platformCommand;
    try {
      const logicalCommand = logicalCommandName(argv?.[0]);
      const trustedExecutable = trustedExecutables[logicalCommand];
      platformCommand = trustedExecutable
        ? Object.freeze({
            platform: normalizedPlatform(platform),
            logicalCommand,
            argv: Object.freeze([trustedExecutable, ...argv.slice(1)]),
            resolved: true,
            usedTrustedShim: true,
            trustedReadPaths: Object.freeze([path.dirname(trustedExecutable)]),
          })
        : resolvePlatformArgv(argv, { env: process.env, platform });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(auditLogger, { type: "command_platform_error", argv, cwd: normalizedCwd, platform, error: message });
      return { status: "platform_error", policy, sandbox: sandboxInfo, error: message };
    }
    if (!platformCommand.resolved) {
      const error = `executable '${argv[0]}' was not found on the trusted PATH`;
      audit(auditLogger, { type: "command_not_found", argv, cwd: normalizedCwd, platform, error });
      return { status: "spawn_error", policy, sandbox: sandboxInfo, error };
    }
    try {
      platformCommand = platformRuntimeStager(platformCommand, {
        workspace: resolvedCwd,
        platform,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(auditLogger, { type: "command_platform_error", argv, cwd: normalizedCwd, platform, error: message });
      return { status: "platform_error", policy, sandbox: sandboxInfo, error: message };
    }

    let trustedRuntimePathEntries;
    try {
      trustedRuntimePathEntries = normalizeTrustedRuntimePathEntries(
        platformCommand.trustedPathEntries ?? [],
        resolvedCwd,
        platform,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit(auditLogger, { type: "command_platform_error", argv, cwd: normalizedCwd, platform, error: message });
      return { status: "platform_error", policy, sandbox: sandboxInfo, error: message };
    }
    const childEnv = buildCommandEnvironment(resolvedCwd, validatedEnv, platform);
    if (trustedRuntimePathEntries.length > 0) {
      const delimiter = platform === "win32" ? ";" : path.delimiter;
      childEnv.PATH = [...trustedRuntimePathEntries, childEnv.PATH].filter(Boolean).join(delimiter);
    }

    let approvalRequest = null;
    if (policy.decision === "approval_required") {
      approvalRequest = createApprovalRequest({
        argv,
        resolvedArgv: platformCommand.argv,
        platform: platformCommand.platform,
        cwd: normalizedCwd,
        env: validatedEnv,
        policy,
        sandbox,
        sandboxAccess: {
          read: trustedExtraReadPaths,
          write: trustedExtraWritePaths,
        },
      });
      audit(auditLogger, { type: "approval_requested", request: approvalRequest });
      const approval = await requestHostApproval(requestApproval, approvalRequest);
      if (approval.status === "missing") {
        return { status: "approval_required", policy, sandbox: sandboxInfo, approvalRequest };
      }
      if (approval.status === "denied") {
        audit(auditLogger, { type: "approval_denied", requestId: approvalRequest.id });
        return { status: "approval_denied", policy, sandbox: sandboxInfo, approvalRequest };
      }
      if (approval.status === "error") {
        audit(auditLogger, { type: "approval_error", requestId: approvalRequest.id, error: approval.error });
        return { status: "approval_error", policy, sandbox: sandboxInfo, approvalRequest, error: approval.error };
      }
      audit(auditLogger, { type: "approval_granted", requestId: approvalRequest.id });
    }

    const managedGitAccess = discoverManagedWorktreeGitAccess(resolvedCwd);
    const spawnArgv = wrapWithSandbox(sandbox, {
      argv: platformCommand.argv,
      cwd: resolvedCwd,
      workspace: resolvedCwd,
      extraReadPaths: [
        ...(platformCommand.trustedReadPaths ?? []),
        ...managedGitAccess.extraReadPaths,
        ...trustedExtraReadPaths,
      ],
      extraWritePaths: [
        ...managedGitAccess.extraWritePaths,
        ...trustedExtraWritePaths,
      ],
    });
    const executionArgv = wrapWithParentGuard(spawnArgv, { platform });
    const stdout = createCollector(maxOutputBytes);
    const stderr = createCollector(maxOutputBytes);
    const startedAt = Date.now();
    audit(auditLogger, {
      type: "command_spawn",
      argv,
      resolvedArgv: platformCommand.argv,
      cwd: normalizedCwd,
      platform: platformCommand.platform,
      policy,
      sandbox: sandboxInfo,
    });

    return await new Promise((resolve) => {
      let timedOut = false;
      let spawnError = null;
      const child = spawn(executionArgv[0], executionArgv.slice(1), {
        cwd: resolvedCwd,
        env: childEnv,
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk) => stdout.push(chunk));
      child.stderr?.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        spawnError = error;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void killProcessTree(child, { platform, force: true, env: childEnv });
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const out = stdout.result();
        const err = stderr.result();
        const result = {
          status: spawnError ? "spawn_error" : timedOut ? "timed_out" : "completed",
          exitCode: code,
          signal,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Date.now() - startedAt,
          cwd: normalizedCwd,
          platform: platformCommand.platform,
          resolvedArgv: [...platformCommand.argv],
          policy,
          sandbox: sandboxInfo,
          approvalRequest,
          error: spawnError ? spawnError.message : null,
        };
        audit(auditLogger, {
          type: "command_result",
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          cwd: normalizedCwd,
          argv,
          resolvedArgv: result.resolvedArgv,
          stdoutBytes: out.bytes,
          stderrBytes: err.bytes,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          error: result.error,
        });
        resolve(result);
      });
    });
  };
}

export const runnerSecurityNotes = Object.freeze({
  filesystemIsolation: "adapter-dependent",
  networkIsolation: "adapter-dependent",
  defaultSandbox: "none",
  autoAllowRequiresVerifiedSandbox: true,
  hostApprovalIsRequestBound: true,
  approvalBindsResolvedArgv: true,
  sandboxScope: "resolved-cwd",
  shell: false,
  windowsBatchFilesRequireTrustedShim: true,
  processTreeTermination: "platform-native",
  cwdSymlinkEscapeProtection: true,
});
