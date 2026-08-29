import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_GOAL_VERIFICATION_PROFILE,
  SUPPORTED_GOAL_VERIFICATION_PROFILES,
  classifyGoalAction,
  normalizeGoalVerificationProfile,
} from "../src/goal-verification-profile.js";

test("goal verification profiles expose the fixed explicit set and legacy default", () => {
  assert.deepEqual(SUPPORTED_GOAL_VERIFICATION_PROFILES, ["code-change", "read-only-audit", "system-operation"]);
  assert.equal(Object.isFrozen(SUPPORTED_GOAL_VERIFICATION_PROFILES), true);
  assert.equal(LEGACY_GOAL_VERIFICATION_PROFILE, "legacy-code-project");
  assert.equal(normalizeGoalVerificationProfile(undefined), "legacy-code-project");
  assert.equal(normalizeGoalVerificationProfile("read-only-audit"), "read-only-audit");
  assert.throws(() => normalizeGoalVerificationProfile("unknown"), /verification profile/i);
});

test("read-only goal action classification is conservative and structured-action aware", () => {
  for (const [tool, input] of [
    ["read_file", {}],
    ["list_dir", {}],
    ["search_text", {}],
    ["search_files", {}],
    ["process_poll", {}],
    ["process_list", {}],
    ["local_list", {}],
    ["local_read", {}],
    ["local_list_known_folder", {}],
    ["local_read_known_folder", {}],
    ["local_probe_health", {}],
    ["git", { action: "status" }],
    ["git", { action: "diff" }],
    ["git", { action: "log" }],
    ["git", { action: "show" }],
    ["git", { action: "branch_list" }],
    ["git", { action: "worktree_list" }],
    ["github", { action: "pr_view" }],
    ["github", { action: "ci_status" }],
    ["github", { action: "issue_view" }],
    ["github", { action: "release_view" }],
  ]) {
    const result = classifyGoalAction({ tool, input });
    assert.equal(result.sideEffecting, false, `${tool}:${input.action ?? "default"}`);
    assert.equal(Object.isFrozen(result), true);
  }

  for (const [tool, input] of [
    ["apply_patch", {}],
    ["delete_file", {}],
    ["move_file", {}],
    ["run_command", {}],
    ["run_project_task", {}],
    ["dependency_sync", {}],
    ["process_start", {}],
    ["process_input", {}],
    ["process_kill", {}],
    ["git", { action: "commit" }],
    ["git", { action: "push" }],
    ["github", { action: "pr_create" }],
    ["local_stage_changes", {}],
    ["local_confirm_batch", {}],
    ["local_run_command", {}],
    ["unknown_tool", {}],
  ]) {
    assert.equal(classifyGoalAction({ tool, input }).sideEffecting, true, `${tool}:${input.action ?? "default"}`);
  }
});
