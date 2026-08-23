import { randomUUID } from "node:crypto";
import { createExternalGoalOrchestrator } from "./orchestrator.js";
import { createManagedWorktreeRunner } from "./worktree.js";

function safeAgentName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(value)) {
    throw new TypeError("agent name must contain only letters, numbers, dot, underscore, or dash");
  }
  return value;
}

function audit(logger, event) {
  try { logger?.record?.(event); } catch {}
}

export function createMultiAgentCoordinator({
  workspace,
  tools = [],
  sandboxAdapter,
  platform = process.platform,
  auditLogger,
  maxAgents = 4,
  maxModelTurns = 200,
} = {}) {
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) {
    throw new RangeError("maxAgents must be between 1 and 16");
  }
  const manageWorktree = createManagedWorktreeRunner({
    workspace,
    sandboxAdapter,
    platform,
    auditLogger,
  });
  const orchestrate = createExternalGoalOrchestrator({ tools, auditLogger, maxModelTurns });

  async function run({
    cwd = ".",
    goal,
    agents,
    baseRevision = "HEAD",
    budgets = {},
  } = {}, {
    createAgent,
    requestApproval,
    verifyCompletion,
  } = {}) {
    if (typeof goal !== "string" || goal.trim().length === 0) throw new TypeError("multi-agent goal must be non-empty");
    if (!Array.isArray(agents) || agents.length < 1 || agents.length > maxAgents) {
      throw new RangeError(`agents must contain between 1 and ${maxAgents} entries`);
    }
    if (typeof createAgent !== "function") throw new TypeError("multi-agent coordinator requires a trusted createAgent callback");

    const names = agents.map((entry) => safeAgentName(entry?.name));
    if (new Set(names).size !== names.length) throw new Error("agent names must be unique");
    const runId = randomUUID().replaceAll("-", "").slice(0, 12);
    const worktrees = [];

    for (const entry of agents) {
      const name = safeAgentName(entry.name);
      const worktreeName = `${runId}-${name}`;
      const branch = `lpc-${runId}-${name}`;
      const created = await manageWorktree({
        action: "create",
        cwd,
        name: worktreeName,
        branch,
        revision: baseRevision,
      }, { requestApproval });
      if (created.status !== "completed" || created.exitCode !== 0) {
        return {
          status: created.status ?? "worktree_create_failed",
          mustContinue: false,
          runId,
          cwd,
          failedAgent: name,
          worktrees,
          result: created,
        };
      }
      worktrees.push({
        agent: name,
        worktreeName,
        worktreePath: created.worktreePath,
        branch,
        goal: typeof entry.goal === "string" && entry.goal.trim() ? entry.goal.trim() : `${goal.trim()}\nAgent role: ${name}`,
        acceptanceCriteria: Array.isArray(entry.acceptanceCriteria) ? entry.acceptanceCriteria : [],
      });
    }

    audit(auditLogger, { type: "multi_agent_start", runId, cwd, goal, worktrees });
    const results = await Promise.all(worktrees.map(async (item) => {
      const supplied = await createAgent({
        runId,
        name: item.agent,
        branch: item.branch,
        worktreePath: item.worktreePath,
        goal: item.goal,
      });
      const modelStep = typeof supplied === "function" ? supplied : supplied?.modelStep;
      if (typeof modelStep !== "function") {
        return { agent: item.agent, status: "agent_factory_error", mustContinue: false, error: "createAgent must return modelStep" };
      }
      const result = await orchestrate({
        goal: item.goal,
        cwd: item.worktreePath,
        acceptanceCriteria: item.acceptanceCriteria,
        budgets,
      }, {
        modelStep,
        requestApproval,
        verifyCompletion,
      });
      return { agent: item.agent, branch: item.branch, worktreePath: item.worktreePath, ...result };
    }));

    const completed = results.every((entry) => entry.status === "completed");
    audit(auditLogger, { type: "multi_agent_result", runId, completed, results });
    return {
      status: completed ? "completed" : "partial",
      mustContinue: false,
      runId,
      cwd,
      goal: goal.trim(),
      worktrees,
      results,
      mergePolicy: "manual-or-primary-agent-reviewed",
    };
  }

  async function cleanup(runResult, { requestApproval } = {}) {
    if (!runResult || !Array.isArray(runResult.worktrees)) throw new TypeError("cleanup requires a coordinator run result");
    const results = [];
    for (const worktree of [...runResult.worktrees].reverse()) {
      results.push(await manageWorktree({
        action: "remove",
        cwd: runResult.cwd ?? ".",
        name: worktree.worktreeName,
        force: false,
      }, { requestApproval }));
    }
    return { status: results.every((entry) => entry.status === "completed" && entry.exitCode === 0) ? "completed" : "partial", results };
  }

  return Object.freeze({ run, cleanup, maxAgents });
}
