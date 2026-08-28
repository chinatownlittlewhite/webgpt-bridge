import test from "node:test";
import assert from "node:assert/strict";
import { createCoreTools } from "../src/tool.js";

const expectedTools = [
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel", "goal_pause", "goal_resume", "goal_list", "get_capabilities",
].sort();

test("goal lifecycle cleanup is advertised on the 26-tool v0.9.3 surface", () => {
  const tools = createCoreTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedTools);
  assert.equal(tools.length, 26);
  const capabilities = tools.find((tool) => tool.name === "get_capabilities").invoke({});
  assert.equal(capabilities.goalMode.cancelReclaimsOwnedProcesses, true);
  assert.equal(capabilities.guarantees.goalCancelReclaimsOwnedProcesses, true);
  assert.equal(capabilities.goalMode.pauseReclaimsOwnedProcesses, true);
  assert.equal(capabilities.guarantees.goalPauseReclaimsOwnedProcesses, true);
});
