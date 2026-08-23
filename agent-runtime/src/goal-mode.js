import { createHash } from "node:crypto";
import { validateJsonSchema } from "./schema-validate.js";

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const DEFAULT_REPEAT_LIMIT = 3;
const MAX_HISTORY_EVENTS = 80;
const MAX_AGENT_HISTORY_EVENTS = 40;
const MAX_EVENT_BYTES = 32_000;

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertPositiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function normalizeGoalInput({
  goal,
  cwd = ".",
  maxSteps = DEFAULT_MAX_STEPS,
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
} = {}) {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new TypeError("goal must be a non-empty string");
  }
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    throw new TypeError("cwd must be a non-empty string without NUL bytes");
  }
  return {
    goal: goal.trim(),
    cwd,
    maxSteps: assertPositiveInteger(maxSteps, "maxSteps", 200),
    maxToolCalls: assertPositiveInteger(maxToolCalls, "maxToolCalls", 500),
    maxDurationMs: assertPositiveInteger(maxDurationMs, "maxDurationMs", 30 * 60_000),
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw new TypeError("agentStep must return an action object");
  }
  if (action.type === "tool") {
    if (typeof action.tool !== "string" || action.tool.length === 0) {
      throw new TypeError("tool action requires a tool name");
    }
    if (!action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
      throw new TypeError("tool action requires an object input");
    }
    return {
      type: "tool",
      tool: action.tool,
      input: action.input,
      rationale: typeof action.rationale === "string" ? action.rationale : null,
    };
  }
  if (action.type === "finish") {
    if (typeof action.summary !== "string" || action.summary.trim().length === 0) {
      throw new TypeError("finish action requires a non-empty summary");
    }
    return {
      type: "finish",
      summary: action.summary.trim(),
      evidence: Array.isArray(action.evidence)
        ? action.evidence.filter((entry) => typeof entry === "string" && entry.length > 0).slice(0, 50)
        : [],
    };
  }
  if (action.type === "blocked") {
    return {
      type: "blocked",
      reason: typeof action.reason === "string" && action.reason.length > 0 ? action.reason : "agent reported a blocker",
    };
  }
  if (action.type === "fail") {
    return {
      type: "fail",
      reason: typeof action.reason === "string" && action.reason.length > 0 ? action.reason : "agent reported failure",
    };
  }
  throw new TypeError(`unsupported goal action type: ${String(action.type)}`);
}

function createToolMap(tools) {
  const map = new Map();
  for (const tool of tools ?? []) {
    if (!tool || typeof tool.name !== "string" || typeof tool.invoke !== "function") continue;
    if (tool.name.startsWith("goal_")) continue;
    if (map.has(tool.name)) throw new Error(`duplicate goal-mode tool: ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
}

function elapsedMs(state) {
  return state.elapsedBeforeResumeMs + (Date.now() - state.startedAt);
}

function publicState(state) {
  const omitted = Math.max(0, state.history.length - MAX_AGENT_HISTORY_EVENTS);
  const visibleHistory = state.history.slice(-MAX_AGENT_HISTORY_EVENTS);
  return Object.freeze({
    goal: state.goal,
    cwd: state.cwd,
    step: state.step,
    toolCalls: state.toolCalls,
    elapsedMs: elapsedMs(state),
    remainingSteps: Math.max(0, state.maxSteps - state.step),
    remainingToolCalls: Math.max(0, state.maxToolCalls - state.toolCalls),
    historyOmitted: omitted,
    history: Object.freeze(visibleHistory.map((entry) => Object.freeze({ ...entry }))),
  });
}

function addEvent(state, event) {
  const serialized = JSON.stringify(event);
  const bytes = Buffer.byteLength(serialized);
  const bounded = bytes > MAX_EVENT_BYTES
    ? { type: event.type, truncated: true, sha256: hashValue(event), bytes }
    : event;
  state.history.push(Object.freeze({ ...bounded }));
  if (state.history.length > MAX_HISTORY_EVENTS) {
    state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
  }
}

function checkpointState(state) {
  return Object.freeze({
    version: 1,
    goal: state.goal,
    cwd: state.cwd,
    maxSteps: state.maxSteps,
    maxToolCalls: state.maxToolCalls,
    maxDurationMs: state.maxDurationMs,
    elapsedActiveMs: elapsedMs(state),
    step: state.step,
    toolCalls: state.toolCalls,
    history: state.history.map((entry) => ({ ...entry })),
    repeatedActionHash: state.repeatedActionHash,
    repeatedActionCount: state.repeatedActionCount,
  });
}

function createState(config, checkpoint) {
  if (checkpoint === undefined || checkpoint === null) {
    return {
      ...config,
      startedAt: Date.now(),
      elapsedBeforeResumeMs: 0,
      step: 0,
      toolCalls: 0,
      history: [],
      repeatedActionHash: null,
      repeatedActionCount: 0,
    };
  }
  if (!checkpoint || checkpoint.version !== 1) {
    throw new TypeError("unsupported goal checkpoint");
  }
  if (checkpoint.goal !== config.goal || checkpoint.cwd !== config.cwd) {
    throw new Error("goal checkpoint does not match the requested goal and cwd");
  }
  const step = Number.isInteger(checkpoint.step) && checkpoint.step >= 0 ? checkpoint.step : 0;
  const toolCalls = Number.isInteger(checkpoint.toolCalls) && checkpoint.toolCalls >= 0 ? checkpoint.toolCalls : 0;
  const elapsedActive = Number.isInteger(checkpoint.elapsedActiveMs) && checkpoint.elapsedActiveMs >= 0
    ? checkpoint.elapsedActiveMs
    : 0;
  return {
    goal: config.goal,
    cwd: config.cwd,
    maxSteps: Math.min(config.maxSteps, checkpoint.maxSteps ?? config.maxSteps),
    maxToolCalls: Math.min(config.maxToolCalls, checkpoint.maxToolCalls ?? config.maxToolCalls),
    maxDurationMs: Math.min(config.maxDurationMs, checkpoint.maxDurationMs ?? config.maxDurationMs),
    startedAt: Date.now(),
    elapsedBeforeResumeMs: elapsedActive,
    step,
    toolCalls,
    history: Array.isArray(checkpoint.history)
      ? checkpoint.history.slice(-MAX_HISTORY_EVENTS).map((entry) => Object.freeze({ ...entry }))
      : [],
    repeatedActionHash: typeof checkpoint.repeatedActionHash === "string" ? checkpoint.repeatedActionHash : null,
    repeatedActionCount:
      Number.isInteger(checkpoint.repeatedActionCount) && checkpoint.repeatedActionCount >= 0
        ? checkpoint.repeatedActionCount
        : 0,
  };
}

function budgetStop(state) {
  const activeElapsedMs = elapsedMs(state);
  if (state.step >= state.maxSteps) {
    return { status: "budget_exhausted", reason: "step budget exhausted", elapsedMs: activeElapsedMs };
  }
  if (state.toolCalls >= state.maxToolCalls) {
    return { status: "budget_exhausted", reason: "tool-call budget exhausted", elapsedMs: activeElapsedMs };
  }
  if (activeElapsedMs >= state.maxDurationMs) {
    return { status: "budget_exhausted", reason: "duration budget exhausted", elapsedMs: activeElapsedMs };
  }
  return null;
}

function isApprovalBlock(result) {
  return result && typeof result === "object" && ["approval_required", "approval_denied", "approval_error"].includes(result.status);
}

async function runCompletionChecks({ tools, trustedContext, cwd, verificationTasks }) {
  const projectTask = tools.get("run_project_task");
  if (!projectTask || verificationTasks.length === 0) {
    return { passed: true, verified: false, checks: [] };
  }

  const checks = [];
  for (const task of verificationTasks) {
    try {
      const result = await projectTask.invoke({ task, cwd }, trustedContext);
      if (isApprovalBlock(result)) {
        return { passed: false, blocked: true, verified: false, checks, result };
      }
      checks.push({ task, status: result.status, exitCode: result.exitCode ?? null });
      if (result.status !== "completed" || result.exitCode !== 0) {
        return {
          passed: false,
          blocked: false,
          verified: true,
          checks,
          feedback: `${task} verification did not pass`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no safe '.+' task was found/.test(message)) {
        checks.push({ task, status: "not_available", exitCode: null });
        continue;
      }
      return {
        passed: false,
        blocked: false,
        verified: true,
        checks,
        feedback: `${task} verification failed to run: ${message}`,
      };
    }
  }

  const executed = checks.filter((check) => check.status !== "not_available");
  return { passed: true, verified: executed.length > 0, checks };
}

async function verifyFinish({ finish, state, tools, trustedContext, verificationTasks, verifyCompletion, strictVerification }) {
  const checks = await runCompletionChecks({
    tools,
    trustedContext,
    cwd: state.cwd,
    verificationTasks,
  });
  if (checks.blocked) return { outcome: "blocked", checks };
  if (!checks.passed) return { outcome: "continue", checks, feedback: checks.feedback };

  let custom = null;
  if (typeof verifyCompletion === "function") {
    const raw = await verifyCompletion({
      goal: state.goal,
      cwd: state.cwd,
      finish,
      checks: checks.checks,
      state: publicState(state),
    });
    custom = typeof raw === "boolean" ? { completed: raw } : raw;
    if (!custom || custom.completed !== true) {
      return {
        outcome: "continue",
        checks,
        feedback: custom?.feedback ?? "completion verifier rejected the finish proposal",
      };
    }
  }

  const verified = checks.verified || custom?.completed === true;
  if (strictVerification && !verified) {
    return {
      outcome: "continue",
      checks,
      feedback: "strict verification is enabled but no completion check or trusted verifier confirmed the goal",
    };
  }

  return { outcome: "complete", checks, verified, custom };
}

function stoppableResult(state, result) {
  return {
    ...result,
    goal: state.goal,
    steps: state.step,
    toolCalls: state.toolCalls,
    elapsedMs: elapsedMs(state),
    history: state.history,
    checkpoint: checkpointState(state),
  };
}

export function createGoalRunner({
  tools = [],
  agentStep,
  verifyCompletion,
  requestApproval,
  verificationTasks = ["test", "lint", "typecheck"],
  strictVerification = false,
  repeatLimit = DEFAULT_REPEAT_LIMIT,
} = {}) {
  if (typeof agentStep !== "function") {
    throw new TypeError("goal mode requires a trusted host agentStep callback");
  }
  if (!Array.isArray(verificationTasks) || verificationTasks.some((task) => !["test", "lint", "build", "typecheck", "check"].includes(task))) {
    throw new TypeError("verificationTasks contains an unsupported project task");
  }
  assertPositiveInteger(repeatLimit, "repeatLimit", 10);
  const toolMap = createToolMap(tools);
  const trustedContext = Object.freeze({
    requestApproval: typeof requestApproval === "function" ? requestApproval : undefined,
  });

  return async function runGoal(input, { checkpoint } = {}) {
    const config = normalizeGoalInput(input);
    const state = createState(config, checkpoint);

    while (true) {
      const budget = budgetStop(state);
      if (budget) return stoppableResult(state, budget);

      state.step += 1;
      let action;
      try {
        action = normalizeAction(await agentStep(publicState(state)));
      } catch (error) {
        return stoppableResult(state, {
          status: "agent_error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      addEvent(state, { type: "agent_action", step: state.step, action });

      if (action.type === "blocked") {
        return stoppableResult(state, { status: "blocked", reason: action.reason });
      }
      if (action.type === "fail") {
        return stoppableResult(state, { status: "failed", reason: action.reason });
      }

      if (action.type === "finish") {
        const verification = await verifyFinish({
          finish: action,
          state,
          tools: toolMap,
          trustedContext,
          verificationTasks,
          verifyCompletion,
          strictVerification,
        });
        addEvent(state, { type: "verification", step: state.step, verification });
        if (verification.outcome === "blocked") {
          return stoppableResult(state, {
            status: "blocked_approval",
            reason: "completion verification requires host approval",
            finish: action,
            verification,
          });
        }
        if (verification.outcome === "complete") {
          return {
            status: "completed",
            goal: state.goal,
            summary: action.summary,
            evidence: action.evidence,
            verified: verification.verified,
            verification,
            steps: state.step,
            toolCalls: state.toolCalls,
            elapsedMs: elapsedMs(state),
            history: state.history,
          };
        }
        addEvent(state, {
          type: "verification_feedback",
          step: state.step,
          feedback: verification.feedback,
        });
        continue;
      }

      const tool = toolMap.get(action.tool);
      if (!tool) {
        addEvent(state, {
          type: "tool_error",
          step: state.step,
          tool: action.tool,
          error: "tool is not available in goal mode",
        });
        continue;
      }

      try {
        validateJsonSchema(action.input, tool.inputSchema);
      } catch (error) {
        addEvent(state, {
          type: "tool_input_error",
          step: state.step,
          tool: action.tool,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const actionHash = hashValue({ tool: action.tool, input: action.input });
      if (actionHash === state.repeatedActionHash) state.repeatedActionCount += 1;
      else {
        state.repeatedActionHash = actionHash;
        state.repeatedActionCount = 1;
      }
      if (state.repeatedActionCount > repeatLimit) {
        return stoppableResult(state, {
          status: "stalled",
          reason: `the same tool action repeated more than ${repeatLimit} times`,
        });
      }

      state.toolCalls += 1;
      let result;
      try {
        result = await tool.invoke(action.input, trustedContext);
      } catch (error) {
        result = {
          status: "tool_error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      addEvent(state, {
        type: "tool_result",
        step: state.step,
        tool: action.tool,
        result,
      });

      if (isApprovalBlock(result)) {
        return stoppableResult(state, {
          status: "blocked_approval",
          reason: "a requested tool action requires host approval",
          pendingAction: action,
          pendingResult: result,
        });
      }
    }
  };
}

export const goalModeDefaults = Object.freeze({
  maxSteps: DEFAULT_MAX_STEPS,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxDurationMs: DEFAULT_MAX_DURATION_MS,
  repeatLimit: DEFAULT_REPEAT_LIMIT,
  maxHistoryEvents: MAX_HISTORY_EVENTS,
  maxAgentHistoryEvents: MAX_AGENT_HISTORY_EVENTS,
  maxEventBytes: MAX_EVENT_BYTES,
});
