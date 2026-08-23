import test from "node:test";
import assert from "node:assert/strict";
import { createGoalSessionManager } from "../src/goal-session.js";

function approvalAwareTool() {
  return {
    name: "risky",
    async invoke(_input, trustedContext = {}) {
      if (typeof trustedContext.requestApproval !== "function") {
        return { status: "approval_required", approvalRequest: { id: "request-1" } };
      }
      const approved = await trustedContext.requestApproval({ id: "request-1" });
      return approved
        ? { status: "completed", exitCode: 0 }
        : { status: "approval_denied", approvalRequest: { id: "request-1" } };
    },
  };
}

test("a paused goal session resumes from its server-side checkpoint", async () => {
  const manager = createGoalSessionManager({
    tools: [approvalAwareTool()],
    goalVerificationTasks: [],
    goalAgentStep(state) {
      const completed = state.history.some(
        (event) => event.type === "tool_result" && event.result?.status === "completed",
      );
      return completed
        ? { type: "finish", summary: "goal completed" }
        : { type: "tool", tool: "risky", input: { action: "do-it" } };
    },
  });

  const started = await manager.start({ goal: "Complete an approved action", maxSteps: 10 });
  assert.equal(started.status, "blocked_approval");
  assert.equal(typeof started.sessionId, "string");
  assert.equal(Object.hasOwn(started, "checkpoint"), false);

  const paused = manager.status(started.sessionId);
  assert.equal(paused.status, "blocked_approval");
  assert.equal(paused.resumable, true);

  const resumed = await manager.resume(started.sessionId, {
    requestApproval() {
      return true;
    },
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.sessionId, started.sessionId);
  assert.equal(resumed.summary, "goal completed");

  const done = manager.status(started.sessionId);
  assert.equal(done.status, "completed");
  assert.equal(done.resumable, false);
  assert.equal(done.lastResult.summary, "goal completed");
});

test("terminal goal sessions cannot be resumed", async () => {
  const manager = createGoalSessionManager({
    tools: [],
    goalVerificationTasks: [],
    goalAgentStep() {
      return { type: "finish", summary: "done" };
    },
  });
  const started = await manager.start({ goal: "Finish immediately" });
  assert.equal(started.status, "completed");
  const resumed = await manager.resume(started.sessionId);
  assert.equal(resumed.status, "already_terminal");
});

test("a paused goal session can be canceled", async () => {
  const manager = createGoalSessionManager({
    tools: [],
    goalVerificationTasks: [],
    goalAgentStep() {
      return { type: "blocked", reason: "waiting for an external condition" };
    },
  });
  const started = await manager.start({ goal: "Wait for something" });
  assert.equal(started.status, "blocked");

  const canceled = manager.cancel(started.sessionId);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.resumable, false);
  const resumed = await manager.resume(started.sessionId);
  assert.equal(resumed.status, "already_terminal");
});

test("unknown sessions are reported without leaking manager internals", () => {
  const manager = createGoalSessionManager({
    tools: [],
    goalAgentStep() {
      return { type: "finish", summary: "unused" };
    },
  });
  assert.deepEqual(manager.status("missing"), { status: "not_found", sessionId: "missing" });
  assert.deepEqual(manager.cancel("missing"), { status: "not_found", sessionId: "missing" });
});
