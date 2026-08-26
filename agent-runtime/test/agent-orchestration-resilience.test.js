import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalController } from "../src/goal-controller.js";
import { createExternalGoalOrchestrator } from "../src/orchestrator.js";
import { createCoreTools } from "../src/tool.js";

const objectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

function toolByName(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

function makeWorkspace(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("external orchestrator awaits async goal cancellation and returns cleanup state", async () => {
  const workspace = makeWorkspace("wgb-orchestrator-cancel-");
  try {
    const tools = createCoreTools({ workspace, goalVerificationTasks: [] });
    const run = createExternalGoalOrchestrator({ tools, maxModelTurns: 2 });

    const result = await run({ goal: "Cancel this goal safely" }, {
      modelStep: async () => ({ type: "cancel" }),
    });

    assert.equal(result.status, "canceled");
    assert.equal(result.mustContinue, false);
    assert.equal(result.orchestratorTurns, 1);
    assert.equal(result.processCleanup.status, "completed");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("goal cancellation stays terminal when an in-flight goal_step resolves later", async () => {
  let markStarted;
  let releaseInvoke;
  const startedInvoke = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseInvoke = resolve; });
  const slowTool = {
    name: "slow_tool",
    inputSchema: objectSchema,
    async invoke() {
      markStarted();
      await release;
      return { status: "completed" };
    },
  };
  const controller = createGoalController({ tools: [slowTool], verificationTasks: [] });
  const goal = controller.start({ goal: "Do not resurrect after cancellation" });

  const stepPromise = controller.step({ sessionId: goal.sessionId, tool: "slow_tool", input: {} });
  await startedInvoke;
  const canceled = await controller.cancel(goal.sessionId);
  assert.equal(canceled.status, "canceled");
  releaseInvoke();

  const stepResult = await stepPromise;
  assert.equal(stepResult.mustContinue, false);
  assert.equal(controller.status(goal.sessionId).status, "canceled");
});

test("goal cancellation stays terminal when completion verification resolves later", async () => {
  let markVerifierStarted;
  let releaseVerifier;
  const verifierStarted = new Promise((resolve) => { markVerifierStarted = resolve; });
  const verifierRelease = new Promise((resolve) => { releaseVerifier = resolve; });
  const controller = createGoalController({
    tools: [],
    verificationTasks: [],
    async verifyCompletion() {
      markVerifierStarted();
      await verifierRelease;
      return { completed: true };
    },
  });
  const goal = controller.start({ goal: "Cancellation wins over late verification" });

  const finishPromise = controller.finish({ sessionId: goal.sessionId, summary: "done" });
  await verifierStarted;
  const canceled = await controller.cancel(goal.sessionId);
  assert.equal(canceled.status, "canceled");
  releaseVerifier();

  const finishResult = await finishPromise;
  assert.equal(finishResult.mustContinue, false);
  assert.notEqual(finishResult.status, "completed");
  assert.equal(controller.status(goal.sessionId).status, "canceled");
});

test("trusted completion verifier errors fail closed without escaping goal_finish", async () => {
  const controller = createGoalController({
    tools: [],
    verificationTasks: [],
    async verifyCompletion() {
      throw new Error("verifier backend unavailable");
    },
  });
  const goal = controller.start({ goal: "Handle verifier failure safely" });

  const result = await controller.finish({ sessionId: goal.sessionId, summary: "done" });

  assert.equal(result.status, "continue_required");
  assert.equal(result.mustContinue, true);
  assert.match(result.feedback, /completion verifier failed to run: verifier backend unavailable/);
  assert.equal(controller.status(goal.sessionId).status, "active");
});

test("restored Goal sessions hand bounded project instructions back to the orchestrator", async () => {
  const workspace = makeWorkspace("wgb-orchestrator-resume-");
  try {
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Follow CONTEXT_HANDOFF_SENTINEL before acting.\n");
    const firstTools = createCoreTools({
      workspace,
      goalPersistSessions: true,
      goalVerificationTasks: [],
    });
    const started = toolByName(firstTools, "goal_mode").invoke({
      goal: "Resume with project instructions",
      cwd: ".",
    });
    assert.equal(started.persistence.persistent, true);

    const restoredTools = createCoreTools({
      workspace,
      goalPersistSessions: true,
      goalVerificationTasks: [],
    });
    const run = createExternalGoalOrchestrator({ tools: restoredTools, maxModelTurns: 2 });
    let handedOffInstructions = "";
    const result = await run({ sessionId: started.sessionId }, {
      modelStep: async ({ session }) => {
        handedOffInstructions = session.projectContext?.instructions ?? "";
        return { type: "finish", summary: "restored context was available" };
      },
    });

    assert.equal(result.status, "completed");
    assert.match(handedOffInstructions, /CONTEXT_HANDOFF_SENTINEL/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Goal sessions allow only one non-cancel mutation while a tool action is in flight", async () => {
  let markStarted;
  let releaseInvoke;
  let calls = 0;
  const startedInvoke = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseInvoke = resolve; });
  const serializedTool = {
    name: "serialized_tool",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer" } },
    },
    async invoke() {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await release;
      }
      return { status: "completed" };
    },
  };
  const controller = createGoalController({ tools: [serializedTool], verificationTasks: [] });
  const goal = controller.start({ goal: "Serialize Goal mutations" });
  const firstStep = controller.step({ sessionId: goal.sessionId, tool: "serialized_tool", input: { id: 1 } });
  await startedInvoke;

  try {
    const secondStep = await controller.step({ sessionId: goal.sessionId, tool: "serialized_tool", input: { id: 2 } });
    assert.equal(secondStep.status, "operation_in_progress");
    assert.equal(secondStep.mustContinue, false);
    assert.equal(calls, 1, "overlapping goal_step must not invoke a second tool");

    const overlappingFinish = await controller.finish({ sessionId: goal.sessionId, summary: "too early" });
    assert.equal(overlappingFinish.status, "operation_in_progress");
    assert.equal(overlappingFinish.mustContinue, false);
  } finally {
    releaseInvoke();
    await firstStep;
  }

  const completed = await controller.finish({ sessionId: goal.sessionId, summary: "serialized action completed" });
  assert.equal(completed.status, "completed");
});

test("Goal mutation lock is released after a tool throws", async () => {
  let calls = 0;
  const tool = {
    name: "throw_once",
    inputSchema: { type: "object", additionalProperties: false },
    async invoke() {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { status: "completed" };
    },
  };
  const controller = createGoalController({ tools: [tool], verificationTasks: [] });
  const goal = controller.start({ goal: "recover after tool failure" });
  const first = await controller.step({ sessionId: goal.sessionId, tool: "throw_once", input: {} });
  assert.equal(first.actionResult.status, "tool_error");
  const second = await controller.step({ sessionId: goal.sessionId, tool: "throw_once", input: {} });
  assert.notEqual(second.status, "operation_in_progress");
  assert.equal(second.actionResult.status, "completed");
});

test("external orchestrator preserves goal_mode start failures instead of degrading them to not_found", async () => {
  const workspace = makeWorkspace("wgb-orchestrator-capacity-");
  try {
    const tools = createCoreTools({
      workspace,
      goalVerificationTasks: [],
      goalMaxSessions: 1,
    });
    const occupied = toolByName(tools, "goal_mode").invoke({ goal: "Occupy the only Goal slot" });
    assert.equal(occupied.status, "active");

    const run = createExternalGoalOrchestrator({ tools, maxModelTurns: 2 });
    let modelCalls = 0;
    const result = await run({ goal: "This Goal cannot start" }, {
      modelStep: async () => {
        modelCalls += 1;
        return { type: "finish", summary: "should never be called" };
      },
    });

    assert.equal(result.status, "capacity_reached");
    assert.equal(result.mustContinue, false);
    assert.equal(result.orchestratorTurns, 0);
    assert.equal(modelCalls, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("external orchestrator audits a bounded terminal outcome", async () => {
  const workspace = makeWorkspace("wgb-orchestrator-audit-");
  try {
    const events = [];
    const auditLogger = { record(event) { events.push(event); } };
    const tools = createCoreTools({ workspace, goalVerificationTasks: [] });
    const run = createExternalGoalOrchestrator({ tools, auditLogger, maxModelTurns: 2 });
    const result = await run({ goal: "Finish with an auditable outcome" }, {
      modelStep: async () => ({ type: "finish", summary: "done" }),
    });

    assert.equal(result.status, "completed");
    const terminal = events.findLast((event) => event.type === "orchestrator_result");
    assert.ok(terminal, "expected a terminal orchestrator_result audit event");
    assert.equal(terminal.sessionId, result.sessionId);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.orchestratorTurns, 1);
    assert.equal(Object.hasOwn(terminal, "summary"), false, "terminal audit should not copy model summary content");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("capabilities advertise single-writer Goal mutation and terminal-outcome audit guarantees", () => {
  const workspace = makeWorkspace("wgb-orchestrator-capabilities-");
  try {
    const capabilities = toolByName(createCoreTools({ workspace }), "get_capabilities").invoke({});
    assert.equal(capabilities.goalMode.singleWriterMutations, true);
    assert.equal(capabilities.audit.orchestratorTerminalOutcomes, true);
    assert.equal(capabilities.guarantees.goalSessionMutationsSingleWriter, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
