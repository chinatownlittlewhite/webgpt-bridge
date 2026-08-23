import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCapabilitiesTool,
  createCoreTools,
  createRunCommandTool,
  dependencySyncInputSchema,
  gitInputSchema,
  githubInputSchema,
  goalFinishInputSchema,
  goalModeInputSchema,
  goalSessionInputSchema,
  goalStepInputSchema,
  processInputInputSchema,
  processKillInputSchema,
  processPollInputSchema,
  processStartInputSchema,
  readFileInputSchema,
  listDirInputSchema,
  searchTextInputSchema,
  runCommandInputSchema,
  runProjectTaskInputSchema,
} from "../src/tool.js";

const EXPECTED_TOOLS = [
  "run_command",
  "run_project_task",
  "git",
  "dependency_sync",
  "github",
  "process_start",
  "process_poll",
  "process_input",
  "process_kill",
  "process_list",
  "read_file",
  "list_dir",
  "search_text",
  "search_files",
  "apply_patch",
  "delete_file",
  "move_file",
  "goal_mode",
  "goal_step",
  "goal_finish",
  "goal_status",
  "goal_cancel",
  "get_capabilities",
];

test("trusted execution controls cannot be supplied through model-facing schemas", () => {
  for (const schema of [
    runCommandInputSchema,
    runProjectTaskInputSchema,
    gitInputSchema,
    dependencySyncInputSchema,
    githubInputSchema,
    processStartInputSchema,
    processPollInputSchema,
    processInputInputSchema,
    processKillInputSchema,
    readFileInputSchema,
    listDirInputSchema,
    searchTextInputSchema,
    goalModeInputSchema,
    goalStepInputSchema,
    goalFinishInputSchema,
    goalSessionInputSchema,
  ]) {
    assert.equal(Object.hasOwn(schema.properties, "approvalGranted"), false);
    assert.equal(Object.hasOwn(schema.properties, "requestApproval"), false);
    assert.equal(Object.hasOwn(schema.properties, "sandboxExtraReadPaths"), false);
    assert.equal(Object.hasOwn(schema.properties, "sandboxExtraWritePaths"), false);
    assert.equal(Object.hasOwn(schema.properties, "goalSessionId"), false);
    assert.equal(Object.hasOwn(schema.properties, "agentStep"), false);
    assert.equal(Object.hasOwn(schema.properties, "verifyCompletion"), false);
    assert.equal(schema.additionalProperties, false);
  }
});

test("trusted host approval callback controls exact command execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-tool-"));
  const tool = createRunCommandTool({ workspace: root, defaultTimeoutMs: 5_000 });

  const pending = await tool.invoke({ argv: ["node", "-e", "process.exit(0)"] });
  assert.equal(pending.status, "approval_required");
  assert.equal(typeof pending.approvalRequest.id, "string");
  assert.ok(Array.isArray(pending.approvalRequest.resolvedArgv));
  assert.ok(pending.approvalRequest.resolvedArgv[0].includes("node"));

  let seen = null;
  const approved = await tool.invoke(
    { argv: ["node", "-e", "process.exit(0)"] },
    {
      requestApproval(request) {
        seen = request;
        return true;
      },
    },
  );
  assert.equal(approved.status, "completed");
  assert.equal(approved.exitCode, 0);
  assert.deepEqual(seen.argv, ["node", "-e", "process.exit(0)"]);
  assert.equal(typeof seen.id, "string");
  assert.equal(Object.isFrozen(seen.sandboxAccess), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("goal tools use an explicit session handle and inject bounded project instructions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-goal-tools-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Follow the project instructions.\n", "utf8");
  const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const started = byName.goal_mode.invoke({ goal: "Track a bounded target" });
  assert.equal(started.status, "active");
  assert.equal(started.mustContinue, true);
  assert.equal(typeof started.sessionId, "string");
  assert.match(started.projectContext.instructions, /Follow the project instructions/);
  assert.deepEqual(started.projectContext.files.map((entry) => entry.path), ["AGENTS.md"]);

  const status = byName.goal_status.invoke({ sessionId: started.sessionId });
  assert.equal(status.status, "active");
  assert.equal(status.sessionId, started.sessionId);

  const finished = await byName.goal_finish.invoke({
    sessionId: started.sessionId,
    summary: "No project action was required",
  });
  assert.equal(finished.status, "completed");
  assert.equal(finished.mustContinue, false);
  assert.equal(finished.verified, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("core tool set exposes the frozen v0.9 final-acceptance surface", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-tools-"));
  const names = createCoreTools({ workspace: root }).map((tool) => tool.name);
  assert.deepEqual(names, EXPECTED_TOOLS);
  assert.equal(new Set(names).size, EXPECTED_TOOLS.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test("capabilities report final-acceptance guarantees without overclaiming inactive sandbox", () => {
  const report = createCapabilitiesTool().invoke({});
  assert.equal(report.version, "0.9.0");
  assert.equal(report.releaseStage, "final-acceptance-candidate");
  assert.deepEqual(report.tools, EXPECTED_TOOLS);
  assert.equal(report.sandbox.enforced, false);
  assert.equal(report.sandbox.autoRunSafe, false);
  assert.equal(report.guarantees.hostApprovalIsBoundToExactAndResolvedRequest, true);
  assert.equal(report.guarantees.windowsBatchRequiresTrustedShim, true);
  assert.equal(report.guarantees.unattendedExecutionRequiresVerifiedSandbox, true);
  assert.equal(report.guarantees.goalModeCannotRunUnbounded, true);
  assert.equal(report.goalMode.orchestration, "explicit-session-handle");
  assert.equal(report.goalMode.trackedActionsUseGoalStep, true);
  assert.equal(report.goalMode.goalCwdScoped, false);
  assert.equal(report.goalMode.acceptanceCriteriaGate, true);
  assert.equal(report.goalMode.externalOrchestratorCompatible, true);
  assert.equal(report.goalMode.sessionPersistence, "in-memory-until-server-restart-or-ttl");
  assert.equal(report.mcp.protocolRevision, "2026-07-28");
  assert.equal(report.mcp.mrtrApprovalSupported, true);
  assert.equal(report.workspaceInspection.boundedReadFile, true);
  assert.equal(report.workspaceInspection.literalSearchText, true);
  assert.equal(report.workspaceInspection.executableContinuationHints, true);
  assert.equal(report.processManager.longRunning, true);
  assert.equal(report.git.worktrees, true);
  assert.equal(report.networkSandbox, null);
  assert.equal(report.releaseAcceptance.requiredCommand, "npm run acceptance");
  assert.equal(report.releaseAcceptance.perTargetOs, true);
  assert.equal(report.releaseAcceptance.currentNativeSandboxVerified, false);
  assert.equal(Object.hasOwn(goalModeInputSchema.properties, "acceptanceCriteria"), true);
  assert.equal(Object.hasOwn(goalFinishInputSchema.properties, "criteriaEvidence"), true);
});

test("capabilities report marks goal cwd scoping active when workspace is configured", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-capabilities-"));
  const report = createCapabilitiesTool({ workspace: root }).invoke({});
  assert.equal(report.goalMode.goalCwdScoped, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("persistent goal sessions are reported when file persistence is enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-persistent-capabilities-"));
  const tools = createCoreTools({ workspace: root, goalPersistSessions: true, goalVerificationTasks: [] });
  const capabilities = tools.find((tool) => tool.name === "get_capabilities").invoke({});
  assert.equal(capabilities.goalMode.sessionPersistence, "persistent-file");
  fs.rmSync(root, { recursive: true, force: true });
});
