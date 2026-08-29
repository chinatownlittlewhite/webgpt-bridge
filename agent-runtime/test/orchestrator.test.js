import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExternalGoalOrchestrator } from "../src/orchestrator.js";
import { createCoreTools } from "../src/tool.js";

test("external orchestrator drives an explicit Goal session to completion across model turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-orchestrator-"));
  fs.writeFileSync(path.join(root, "hello.txt"), "hello\n");
  const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
  const run = createExternalGoalOrchestrator({ tools, maxModelTurns: 5 });
  let calls = 0;
  const result = await run({
    goal: "Inspect the project and finish",
    cwd: ".",
    acceptanceCriteria: ["A project file was observed"],
  }, {
    async modelStep() {
      calls += 1;
      if (calls === 1) {
        return { type: "tool", tool: "search_files", input: { glob: "**/*.txt" } };
      }
      return {
        type: "finish",
        summary: "Observed the project file",
        evidence: ["search_files returned hello.txt"],
        criteriaEvidence: [{
          criterion: "A project file was observed",
          satisfied: true,
          evidence: "hello.txt was returned by search_files",
        }],
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.mustContinue, false);
  assert.equal(result.orchestratorTurns, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("external orchestrator forwards verification profile, postcondition, and postcondition evidence exactly once", async () => {
  let startInput = null;
  let finishInput = null;
  const session = {
    status: "active",
    mustContinue: true,
    sessionId: "profile-session",
    goal: "restart service",
    cwd: ".",
  };
  const tools = [
    { name: "goal_mode", invoke(input) { startInput = structuredClone(input); return { ...session }; } },
    { name: "goal_step", async invoke() { throw new Error("goal_step must not be used"); } },
    { name: "goal_finish", async invoke(input) { finishInput = structuredClone(input); return { status: "completed", mustContinue: false, sessionId: session.sessionId }; } },
    { name: "goal_status", invoke() { return { ...session }; } },
    { name: "goal_cancel", async invoke() { return { status: "canceled", mustContinue: false, sessionId: session.sessionId }; } },
    { name: "goal_pause", async invoke() { return { status: "paused", mustContinue: false, sessionId: session.sessionId }; } },
    { name: "goal_resume", async invoke() { return { ...session }; } },
  ];
  const run = createExternalGoalOrchestrator({ tools, maxModelTurns: 2 });

  const result = await run({
    goal: "restart service",
    verificationProfile: "system-operation",
    postcondition: "service health is ready",
  }, {
    modelStep: async () => ({
      type: "finish",
      summary: "service restarted",
      postconditionEvidence: "health probe returned ready",
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(startInput.verificationProfile, "system-operation");
  assert.equal(startInput.postcondition, "service health is ready");
  assert.equal(finishInput.postconditionEvidence, "health probe returned ready");
  assert.equal(Object.hasOwn(finishInput, "verificationProfile"), false);
});

test("external orchestrator stops only for real user-input blockers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-orchestrator-block-"));
  const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
  const run = createExternalGoalOrchestrator({ tools });
  const result = await run({ goal: "Need a user-only value" }, {
    modelStep: async () => ({ type: "user_input_required", reason: "Need the private deployment hostname" }),
  });
  assert.equal(result.status, "blocked_user_input");
  assert.match(result.reason, /deployment hostname/);
  fs.rmSync(root, { recursive: true, force: true });
});
