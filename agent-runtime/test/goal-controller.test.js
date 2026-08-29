import test from "node:test";
import assert from "node:assert/strict";
import { createGoalController } from "../src/goal-controller.js";

function makeTool(name, inputSchema, invoke) {
  return { name, inputSchema, invoke };
}

const objectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

test("explicit goal controller tracks actions and only completes through goal_finish", async () => {
  let edits = 0;
  const edit = makeTool(
    "edit",
    {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1 } },
    },
    async () => {
      edits += 1;
      return { status: "completed" };
    },
  );
  const controller = createGoalController({ tools: [edit], verificationTasks: [] });
  const started = controller.start({ goal: "Make one edit" });
  assert.equal(started.status, "active");
  assert.equal(started.mustContinue, true);

  const stepped = await controller.step({
    sessionId: started.sessionId,
    tool: "edit",
    input: { path: "src/a.js" },
  });
  assert.equal(stepped.status, "continue_required");
  assert.equal(stepped.mustContinue, true);
  assert.equal(edits, 1);

  const finished = await controller.finish({
    sessionId: started.sessionId,
    summary: "Edited the requested file",
    evidence: ["edit completed"],
  });
  assert.equal(finished.status, "completed");
  assert.equal(finished.mustContinue, false);
  assert.equal(finished.verified, false);
});

test("goal_finish runs available project verification and returns continue_required on failure", async () => {
  let pass = false;
  const projectTask = makeTool("run_project_task", objectSchema, async ({ task }) => ({
    status: "completed",
    exitCode: pass ? 0 : 1,
    task,
  }));
  const controller = createGoalController({
    tools: [projectTask],
    verificationTasks: ["test"],
  });
  const started = controller.start({ goal: "Get tests passing" });

  const rejected = await controller.finish({ sessionId: started.sessionId, summary: "done" });
  assert.equal(rejected.status, "continue_required");
  assert.match(rejected.feedback, /test verification did not pass/);

  pass = true;
  const completed = await controller.finish({ sessionId: started.sessionId, summary: "tests now pass" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.verified, true);
});

test("goal_step enforces the selected tool schema", async () => {
  let invoked = false;
  const strict = makeTool(
    "strict",
    {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "integer" } },
    },
    async () => {
      invoked = true;
      return { status: "completed" };
    },
  );
  const controller = createGoalController({ tools: [strict], verificationTasks: [] });
  const started = controller.start({ goal: "Validate internal tool calls" });
  const result = await controller.step({
    sessionId: started.sessionId,
    tool: "strict",
    input: { value: "wrong" },
  });
  assert.equal(result.status, "continue_required");
  assert.match(result.feedback, /expected integer/);
  assert.equal(invoked, false);
  assert.equal(result.budget.toolCallsUsed, 0);
});

test("approval blocks pause the goal instead of being bypassed", async () => {
  const risky = makeTool("risky", objectSchema, async (_input, trustedContext) => {
    if (typeof trustedContext.requestApproval !== "function") {
      return { status: "approval_required", approvalRequest: { id: "abc" } };
    }
    const approved = await trustedContext.requestApproval({ id: "abc" });
    return approved ? { status: "completed" } : { status: "approval_denied" };
  });
  const controller = createGoalController({ tools: [risky], verificationTasks: [] });
  const started = controller.start({ goal: "Perform approved action" });

  const blocked = await controller.step({ sessionId: started.sessionId, tool: "risky", input: {} });
  assert.equal(blocked.status, "blocked_approval");
  assert.equal(blocked.mustContinue, false);
  assert.equal(blocked.needsApproval, true);

  const retried = await controller.step(
    { sessionId: started.sessionId, tool: "risky", input: {} },
    { requestApproval: () => true },
  );
  assert.equal(retried.status, "continue_required");
  assert.equal(retried.mustContinue, true);
  assert.equal(retried.budget.stepsUsed, 1, "approval retry must not consume a second Goal step");
  assert.equal(retried.budget.toolCallsUsed, 2, "the actual retry still consumes a tool-call budget unit");
});

test("repeating the same goal action is bounded", async () => {
  const noop = makeTool("noop", objectSchema, async () => ({ status: "completed" }));
  const controller = createGoalController({ tools: [noop], verificationTasks: [], repeatLimit: 2 });
  const started = controller.start({ goal: "Avoid loops", maxSteps: 10 });
  const action = { sessionId: started.sessionId, tool: "noop", input: {} };
  assert.equal((await controller.step(action)).status, "continue_required");
  assert.equal((await controller.step(action)).status, "continue_required");
  const stalled = await controller.step(action);
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.mustContinue, false);
});

test("strict verification prevents unverifiable completion", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [], strictVerification: true });
  const started = controller.start({ goal: "Require evidence from a verifier" });
  const result = await controller.finish({ sessionId: started.sessionId, summary: "I think it is done" });
  assert.equal(result.status, "continue_required");
  assert.match(result.feedback, /strict verification/);
});

test("goal sessions expose the effective profile and read-only audit blocks side-effecting actions before invocation", async () => {
  let mutationInvoked = 0;
  const readFile = makeTool("read_file", objectSchema, async () => ({ status: "completed", text: "ok" }));
  const applyPatch = makeTool("apply_patch", objectSchema, async () => {
    mutationInvoked += 1;
    return { status: "completed" };
  });
  const controller = createGoalController({ tools: [readFile, applyPatch], verificationTasks: [] });

  const legacy = controller.start({ goal: "legacy profile stays compatible" });
  assert.equal(legacy.verificationProfile, "legacy-code-project");
  assert.equal(controller.status(legacy.sessionId).verificationProfile, "legacy-code-project");

  const audit = controller.start({ goal: "inspect only", verificationProfile: "read-only-audit" });
  assert.equal(audit.verificationProfile, "read-only-audit");
  assert.equal(controller.status(audit.sessionId).verificationProfile, "read-only-audit");

  const inspected = await controller.step({ sessionId: audit.sessionId, tool: "read_file", input: {} });
  assert.equal(inspected.status, "continue_required");
  assert.equal(inspected.budget.toolCallsUsed, 1);

  const blocked = await controller.step({ sessionId: audit.sessionId, tool: "apply_patch", input: {} });
  assert.equal(blocked.status, "continue_required");
  assert.match(blocked.feedback, /read-only-audit/i);
  assert.equal(mutationInvoked, 0);
  assert.equal(blocked.budget.toolCallsUsed, 1);
});

test("system-operation alone may persist a bounded postcondition", () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  assert.throws(
    () => controller.start({ goal: "wrong profile", verificationProfile: "code-change", postcondition: "operation health is ready" }),
    /postcondition.*system-operation/i,
  );
  const started = controller.start({
    goal: "perform a system operation",
    verificationProfile: "system-operation",
    postcondition: "operation health is ready",
  });
  const status = controller.status(started.sessionId);
  assert.equal(started.postcondition, "operation health is ready");
  assert.equal(status.postcondition, "operation health is ready");
});

test("goal status returns only bounded recent history", async () => {
  const noop = makeTool(
    "noop",
    {
      type: "object",
      additionalProperties: false,
      required: ["n"],
      properties: { n: { type: "integer", minimum: 0 } },
    },
    async () => ({ status: "completed" }),
  );
  const controller = createGoalController({ tools: [noop], verificationTasks: [], repeatLimit: 10 });
  const started = controller.start({ goal: "Inspect status", maxSteps: 30 });
  for (let i = 0; i < 12; i += 1) {
    await controller.step({ sessionId: started.sessionId, tool: "noop", input: { n: i } });
  }
  const status = controller.status(started.sessionId);
  assert.equal(status.status, "active");
  assert.equal(status.budget.toolCallsUsed, 12);
  assert.ok(status.history.length <= 20);
});

test("acceptance criteria must be explicitly satisfied with evidence before completion", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  const started = controller.start({
    goal: "Implement the requested behavior",
    acceptanceCriteria: ["Feature works", "Regression is covered"],
  });

  const missing = await controller.finish({
    sessionId: started.sessionId,
    summary: "done",
    criteriaEvidence: [
      { criterion: "Feature works", satisfied: true, evidence: "manual behavior check" },
    ],
  });
  assert.equal(missing.status, "continue_required");
  assert.match(missing.feedback, /Regression is covered/);

  const completed = await controller.finish({
    sessionId: started.sessionId,
    summary: "done with both criteria",
    criteriaEvidence: [
      { criterion: "Feature works", satisfied: true, evidence: "behavior confirmed" },
      { criterion: "Regression is covered", satisfied: true, evidence: "regression test added" },
    ],
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.acceptance.passed, true);
  assert.equal(completed.acceptance.evidence.length, 2);
  assert.equal(completed.verified, false);
});

test("direct controller calls enforce the same bounded goal and finish inputs as tool schemas", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  assert.throws(
    () => controller.start({ goal: "x".repeat(32_769) }),
    /32768/,
  );
  assert.throws(
    () => controller.start({ goal: "bounded", acceptanceCriteria: Array.from({ length: 51 }, (_, i) => `c${i}`) }),
    /at most 50/,
  );

  const started = controller.start({ goal: "bounded finish" });
  await assert.rejects(
    controller.finish({
      sessionId: started.sessionId,
      summary: "done",
      evidence: Array.from({ length: 51 }, () => "evidence"),
    }),
    /at most 50/,
  );
});
