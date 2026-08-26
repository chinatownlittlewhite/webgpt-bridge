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
