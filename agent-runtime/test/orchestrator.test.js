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
