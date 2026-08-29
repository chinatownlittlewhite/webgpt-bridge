import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCoreTools } from "../src/tool.js";

const require = createRequire(import.meta.url);
const {
  listBrokerToolNames,
  listGoalToolNames,
  listToolNames,
} = require("../../shared/tool-registry.cjs");

const BASELINE_26 = [
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel",
  "goal_pause", "goal_resume", "goal_list", "get_capabilities",
];

const BASELINE_10_BROKER = [
  "local_list", "local_read", "local_list_known_folder", "local_read_known_folder", "local_probe_health",
  "local_request_sensitive_access", "local_request_host_access", "local_stage_changes", "local_confirm_batch", "local_run_command",
];

const TEST_BROKER_AUTH = Object.freeze({ protocolVersion: 1, sessionId: "test-session", secret: "test-secret", agentVersion: "0.9.3" });

test("independent tool registry contract freezes the external 26 plus 10 broker catalog", () => {
  assert.deepEqual(listToolNames(), BASELINE_26);
  assert.deepEqual(listBrokerToolNames({ brokerEnabled: true }), BASELINE_10_BROKER);
  assert.equal(listToolNames({ brokerEnabled: true }).length, 36);
  assert.equal(listGoalToolNames().every((name) => BASELINE_26.includes(name)), true);
  assert.equal(listBrokerToolNames({ brokerEnabled: true }).includes("host_approve_command"), false);
});

test("runtime tools and capability subsets agree with the canonical registry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-registry-contract-"));
  try {
    const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
    assert.deepEqual(tools.map((tool) => tool.name), BASELINE_26);
    const caps = tools.find((tool) => tool.name === "get_capabilities").invoke({});
    assert.deepEqual(caps.tools, BASELINE_26);
    assert.deepEqual(caps.goalTools, listGoalToolNames());
    assert.deepEqual(caps.brokerTools, []);

    const brokerTools = createCoreTools({
      workspace: root,
      goalVerificationTasks: [],
      localBrokerSocket: path.join(root, "broker.sock"),
      localBrokerAuth: TEST_BROKER_AUTH,
    });
    assert.deepEqual(brokerTools.map((tool) => tool.name), listToolNames({ brokerEnabled: true }));
    const brokerCaps = brokerTools.find((tool) => tool.name === "get_capabilities").invoke({});
    assert.deepEqual(brokerCaps.brokerTools, BASELINE_10_BROKER);
    assert.deepEqual(brokerCaps.goalTools, listGoalToolNames({ brokerEnabled: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normal contract and acceptance scripts derive their tool catalog from the registry", () => {
  const contractSource = fs.readFileSync(new URL("../scripts/contract-check.mjs", import.meta.url), "utf8");
  const acceptanceSource = fs.readFileSync(new URL("../scripts/acceptance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(contractSource, /const EXPECTED_TOOLS = \[/);
  assert.doesNotMatch(acceptanceSource, /const EXPECTED_TOOLS = \[/);
  assert.match(contractSource, /listToolNames/);
  assert.match(acceptanceSource, /listToolNames/);
});

test("package-content gate explicitly covers the canonical shared registry", () => {
  const packageTestSource = fs.readFileSync(new URL("../../test/package-content.test.cjs", import.meta.url), "utf8");
  assert.match(packageTestSource, /tool-registry\.cjs/);
});
