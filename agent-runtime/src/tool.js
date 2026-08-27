import { discoverDependencySync } from "./dependency.js";
import {
  applyStructuredPatch,
  deleteWorkspaceFile,
  moveWorkspaceFile,
} from "./filesystem.js";
import { buildGitArgv, createGitRunner } from "./git.js";
import { buildGitHubArgv, createGitHubRunner } from "./github.js";
import { createGoalController } from "./goal-controller.js";
import { createFileGoalSessionStore } from "./goal-store.js";
import { createLocalBrokerClient, createLocalBrokerTools } from "./local-broker-client.js";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  searchWorkspaceText,
} from "./inspection.js";
import { sandboxPreparationDiagnostic, WINDOWS_NULL_DEVICE_CAPABILITY_NAME } from "./native-sandbox.js";
import { normalizedPlatform, stageWindowsNodeCliRuntime } from "./platform.js";
import { createProcessManager } from "./process-manager.js";
import { createProjectTaskRunner } from "./project-task.js";
import { createCommandRunner } from "./runner.js";
import { sandboxSummary } from "./sandbox.js";
import { searchFiles } from "./search-files.js";
import { INTERNAL_STATE_DIR, resolveModelWorkspaceCwd } from "./workspace.js";

function audit(logger, event) {
  try { logger?.record?.(event); } catch {}
}

function resolveWindowsHostPreparationState(windowsHostPreparationState, platform) {
  if (windowsHostPreparationState && typeof windowsHostPreparationState === "object") return windowsHostPreparationState;
  return Object.freeze({
    status: platform === "win32" ? "unknown" : "unsupported",
    usable: false,
    capabilityName: WINDOWS_NULL_DEVICE_CAPABILITY_NAME,
    reason: platform === "win32"
      ? "Windows host preparation has not been probed by the runtime host"
      : "Windows host preparation is not required on this platform",
    remediation: null,
  });
}

function resolveGitHubCliState(githubCliState) {
  if (githubCliState && typeof githubCliState === "object") return githubCliState;
  return Object.freeze({
    status: "unknown",
    resolvedPath: null,
    version: null,
    reason: "GitHub CLI has not been probed by the runtime host",
    remediation: null,
  });
}

function resolveNetworkSandboxState({ networkSandboxState, networkSandboxAdapter, platform = process.platform } = {}) {
  if (networkSandboxState && typeof networkSandboxState === "object") return networkSandboxState;
  if (networkSandboxAdapter) {
    const sandbox = sandboxSummary(networkSandboxAdapter);
    const usable = sandbox.autoRunSafe === true;
    return Object.freeze({
      status: usable ? "ready" : "unverified",
      usable,
      enabled: true,
      platform,
      allowNetwork: true,
      reason: usable ? "dedicated network sandbox is verified" : "dedicated network sandbox is not verified",
      recoverable: !usable,
      sandbox,
    });
  }
  return sandboxPreparationDiagnostic(null, { enabled: false, platform, allowNetwork: true });
}

const cwdSchema = { type: "string", minLength: 1, maxLength: 4_096, default: "." };
const envSchema = {
  type: "object",
  additionalProperties: { type: "string" },
  maxProperties: 16,
};
const argvSchema = {
  type: "array",
  minItems: 1,
  maxItems: 128,
  items: { type: "string", minLength: 1, maxLength: 16_384 },
};

export const runCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["argv"],
  properties: {
    argv: argvSchema,
    cwd: cwdSchema,
    timeoutMs: { type: "integer", minimum: 1, maximum: 120_000 },
    env: envSchema,
  },
});

export const runProjectTaskInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["task"],
  properties: {
    task: { type: "string", enum: ["test", "lint", "build", "typecheck", "check"] },
    cwd: cwdSchema,
    env: envSchema,
  },
});

export const processStartInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["argv"],
  properties: {
    argv: argvSchema,
    cwd: cwdSchema,
    env: envSchema,
    pty: { type: "boolean", default: false },
    cols: { type: "integer", minimum: 20, maximum: 400, default: 120 },
    rows: { type: "integer", minimum: 5, maximum: 200, default: 30 },
  },
});

export const processPollInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["processId"],
  properties: {
    processId: { type: "string", minLength: 1, maxLength: 128 },
    cursor: { type: "integer", minimum: 0, default: 0 },
    maxChunks: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  },
});

export const processInputInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["processId", "data"],
  properties: {
    processId: { type: "string", minLength: 1, maxLength: 128 },
    data: { type: "string", minLength: 1, maxLength: 64_000 },
  },
});

export const processKillInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["processId"],
  properties: {
    processId: { type: "string", minLength: 1, maxLength: 128 },
    force: { type: "boolean", default: true },
  },
});

export const processListInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export const readFileInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    startLine: { type: "integer", minimum: 1, maximum: 10_000_000, default: 1 },
    endLine: { type: "integer", minimum: 1, maximum: 10_000_000 },
    maxLines: { type: "integer", minimum: 1, maximum: 5_000, default: 400 },
    maxBytes: { type: "integer", minimum: 1_024, maximum: 1_000_000, default: 64_000 },
  },
});

export const listDirInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4_096, default: "." },
    recursive: { type: "boolean", default: false },
    maxDepth: { type: "integer", minimum: 1, maximum: 12, default: 3 },
    maxEntries: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
    includeHidden: { type: "boolean", default: false },
    includeIgnored: { type: "boolean", default: false },
  },
});

export const searchTextInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 8_192 },
    path: { type: "string", minLength: 1, maxLength: 4_096, default: "." },
    glob: { type: "string", minLength: 1, maxLength: 1_024, default: "**/*" },
    caseSensitive: { type: "boolean", default: false },
    contextLines: { type: "integer", minimum: 0, maximum: 20, default: 0 },
    maxResults: { type: "integer", minimum: 1, maximum: 2_000, default: 200 },
    maxFiles: { type: "integer", minimum: 1, maximum: 20_000, default: 5_000 },
    maxPreviewBytes: { type: "integer", minimum: 128, maximum: 32_000, default: 2_000 },
    includeHidden: { type: "boolean", default: false },
    includeIgnored: { type: "boolean", default: false },
  },
});

export const searchFilesInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    cwd: cwdSchema,
    glob: { type: "string", minLength: 1, maxLength: 1_024, default: "**/*" },
    limit: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
    includeHidden: { type: "boolean", default: false },
    includeIgnored: { type: "boolean", default: false },
  },
});

export const gitInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "status",
        "diff",
        "log",
        "show",
        "branch_list",
        "branch_create",
        "switch",
        "worktree_list",
        "worktree_create",
        "worktree_remove",
        "add",
        "commit",
        "fetch",
        "pull",
        "push",
        "restore",
      ],
    },
    cwd: cwdSchema,
    short: { type: "boolean" },
    staged: { type: "boolean" },
    stat: { type: "boolean" },
    paths: {
      type: "array",
      maxItems: 256,
      items: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    force: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    revision: { type: "string", minLength: 1, maxLength: 512 },
    name: { type: "string", minLength: 1, maxLength: 512 },
    message: { type: "string", minLength: 1, maxLength: 16_384 },
  },
});

export const dependencySyncInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    cwd: cwdSchema,
    allowScripts: { type: "boolean", default: false },
  },
});

export const githubInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["pr_view", "pr_create", "ci_status", "issue_view", "issue_create", "release_view", "release_create"] },
    cwd: cwdSchema,
    number: { type: "integer", minimum: 1, maximum: 1_000_000 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    title: { type: "string", minLength: 1, maxLength: 2_000 },
    body: { type: "string", maxLength: 64_000 },
    base: { type: "string", minLength: 1, maxLength: 512 },
    head: { type: "string", minLength: 1, maxLength: 512 },
    tag: { type: "string", minLength: 1, maxLength: 512 },
    draft: { type: "boolean", default: false },
    assets: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4_096 } },
  },
});

export const goalModeInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["goal"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 32_768 },
    cwd: cwdSchema,
    acceptanceCriteria: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 8_192 },
    },
    maxSteps: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    maxToolCalls: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    maxDurationMs: { type: "integer", minimum: 1, maximum: 1_800_000, default: 600_000 },
  },
});

export const goalSessionInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
  },
});

export const goalStepInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "tool", "input"],
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
    tool: { type: "string", minLength: 1, maxLength: 128 },
    input: { type: "object" },
  },
});

export const goalFinishInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "summary"],
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
    summary: { type: "string", minLength: 1, maxLength: 32_768 },
    evidence: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 8_192 },
    },
    criteriaEvidence: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "satisfied", "evidence"],
        properties: {
          criterion: { type: "string", minLength: 1, maxLength: 8_192 },
          satisfied: { type: "boolean" },
          evidence: { type: "string", minLength: 1, maxLength: 8_192 },
        },
      },
    },
  },
});

const shaSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };

export const applyPatchInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["changes"],
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path", "content"],
            properties: {
              type: { const: "add" },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              content: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path", "expectedSha256", "replacements"],
            properties: {
              type: { const: "update" },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              expectedSha256: shaSchema,
              replacements: {
                type: "array",
                minItems: 1,
                maxItems: 100,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["oldText", "newText"],
                  properties: {
                    oldText: { type: "string", minLength: 1 },
                    newText: { type: "string" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path", "expectedSha256"],
            properties: {
              type: { const: "delete" },
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              expectedSha256: shaSchema,
            },
          },
        ],
      },
    },
  },
});

export function createRunCommandTool({ workspace, defaultTimeoutMs = 120_000, sandboxAdapter, platform = process.platform, auditLogger } = {}) {
  return {
    name: "run_command",
    description: "Run an argv-based project command without a model-controlled shell. Commands may be allowed, denied, or require exact-request approval.",
    inputSchema: runCommandInputSchema,
    async invoke(input, trustedContext = {}) {
      if (platform === "win32" && /^git(?:\.exe)?$/i.test(input.argv?.[0] ?? "")) {
        return {
          status: "platform_error",
          platform,
          error: "Git for Windows cannot run inside the AppContainer because it requires the host NUL device; use the structured git tool, which is routed through the App-owned Git broker.",
        };
      }
      const run = createCommandRunner({ workspace, timeoutMs: input.timeoutMs ?? defaultTimeoutMs, sandboxAdapter, platform, auditLogger });
      return await run({ argv: input.argv, cwd: input.cwd ?? ".", env: input.env ?? {}, requestApproval: trustedContext.requestApproval, signal: trustedContext.signal });
    },
  };
}

export function createRunProjectTaskTool({ workspace, defaultTimeoutMs = 120_000, sandboxAdapter, platform = process.platform, auditLogger } = {}) {
  return {
    name: "run_project_task",
    description: "Discover and run a safe project test, lint, build, typecheck, or check task from a selected cwd.",
    inputSchema: runProjectTaskInputSchema,
    async invoke(input, trustedContext = {}) {
      const run = createProjectTaskRunner({ workspace, timeoutMs: defaultTimeoutMs, sandboxAdapter, platform, auditLogger });
      return await run({ task: input.task, cwd: input.cwd ?? ".", env: input.env ?? {}, requestApproval: trustedContext.requestApproval, signal: trustedContext.signal });
    },
  };
}

export function createGitTool({ workspace, defaultTimeoutMs = 120_000, sandboxAdapter, localBrokerSocket = "", platform = process.platform, auditLogger } = {}) {
  return {
    name: "git",
    description: "Run a structured Git operation, including isolated worktree management. Network Git sync/push and Windows Git run through the desktop App's policy-controlled local broker when available.",
    inputSchema: gitInputSchema,
    async invoke(input, trustedContext = {}) {
      const hasLocalBroker = typeof localBrokerSocket === "string" && localBrokerSocket.length > 0;
      if (platform === "win32" && !hasLocalBroker) {
        return {
          status: "platform_error",
          platform,
          error: "Windows structured Git requires the App-owned local broker because Git for Windows cannot open the NUL device from the AppContainer.",
        };
      }
      const networkGitAction = new Set(["fetch", "pull", "push"]).has(input.action);
      if ((platform === "win32" || networkGitAction) && hasLocalBroker) {
        const cwd = resolveModelWorkspaceCwd(workspace, input.cwd ?? ".", { platform }).cwd;
        const argv = buildGitArgv(input);
        const result = await createLocalBrokerClient({ socketPath: localBrokerSocket, timeoutMs: 5 * 60_000 })
          .request("local_run_command", { argv, cwd });
        return {
          status: "completed",
          exitCode: result?.code ?? -1,
          signal: result?.signal ?? null,
          stdout: result?.stdout ?? "",
          stderr: result?.stderr ?? "",
          stdoutTruncated: result?.truncated === true,
          stderrTruncated: false,
          cwd: input.cwd ?? ".",
          platform,
          resolvedArgv: argv,
          policy: {
            decision: "brokered",
            rule: platform === "win32" ? "app-owned-windows-git-broker" : "app-owned-network-git-broker",
          },
        };
      }
      const run = createGitRunner({ workspace, timeoutMs: defaultTimeoutMs, sandboxAdapter, platform, auditLogger });
      return await run(input, trustedContext);
    },
  };
}

export function createDependencySyncTool({ workspace, networkSandboxAdapter, networkSandboxState, processManager, platform = process.platform } = {}) {
  return {
    name: "dependency_sync",
    description: "Synchronize project dependencies using a structured package-manager command. Network access uses the dedicated network sandbox and always remains approval-controlled.",
    inputSchema: dependencySyncInputSchema,
    async invoke(input, trustedContext = {}) {
      if (!networkSandboxAdapter) {
        const diagnostic = resolveNetworkSandboxState({ networkSandboxState, networkSandboxAdapter, platform });
        return {
          status: "network_unavailable",
          error: `dedicated network sandbox is unavailable: ${diagnostic.status}`,
          diagnostic,
        };
      }
      if (!processManager || typeof processManager.start !== "function") {
        return { status: "platform_error", error: "shared process manager is unavailable for dependency synchronization" };
      }
      const allowScripts = input.allowScripts === true;
      const discovered = discoverDependencySync({ workspace, cwd: input.cwd ?? ".", allowScripts });
      const result = await processManager.start(
        { argv: discovered.argv, cwd: input.cwd ?? ".", env: { CI: "1" } },
        trustedContext,
        {
          sandboxAdapter: networkSandboxAdapter,
          platformRuntimeStager: stageWindowsNodeCliRuntime,
          kind: "dependency_sync",
          metadata: { ecosystem: discovered.ecosystem, allowScripts },
        },
      );
      return { ...result, ecosystem: discovered.ecosystem, allowScripts };
    },
  };
}

export function createGitHubTool({ workspace, networkSandboxAdapter, networkSandboxState, githubCliState, sandboxAdapter, localBrokerSocket = "", platform = process.platform, auditLogger } = {}) {
  return {
    name: "github",
    description: "Run bounded GitHub CLI actions for PRs, CI, issues, and releases. Authenticated desktop actions run through the App-owned broker so tokens remain in the OS keychain. Release assets must be workspace-relative.",
    inputSchema: githubInputSchema,
    async invoke(input, trustedContext = {}) {
      const githubCli = resolveGitHubCliState(githubCliState);
      if (githubCli.status === "missing" || githubCli.status === "broken") {
        return {
          status: githubCli.status === "missing" ? "github_cli_missing" : "github_cli_broken",
          error: `GitHub CLI is unavailable: ${githubCli.reason}`,
          githubCli,
        };
      }
      if (typeof localBrokerSocket === "string" && localBrokerSocket) {
        const cwd = resolveModelWorkspaceCwd(workspace, input.cwd ?? ".", { platform }).cwd;
        const result = await createLocalBrokerClient({ socketPath: localBrokerSocket, timeoutMs: 5 * 60_000 })
          .request("local_run_command", { argv: buildGitHubArgv(input), cwd });
        return {
          status: "completed",
          exitCode: result?.code ?? -1,
          signal: result?.signal ?? null,
          stdout: result?.stdout ?? "",
          stderr: result?.stderr ?? "",
          stdoutTruncated: result?.truncated === true,
          stderrTruncated: false,
          cwd: input.cwd ?? ".",
          platform,
          resolvedArgv: buildGitHubArgv(input),
          policy: { decision: "approval_required", rule: "app-owned-github-broker" },
        };
      }
      if (!networkSandboxAdapter) {
        const diagnostic = resolveNetworkSandboxState({ networkSandboxState, networkSandboxAdapter, platform });
        return {
          status: "network_unavailable",
          error: `dedicated network sandbox is unavailable: ${diagnostic.status}`,
          diagnostic,
        };
      }
      const run = createGitHubRunner({
        workspace,
        sandboxAdapter: networkSandboxAdapter,
        platform,
        auditLogger,
        githubCliPath: githubCli.status === "ready" ? githubCli.resolvedPath : undefined,
      });
      return await run(input, trustedContext);
    },
  };
}

export function createProcessTools(processManager) {
  return [
    {
      name: "process_start",
      description: "Start a sandboxed long-running project process. Optional PTY uses node-pty/ConPTY when available.",
      inputSchema: processStartInputSchema,
      invoke: (input, trustedContext = {}) => processManager.start(input, trustedContext),
    },
    {
      name: "process_poll",
      description: "Read bounded output and status from a managed long-running process.",
      inputSchema: processPollInputSchema,
      invoke: (input, trustedContext = {}) => processManager.poll(input, trustedContext),
    },
    {
      name: "process_input",
      description: "Write bounded input to a running managed process or PTY.",
      inputSchema: processInputInputSchema,
      invoke: (input, trustedContext = {}) => processManager.input(input, trustedContext),
    },
    {
      name: "process_kill",
      description: "Terminate a managed process tree using platform-native process-tree cleanup.",
      inputSchema: processKillInputSchema,
      invoke: (input, trustedContext = {}) => processManager.kill(input, trustedContext),
    },
    {
      name: "process_list",
      description: "List managed long-running processes and their bounded status.",
      inputSchema: processListInputSchema,
      invoke: (_input, trustedContext = {}) => processManager.list({}, trustedContext),
    },
  ];
}

export function createGoalModeTool(goalController) {
  return {
    name: "goal_mode",
    description: "Start a bounded coding goal. Continue goal_step/goal_finish in the same assistant turn while mustContinue=true; never ask the user to type 'continue' for normal progress.",
    inputSchema: goalModeInputSchema,
    invoke: (input) => goalController.start(input),
  };
}

export function createGoalStepTool(goalController) {
  return {
    name: "goal_step",
    description: "Perform one tracked action. continue_required/mustContinue=true means keep working in the same assistant turn.",
    inputSchema: goalStepInputSchema,
    invoke: (input, trustedContext = {}) => goalController.step(input, trustedContext),
  };
}

export function createGoalFinishTool(goalController) {
  return {
    name: "goal_finish",
    description: "Attempt completion with acceptance and project verification. On continue_required, fix the issue in the same assistant turn and retry.",
    inputSchema: goalFinishInputSchema,
    invoke: (input, trustedContext = {}) => goalController.finish(input, trustedContext),
  };
}

export function createGoalStatusTool(goalController) {
  return { name: "goal_status", description: "Read bounded goal status/history.", inputSchema: goalSessionInputSchema, invoke: (input) => goalController.status(input.sessionId) };
}

export function createGoalCancelTool(goalController) {
  return { name: "goal_cancel", description: "Cancel a non-terminal goal session and reclaim its owned running managed processes.", inputSchema: goalSessionInputSchema, invoke: (input) => goalController.cancel(input.sessionId) };
}

export function createReadFileTool({ workspace } = {}) {
  return {
    name: "read_file",
    description: "Read a bounded UTF-8 line range from one workspace file. Returns SHA-256 metadata and an executable nextAction when more lines remain.",
    inputSchema: readFileInputSchema,
    invoke: (input) => readWorkspaceFile({ workspace, ...input }),
  };
}

export function createListDirTool({ workspace } = {}) {
  return {
    name: "list_dir",
    description: "List a workspace directory with bounded optional recursion, deterministic ordering, and no symlink following.",
    inputSchema: listDirInputSchema,
    invoke: (input) => listWorkspaceDirectory({ workspace, ...input }),
  };
}

export function createSearchTextTool({ workspace } = {}) {
  return {
    name: "search_text",
    description: "Search UTF-8 project files for bounded literal text matches without running a shell or following symlinks.",
    inputSchema: searchTextInputSchema,
    invoke: (input) => searchWorkspaceText({ workspace, ...input }),
  };
}

export function createSearchFilesTool({ workspace } = {}) {
  return { name: "search_files", description: "Find project files with a bounded glob search without following symlinks.", inputSchema: searchFilesInputSchema, invoke: (input) => searchFiles({ workspace, ...input }) };
}

export function createApplyPatchTool({ workspace, auditLogger } = {}) {
  return {
    name: "apply_patch",
    description: "Apply a structured multi-file patch. Existing updates/deletes require current SHA-256 preconditions.",
    inputSchema: applyPatchInputSchema,
    invoke(input) {
      const result = applyStructuredPatch({ workspace, changes: input.changes });
      audit(auditLogger, { type: "apply_patch", changes: input.changes.map((change) => ({ type: change.type, path: change.path })), result });
      return result;
    },
  };
}

export function createDeleteFileTool({ workspace, auditLogger } = {}) {
  return {
    name: "delete_file",
    description: "Delete one project file after verifying its current SHA-256.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "expectedSha256"], properties: { path: { type: "string", minLength: 1, maxLength: 4_096 }, expectedSha256: shaSchema } },
    invoke(input) {
      const result = deleteWorkspaceFile({ workspace, ...input });
      audit(auditLogger, { type: "delete_file", path: input.path, result });
      return result;
    },
  };
}

export function createMoveFileTool({ workspace, auditLogger } = {}) {
  return {
    name: "move_file",
    description: "Move one project file inside the workspace after verifying its current SHA-256.",
    inputSchema: { type: "object", additionalProperties: false, required: ["from", "to", "expectedSha256"], properties: { from: { type: "string", minLength: 1, maxLength: 4_096 }, to: { type: "string", minLength: 1, maxLength: 4_096 }, expectedSha256: shaSchema } },
    invoke(input) {
      const result = moveWorkspaceFile({ workspace, ...input });
      audit(auditLogger, { type: "move_file", from: input.from, to: input.to, result });
      return result;
    },
  };
}

const V09_TOOLS = Object.freeze([
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel", "get_capabilities",
]);
const LOCAL_BROKER_TOOL_NAMES = Object.freeze([
  "local_list", "local_read", "local_request_sensitive_access", "local_stage_changes", "local_confirm_batch", "local_run_command",
]);

export function createCapabilitiesTool({
  sandboxAdapter,
  networkSandboxAdapter,
  networkSandboxState,
  githubCliState,
  windowsHostPreparationState,
  workspace,
  goalSessionStore,
  goalPersistSessions = false,
  localBrokerSocket,
  platform = process.platform,
  auditLogger,
} = {}) {
  return {
    name: "get_capabilities",
    description: "Describe v0.9 final-acceptance platform, sandbox, process, Goal Mode, MCP, worktree, and audit capabilities.",
    inputSchema: processListInputSchema,
    invoke() {
      const sandbox = sandboxSummary(sandboxAdapter);
      const networkSandbox = resolveNetworkSandboxState({ networkSandboxState, networkSandboxAdapter, platform });
      return {
        version: "0.9.1",
        releaseStage: "final-acceptance-candidate",
        platform: normalizedPlatform(platform),
        tools: [...V09_TOOLS, ...(typeof localBrokerSocket === "string" && localBrokerSocket ? LOCAL_BROKER_TOOL_NAMES : [])],
        sandbox,
        networkSandbox: {
          ...networkSandbox,
          usableForStructuredNetworkTools: networkSandbox.usable === true,
        },
        githubCli: resolveGitHubCliState(githubCliState),
        windowsHostPreparation: resolveWindowsHostPreparationState(windowsHostPreparationState, platform),
        nativePlatformSupport: {
          windows: "AppContainer compatibility backend + workspace/runtime ACL + Job Object + parent monitor; requires real Windows acceptance",
          macos: "Seatbelt policy + parent guard; requires real macOS acceptance",
          linux: "Bubblewrap namespace sandbox; requires real Linux acceptance when Linux is a release target",
        },
        releaseAcceptance: {
          requiredCommand: "npm run acceptance",
          perTargetOs: true,
          currentNativeSandboxVerified: sandbox.autoRunSafe === true,
        },
        workspaceInspection: {
          boundedReadFile: true,
          boundedListDir: true,
          literalSearchText: true,
          globFileSearch: true,
          executableContinuationHints: true,
          defaultIgnoredBuildAndCacheTrees: true,
        },
        processManager: { longRunning: true, pty: "optional-node-pty", processTreeKill: true },
        git: { structuredActions: true, worktrees: true },
        audit: { enabled: auditLogger?.enabled === true, hashChained: auditLogger?.enabled === true, orchestratorTerminalOutcomes: true },
        mcp: { serverV2Available: true, protocolRevision: "2026-07-28", mrtrApprovalSupported: true },
        goalMode: {
          orchestration: "explicit-session-handle",
          boundedByDefault: true,
          verifiesBeforeStoppingWhenChecksOrVerifierExist: true,
          pausesOnApprovalBlock: true,
          resumableSessions: true,
          sessionPersistence: goalSessionStore
            ? goalSessionStore.persistent === true ? `persistent-${goalSessionStore.kind ?? "custom"}` : `in-memory-${goalSessionStore.kind ?? "custom"}`
            : goalPersistSessions === true ? "persistent-file" : "in-memory-until-server-restart-or-ttl",
          repeatedActionDetection: true,
          boundedAgentHistory: true,
          singleWriterMutations: true,
          trackedActionsUseGoalStep: true,
          goalCwdScoped: typeof workspace === "string" && workspace.length > 0,
          cancelReclaimsOwnedProcesses: true,
          acceptanceCriteriaGate: true,
          externalOrchestratorCompatible: true,
        },
        guarantees: {
          shellDisabledForModelCommands: true,
          windowsBatchRequiresTrustedShim: true,
          workspaceCwdConfinement: true,
          shaPreconditionsForDestructiveFileChanges: true,
          modelCannotSelfApprove: true,
          hostApprovalIsBoundToExactAndResolvedRequest: true,
          unattendedExecutionRequiresVerifiedSandbox: true,
          goalModeCannotRunUnbounded: true,
          goalSessionMutationsSingleWriter: true,
          goalCancelReclaimsOwnedProcesses: true,
        },
      };
    },
  };
}

export function createCoreTools(options = {}) {
  const processManager = options.processManager ?? createProcessManager({
    workspace: options.workspace,
    sandboxAdapter: options.sandboxAdapter,
    platform: options.platform ?? process.platform,
    auditLogger: options.auditLogger,
    maxProcesses: options.maxProcesses ?? 32,
  });
  const baseTools = [
    createRunCommandTool(options),
    createRunProjectTaskTool(options),
    createGitTool(options),
    createDependencySyncTool({ ...options, processManager }),
    createGitHubTool(options),
    ...createProcessTools(processManager),
    createReadFileTool(options),
    createListDirTool(options),
    createSearchTextTool(options),
    createSearchFilesTool(options),
    createApplyPatchTool(options),
    createDeleteFileTool(options),
    createMoveFileTool(options),
    ...createLocalBrokerTools({ socketPath: options.localBrokerSocket }),
  ];
  const goalSessionStore = options.goalSessionStore ?? (
    options.goalPersistSessions === true
      ? createFileGoalSessionStore({ workspace: options.workspace, directoryName: options.goalSessionDirectory ?? `${INTERNAL_STATE_DIR}/goals` })
      : undefined
  );
  const goalController = createGoalController({
    workspace: options.workspace,
    tools: baseTools,
    sessionStore: goalSessionStore,
    verificationTasks: options.goalVerificationTasks ?? ["test", "lint", "typecheck"],
    strictVerification: options.goalStrictVerification === true,
    verifyCompletion: options.goalVerifyCompletion,
    repeatLimit: options.goalRepeatLimit ?? 3,
    maxSessions: options.goalMaxSessions ?? 100,
    sessionTtlMs: options.goalSessionTtlMs ?? 24 * 60 * 60_000,
  });
  return [
    ...baseTools,
    createGoalModeTool(goalController),
    createGoalStepTool(goalController),
    createGoalFinishTool(goalController),
    createGoalStatusTool(goalController),
    createGoalCancelTool(goalController),
    createCapabilitiesTool({ ...options, goalSessionStore, localBrokerSocket: options.localBrokerSocket }),
  ];
}