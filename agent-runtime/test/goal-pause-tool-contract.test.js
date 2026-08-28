import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCapabilitiesTool,
  createCoreTools,
  goalListInputSchema,
  goalPauseInputSchema,
  goalSessionInputSchema,
} from "../src/tool.js";

const NEW_GOAL_TOOLS = ["goal_pause", "goal_resume", "goal_list"];

test("Goal Mode tool surface exposes pause, resume, and bounded list contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-pause-tools-"));
  try {
    const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of NEW_GOAL_TOOLS) assert.ok(byName[name], `missing ${name}`);
    assert.equal(byName.goal_pause.inputSchema, goalPauseInputSchema);
    assert.equal(byName.goal_resume.inputSchema, goalSessionInputSchema);
    assert.equal(byName.goal_list.inputSchema, goalListInputSchema);

    assert.deepEqual(goalPauseInputSchema.required, ["sessionId"]);
    assert.equal(goalPauseInputSchema.additionalProperties, false);
    assert.ok(Object.hasOwn(goalPauseInputSchema.properties, "summary"));
    assert.ok(Object.hasOwn(goalPauseInputSchema.properties, "nextAction"));
    assert.ok(Object.hasOwn(goalPauseInputSchema.properties, "reason"));
    assert.equal(goalListInputSchema.additionalProperties, false);
    assert.ok(goalListInputSchema.properties.limit.maximum <= 50);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capabilities advertise safe cross-turn pause/resume/list semantics", () => {
  const report = createCapabilitiesTool().invoke({});
  for (const name of NEW_GOAL_TOOLS) assert.ok(report.tools.includes(name), `capabilities missing ${name}`);
  assert.equal(report.goalMode.safeCrossTurnPause, true);
  assert.equal(report.goalMode.pausedGoalsReturnMustContinueFalse, true);
  assert.equal(report.goalMode.explicitResumeRequired, true);
  assert.equal(report.goalMode.listPausedSessions, true);
  assert.equal(report.guarantees.goalPauseReclaimsOwnedProcesses, true);
});
