import test from "node:test";
import assert from "node:assert/strict";
import { createGoalController } from "../src/goal-controller.js";

function makeTool(name, invoke) {
  return {
    name,
    inputSchema: { type: "object", additionalProperties: false },
    invoke,
  };
}

test("goal_finish preserves bounded project-check diagnostics when verification fails", async () => {
  const stdout = `${"o".repeat(6_000)}\nFAILED nested-test-name\n`;
  const stderr = `${"e".repeat(6_000)}\npermission detail\n`;
  const projectTask = makeTool("run_project_task", async () => ({
    status: "completed",
    exitCode: 1,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
  const controller = createGoalController({
    tools: [projectTask],
    verificationTasks: ["test"],
  });
  const started = controller.start({ goal: "Diagnose a failing verification" });
  const result = await controller.finish({
    sessionId: started.sessionId,
    summary: "verification attempted",
  });

  assert.equal(result.status, "continue_required");
  const check = result.verification.checks[0];
  assert.equal(check.task, "test");
  assert.equal(check.exitCode, 1);
  assert.match(check.stdoutTail, /FAILED nested-test-name/);
  assert.match(check.stderrTail, /permission detail/);
  assert.ok(Buffer.byteLength(check.stdoutTail) <= 4_096);
  assert.ok(Buffer.byteLength(check.stderrTail) <= 4_096);
  assert.equal(check.stdoutOmitted, true);
  assert.equal(check.stderrOmitted, true);
});
