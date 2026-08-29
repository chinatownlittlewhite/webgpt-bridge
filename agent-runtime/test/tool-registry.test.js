import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TOOL_REGISTRY_VERSION,
  classifyToolSideEffect,
  getBrokerMethodMetadata,
  getMcpAnnotations,
  listBrokerToolNames,
  listGoalToolNames,
  listToolMetadata,
  listToolNames,
} = require("../../shared/tool-registry.cjs");

const BASELINE_TOOLS = [
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel",
  "goal_pause", "goal_resume", "goal_list", "get_capabilities",
];

const BROKER_TOOLS = [
  "local_list", "local_read", "local_list_known_folder", "local_read_known_folder", "local_probe_health",
  "local_request_sensitive_access", "local_request_host_access", "local_stage_changes", "local_confirm_batch", "local_run_command",
];

test("canonical tool registry freezes the public catalog and broker insertion point", () => {
  assert.equal(TOOL_REGISTRY_VERSION, 1);
  assert.deepEqual(listToolNames(), BASELINE_TOOLS);
  assert.equal(new Set(listToolNames()).size, 26);
  assert.deepEqual(listBrokerToolNames(), []);
  assert.deepEqual(listBrokerToolNames({ brokerEnabled: true }), BROKER_TOOLS);
  assert.equal(listToolNames({ brokerEnabled: true }).length, 36);
  assert.deepEqual(listToolNames({ brokerEnabled: true }).slice(17, 27), BROKER_TOOLS);
  assert.equal(listGoalToolNames().includes("goal_mode"), false);
  assert.equal(listGoalToolNames().includes("read_file"), true);
  assert.equal(listGoalToolNames({ brokerEnabled: true }).includes("local_read"), true);
  assert.equal(listBrokerToolNames({ brokerEnabled: true }).includes("host_approve_command"), false);

  for (const metadata of listToolMetadata({ brokerEnabled: true })) {
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(typeof metadata.name, "string");
    assert.ok(["always", "broker"].includes(metadata.availability));
    assert.equal(typeof metadata.goalEligible, "boolean");
    assert.equal(typeof metadata.timeoutClass, "string");
    assert.equal(typeof metadata.capabilityCategory, "string");
    assert.equal(typeof metadata.security, "object");
    assert.equal(Object.isFrozen(metadata.mcpAnnotations), true);
  }
});

test("canonical broker registry includes internal approval without exposing it as a tool", () => {
  assert.equal(getBrokerMethodMetadata("host_approve_command").internal, true);
  assert.equal(getBrokerMethodMetadata("host_approve_command").implementationKey, "command.approve");
  assert.equal(getBrokerMethodMetadata("local_run_command").internal, false);
  assert.equal(getBrokerMethodMetadata("local_run_command").implementationKey, "command.run");
  assert.equal(getBrokerMethodMetadata("unknown_method"), null);
});

test("canonical MCP annotations preserve the current public hints", () => {
  assert.deepEqual(getMcpAnnotations("read_file"), {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(getMcpAnnotations("local_read").readOnlyHint, false);
  assert.equal(getMcpAnnotations("delete_file").destructiveHint, true);
  assert.equal(getMcpAnnotations("github").openWorldHint, true);
});

test("canonical Goal side-effect metadata is conservative and action-aware", () => {
  assert.equal(classifyToolSideEffect({ tool: "read_file", input: {} }).sideEffecting, false);
  assert.equal(classifyToolSideEffect({ tool: "git", input: { action: "status" } }).sideEffecting, false);
  assert.equal(classifyToolSideEffect({ tool: "github", input: { action: "pr_view" } }).sideEffecting, false);
  assert.equal(classifyToolSideEffect({ tool: "apply_patch", input: {} }).sideEffecting, true);
  assert.equal(classifyToolSideEffect({ tool: "git", input: { action: "commit" } }).sideEffecting, true);
  assert.equal(classifyToolSideEffect({ tool: "unknown_future_tool", input: {} }).sideEffecting, true);
  assert.equal(Object.isFrozen(classifyToolSideEffect({ tool: "read_file", input: {} })), true);
});
