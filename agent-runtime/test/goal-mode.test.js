import test from "node:test";
import assert from "node:assert/strict";
import { createGoalRunner } from "../src/goal-mode.js";

function tool(name, invoke) {
  return { name, invoke };
}

test("goal mode keeps working until a verified finish succeeds", async () => {
  let calls = 0;
  const writeTool = tool("edit", async (input) => ({ status: "completed", changed: input.path }));
  const runProjectTask = tool("run_project_task", async ({ task }) => ({
    status: "completed",
    exitCode: 0,
    task,
  }));

  const runGoal = createGoalRunner({
    tools: [writeTool, runProjectTask],
    verificationTasks: ["test"],
    async agentStep(state) {
      calls += 1;
      if (state.toolCalls === 0) {
        return { type: "tool", tool: "edit", input: { path: "src/a.js" } };
      }
      return { type: "finish", summary: "fixed", evidence: ["tests pass"] };
    },
  });

  const result = await runGoal({ goal: "Fix the bug" });
  assert.equal(result.status, "completed");
  assert.equal(result.verified, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(calls, 2);
  assert.deepEqual(result.verification.checks.checks, [
    { task: "test", status: "completed", exitCode: 0 },
  ]);
});

test("a rejected completion is fed back and the loop continues", async () => {
  let finishCount = 0;
  const runGoal = createGoalRunner({
    tools: [],
    verificationTasks: [],
    strictVerification: true,
    verifyCompletion({ finish }) {
      finishCount += 1;
      return finishCount >= 2
        ? { completed: true }
        : { completed: false, feedback: `${finish.summary} is incomplete` };
    },
    agentStep(state) {
      const feedbackSeen = state.history.some((event) => event.type === "verification_feedback");
      return {
        type: "finish",
        summary: feedbackSeen ? "second attempt" : "first attempt",
      };
    },
  });

  const result = await runGoal({ goal: "Reach a verified finish", maxSteps: 5 });
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "second attempt");
  assert.equal(result.verified, true);
  assert.equal(finishCount, 2);
});

test("goal mode stops on an approval block instead of bypassing it", async () => {
  const risky = tool("run_command", async () => ({
    status: "approval_required",
    approvalRequest: { id: "abc" },
  }));
  const runGoal = createGoalRunner({
    tools: [risky],
    verificationTasks: [],
    agentStep() {
      return { type: "tool", tool: "run_command", input: { argv: ["npm", "install"] } };
    },
  });

  const result = await runGoal({ goal: "Install dependency" });
  assert.equal(result.status, "blocked_approval");
  assert.equal(result.pendingAction.tool, "run_command");
});

test("goal mode detects repeated identical actions", async () => {
  const noop = tool("noop", async () => ({ status: "completed" }));
  const runGoal = createGoalRunner({
    tools: [noop],
    verificationTasks: [],
    repeatLimit: 2,
    agentStep() {
      return { type: "tool", tool: "noop", input: { same: true } };
    },
  });

  const result = await runGoal({ goal: "Do not loop forever", maxSteps: 10 });
  assert.equal(result.status, "stalled");
  assert.equal(result.toolCalls, 2);
});

test("goal mode enforces step budgets", async () => {
  const runGoal = createGoalRunner({
    tools: [],
    verificationTasks: [],
    strictVerification: true,
    agentStep() {
      return { type: "finish", summary: "not verifiable" };
    },
  });

  const result = await runGoal({ goal: "Bound the loop", maxSteps: 2 });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.reason, "step budget exhausted");
});

test("goal mode validates tool input schemas before invoking tools", async () => {
  let invoked = false;
  const strictTool = {
    name: "strict",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "integer" } },
    },
    async invoke() {
      invoked = true;
      return { status: "completed" };
    },
  };
  const runGoal = createGoalRunner({
    tools: [strictTool],
    verificationTasks: [],
    agentStep(state) {
      const rejected = state.history.some((event) => event.type === "tool_input_error");
      return rejected
        ? { type: "finish", summary: "invalid action was rejected" }
        : { type: "tool", tool: "strict", input: { value: "not-an-integer", extra: true } };
    },
  });

  const result = await runGoal({ goal: "Reject malformed internal tool calls" });
  assert.equal(result.status, "completed");
  assert.equal(invoked, false);
  assert.equal(result.toolCalls, 0);
});

test("unavailable project checks are skipped instead of treated as success evidence", async () => {
  const runProjectTask = tool("run_project_task", async () => {
    throw new Error("no safe 'test' task was found in .");
  });
  const runGoal = createGoalRunner({
    tools: [runProjectTask],
    verificationTasks: ["test"],
    strictVerification: false,
    agentStep() {
      return { type: "finish", summary: "done" };
    },
  });

  const result = await runGoal({ goal: "Allow agent-declared completion when no verifier exists" });
  assert.equal(result.status, "completed");
  assert.equal(result.verified, false);
  assert.deepEqual(result.verification.checks.checks, [
    { task: "test", status: "not_available", exitCode: null },
  ]);
});
