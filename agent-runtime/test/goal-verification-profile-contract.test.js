import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalController } from "../src/goal-controller.js";
import { createFileGoalSessionStore } from "../src/goal-store.js";
import { createCapabilitiesTool, createCoreTools } from "../src/tool.js";

const objectSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

function tool(name, invoke) {
  return { name, inputSchema: objectSchema, invoke };
}

test("Goal verification profile capability contract preserves the 26-tool surface", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-profile-cap-"));
  try {
    const tools = createCoreTools({ workspace });
    const capabilities = createCapabilitiesTool({ workspace }).invoke({});
    assert.equal(tools.length, 26);
    assert.deepEqual(capabilities.goalMode.supportedVerificationProfiles, [
      "code-change",
      "read-only-audit",
      "system-operation",
    ]);
    assert.equal(capabilities.goalMode.defaultVerificationProfile, "legacy-code-project");
    assert.equal(capabilities.goalMode.effectiveProfileReportedPerSession, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("profile and system postcondition survive a real Goal Store v2 restart", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-profile-restart-"));
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  try {
    const first = createGoalController({
      workspace,
      tools: [],
      sessionStore: createFileGoalSessionStore({ workspace }),
      verificationTasks: [],
    });
    const started = first.start({
      goal: "restart a service",
      cwd: "project",
      verificationProfile: "system-operation",
      postcondition: "service is healthy",
    });

    const second = createGoalController({
      workspace,
      tools: [],
      sessionStore: createFileGoalSessionStore({ workspace }),
      verificationTasks: [],
    });
    const restored = second.status(started.sessionId);
    assert.equal(restored.status, "active");
    assert.equal(restored.verificationProfile, "system-operation");
    assert.equal(restored.postcondition, "service is healthy");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("read-only-audit contract rejects side effects before invocation", async () => {
  let invoked = false;
  const mutation = tool("apply_patch", async () => {
    invoked = true;
    return { status: "completed" };
  });
  const controller = createGoalController({ tools: [mutation], verificationTasks: [] });
  const started = controller.start({ goal: "inspect only", verificationProfile: "read-only-audit" });
  const result = await controller.step({ sessionId: started.sessionId, tool: "apply_patch", input: {} });
  assert.equal(result.status, "continue_required");
  assert.match(result.feedback, /read-only-audit/i);
  assert.equal(invoked, false);
});

test("explicit code-change cannot complete after mutation without independent verification", async () => {
  const edit = tool("edit", async () => ({ status: "completed" }));
  const controller = createGoalController({ tools: [edit], verificationTasks: [] });
  const started = controller.start({ goal: "change code", verificationProfile: "code-change" });
  await controller.step({ sessionId: started.sessionId, tool: "edit", input: {} });
  const result = await controller.finish({ sessionId: started.sessionId, summary: "done" });
  assert.equal(result.status, "continue_required");
  assert.match(result.feedback, /project check|trusted verifier/i);
});

test("system-operation completes from an explicit persisted postcondition and bounded evidence", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  const started = controller.start({
    goal: "perform system operation",
    verificationProfile: "system-operation",
    postcondition: "health endpoint is ready",
  });
  const result = await controller.finish({
    sessionId: started.sessionId,
    summary: "operation complete",
    postconditionEvidence: "health endpoint returned ready",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.verified, true);
  assert.equal(result.verification.profile.method, "postcondition-evidence");
});
