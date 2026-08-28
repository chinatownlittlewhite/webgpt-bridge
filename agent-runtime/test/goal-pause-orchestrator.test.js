import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExternalGoalOrchestrator } from "../src/orchestrator.js";
import { createCoreTools } from "../src/tool.js";

test("external orchestrator pauses instead of abandoning an active Goal at its model-turn boundary and resumes the exact session later", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-orchestrator-pause-"));
  try {
    fs.writeFileSync(path.join(root, "hello.txt"), "hello\n", "utf8");
    const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
    const firstRun = createExternalGoalOrchestrator({ tools, maxModelTurns: 1 });
    const paused = await firstRun({ goal: "Inspect and then finish later" }, {
      modelStep: async () => ({ type: "tool", tool: "search_files", input: { glob: "**/*.txt" } }),
    });

    assert.equal(paused.status, "paused");
    assert.equal(paused.mustContinue, false);
    assert.equal(typeof paused.sessionId, "string");
    assert.match(paused.pause.reason, /model-turn budget/i);
    assert.notEqual(paused.status, "completed");
    assert.notEqual(paused.status, "canceled");

    const secondRun = createExternalGoalOrchestrator({ tools, maxModelTurns: 2 });
    const completed = await secondRun({ sessionId: paused.sessionId }, {
      modelStep: async ({ session }) => {
        assert.equal(session.sessionId, paused.sessionId);
        assert.equal(session.status, "active");
        assert.equal(session.mustContinue, true);
        return { type: "finish", summary: "resumed exact paused session" };
      },
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.sessionId, paused.sessionId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external orchestrator accepts an explicit pause decision as a legal stop-for-now result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-orchestrator-explicit-pause-"));
  try {
    const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
    const run = createExternalGoalOrchestrator({ tools, maxModelTurns: 2 });
    const result = await run({ goal: "Pause deliberately" }, {
      modelStep: async () => ({
        type: "pause",
        summary: "safe checkpoint",
        nextAction: "resume after explicit reconnect",
        reason: "assistant turn boundary",
      }),
    });
    assert.equal(result.status, "paused");
    assert.equal(result.mustContinue, false);
    assert.equal(result.pause.summary, "safe checkpoint");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
