import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createApprovalRequest, requestHostApproval } from "./approval.js";
import { discoverManagedWorktreeGitAccess } from "./git-metadata.js";
import { resolvePlatformArgv } from "./platform.js";
import { classifyCommand } from "./policy.js";
import { killProcessTree, wrapWithParentGuard } from "./process-tree.js";
import {
  buildCommandEnvironment,
  effectiveCommandPolicy,
  validateCommandEnvironment,
} from "./runner.js";
import { normalizeSandboxAdapter, sandboxSummary, wrapWithSandbox } from "./sandbox.js";
import { resolveWorkspaceCwd } from "./workspace.js";

function audit(logger, event) {
  try { logger?.record?.(event); } catch {}
}

function relativeCwd(root, cwd) {
  return path.relative(root, cwd) || ".";
}

export function createProcessManager({
  workspace,
  sandboxAdapter,
  platform = process.platform,
  auditLogger,
  maxProcesses = 32,
  maxBufferBytes = 2_000_000,
  terminalTtlMs = 30 * 60_000,
} = {}) {
  if (!Number.isInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > 256) {
    throw new RangeError("maxProcesses must be between 1 and 256");
  }
  const sandbox = normalizeSandboxAdapter(sandboxAdapter);
  const records = new Map();

  function prune() {
    const cutoff = Date.now() - terminalTtlMs;
    for (const [id, record] of records) {
      if (record.status !== "running" && record.updatedAt < cutoff) records.delete(id);
    }
  }

  function push(record, stream, text) {
    const chunk = { sequence: record.nextSequence++, stream, text: String(text) };
    record.chunks.push(chunk);
    record.bufferBytes += Buffer.byteLength(chunk.text);
    while (record.bufferBytes > maxBufferBytes && record.chunks.length > 1) {
      const removed = record.chunks.shift();
      record.bufferBytes -= Buffer.byteLength(removed.text);
      record.droppedThrough = removed.sequence;
    }
    record.updatedAt = Date.now();
  }

  function canAccess(record, trustedContext = {}) {
    return !trustedContext.goalSessionId || record.ownerGoalSessionId === trustedContext.goalSessionId;
  }

  function summary(record) {
    return {
      processId: record.id,
      status: record.status,
      argv: record.argv,
      cwd: record.cwd,
      pty: record.pty,
      pid: record.pid,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      exitCode: record.exitCode,
      signal: record.signal,
    };
  }

  async function start({ argv, cwd = ".", env = {}, pty = false, cols = 120, rows = 30 } = {}, trustedContext = {}) {
    prune();
    if ([...records.values()].filter((record) => record.status === "running").length >= maxProcesses) {
      return { status: "capacity_reached", maxProcesses };
    }
    const basePolicy = classifyCommand(argv);
    const policy = effectiveCommandPolicy(basePolicy, sandbox);
    const sandboxInfo = sandboxSummary(sandbox);
    if (policy.decision === "deny") return { status: "denied", policy, sandbox: sandboxInfo };

    const validatedEnv = validateCommandEnvironment(env);
    const { root, cwd: resolvedCwd } = resolveWorkspaceCwd(workspace, cwd);
    const normalizedCwd = relativeCwd(root, resolvedCwd);
    const childEnv = buildCommandEnvironment(resolvedCwd, validatedEnv, platform);
    let platformCommand;
    try {
      platformCommand = resolvePlatformArgv(argv, { env: process.env, platform });
    } catch (error) {
      return { status: "platform_error", error: error instanceof Error ? error.message : String(error), policy, sandbox: sandboxInfo };
    }
    if (!platformCommand.resolved) {
      return { status: "spawn_error", error: `executable '${argv[0]}' was not found on the trusted PATH`, policy, sandbox: sandboxInfo };
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
      });
      const approval = await requestHostApproval(trustedContext.requestApproval, approvalRequest);
      if (approval.status !== "approved") {
        return {
          status: approval.status === "missing" ? "approval_required" : approval.status === "denied" ? "approval_denied" : "approval_error",
          approvalRequest,
          policy,
          sandbox: sandboxInfo,
          ...(approval.error ? { error: approval.error } : {}),
        };
      }
    }

    const managedGitAccess = discoverManagedWorktreeGitAccess(resolvedCwd);
    const spawnArgv = wrapWithSandbox(sandbox, {
      argv: platformCommand.argv,
      cwd: resolvedCwd,
      workspace: resolvedCwd,
      extraReadPaths: [
        ...(platformCommand.trustedReadPaths ?? []),
        ...managedGitAccess.extraReadPaths,
      ],
      extraWritePaths: managedGitAccess.extraWritePaths,
    });
    const executionArgv = wrapWithParentGuard(spawnArgv, { platform });
    const id = randomUUID();
    const record = {
      id,
      argv: [...argv],
      resolvedArgv: [...platformCommand.argv],
      cwd: normalizedCwd,
      pty: pty === true,
      pid: null,
      status: "starting",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      exitCode: null,
      signal: null,
      chunks: [],
      bufferBytes: 0,
      nextSequence: 1,
      droppedThrough: 0,
      child: null,
      terminal: null,
      stdin: null,
      ownerGoalSessionId: typeof trustedContext.goalSessionId === "string" ? trustedContext.goalSessionId : null,
    };
    records.set(id, record);

    if (pty === true) {
      let ptyModule;
      try {
        ptyModule = await import("node-pty");
      } catch {
        records.delete(id);
        return { status: "unavailable", reason: "PTY support requires optional dependency 'node-pty'" };
      }
      const terminal = ptyModule.spawn(executionArgv[0], executionArgv.slice(1), {
        cwd: resolvedCwd,
        env: childEnv,
        cols: Math.max(20, Math.min(400, cols)),
        rows: Math.max(5, Math.min(200, rows)),
        name: "xterm-256color",
      });
      record.terminal = terminal;
      record.pid = terminal.pid;
      record.status = "running";
      terminal.onData((data) => push(record, "pty", data));
      terminal.onExit(({ exitCode, signal }) => {
        record.status = "exited";
        record.exitCode = exitCode;
        record.signal = signal;
        record.updatedAt = Date.now();
        audit(auditLogger, { type: "managed_process_exit", processId: id, exitCode, signal });
      });
    } else {
      const child = spawn(executionArgv[0], executionArgv.slice(1), {
        cwd: resolvedCwd,
        env: childEnv,
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      record.child = child;
      record.stdin = child.stdin;
      record.pid = child.pid;
      record.status = "running";
      child.stdout?.on("data", (data) => push(record, "stdout", data.toString("utf8")));
      child.stderr?.on("data", (data) => push(record, "stderr", data.toString("utf8")));
      child.on("error", (error) => push(record, "stderr", `process error: ${error.message}\n`));
      child.on("close", (code, signal) => {
        record.status = "exited";
        record.exitCode = code;
        record.signal = signal;
        record.updatedAt = Date.now();
        audit(auditLogger, { type: "managed_process_exit", processId: id, exitCode: code, signal });
      });
    }

    audit(auditLogger, {
      type: "managed_process_start",
      processId: id,
      argv,
      resolvedArgv: platformCommand.argv,
      cwd: normalizedCwd,
      pty: record.pty,
      pid: record.pid,
      sandbox: sandboxInfo,
    });
    return {
      status: "running",
      ...summary(record),
      policy,
      sandbox: sandboxInfo,
      approvalRequest,
      nextAction: {
        tool: "process_poll",
        arguments: { processId: id, cursor: 0, maxChunks: 100 },
      },
    };
  }

  function poll({ processId, cursor = 0, maxChunks = 100 } = {}, trustedContext = {}) {
    prune();
    const record = records.get(processId);
    if (!record || !canAccess(record, trustedContext)) return { status: "not_found", processId };
    const limit = Math.max(1, Math.min(500, maxChunks));
    const chunks = record.chunks.filter((chunk) => chunk.sequence > cursor).slice(0, limit);
    const nextCursor = chunks.length > 0 ? chunks[chunks.length - 1].sequence : cursor;
    return {
      ...summary(record),
      chunks,
      nextCursor,
      truncatedBeforeCursor: cursor < record.droppedThrough,
      droppedThrough: record.droppedThrough,
      nextAction: record.status === "running"
        ? {
            tool: "process_poll",
            arguments: { processId, cursor: nextCursor, maxChunks: limit },
          }
        : null,
    };
  }

  function input({ processId, data } = {}, trustedContext = {}) {
    const record = records.get(processId);
    if (!record || !canAccess(record, trustedContext)) return { status: "not_found", processId };
    if (record.status !== "running") return { status: "not_running", ...summary(record) };
    if (typeof data !== "string" || data.length === 0 || Buffer.byteLength(data) > 64_000) {
      throw new TypeError("process input must be a non-empty string up to 64000 bytes");
    }
    if (record.terminal) record.terminal.write(data);
    else if (record.stdin?.writable) record.stdin.write(data);
    else return { status: "stdin_unavailable", ...summary(record) };
    audit(auditLogger, { type: "managed_process_input", processId, bytes: Buffer.byteLength(data) });
    return { status: "written", processId, bytes: Buffer.byteLength(data) };
  }

  async function kill({ processId, force = true } = {}, trustedContext = {}) {
    const record = records.get(processId);
    if (!record || !canAccess(record, trustedContext)) return { status: "not_found", processId };
    if (record.status !== "running") return { status: "already_terminal", ...summary(record) };
    let killed = false;
    if (record.terminal) {
      try { record.terminal.kill(); killed = true; } catch {}
    } else if (record.child) {
      killed = await killProcessTree(record.child, { platform, force });
    }
    audit(auditLogger, { type: "managed_process_kill", processId, force, killed });
    return { ...summary(record), status: killed ? "kill_requested" : "kill_failed" };
  }

  function list(_input = {}, trustedContext = {}) {
    prune();
    return { processes: [...records.values()].filter((record) => canAccess(record, trustedContext)).map(summary) };
  }

  async function close() {
    const running = [...records.values()].filter((record) => record.status === "running");
    await Promise.all(running.map((record) => kill({ processId: record.id, force: true }).catch(() => ({ status: "kill_failed" }))));
    return { status: "closed", processesTerminated: running.length };
  }

  return Object.freeze({ start, poll, input, kill, list, close });
}
