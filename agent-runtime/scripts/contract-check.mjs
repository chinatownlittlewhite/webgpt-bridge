import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCoreTools } from "../src/tool.js";
import { goalModeHostInstructions } from "../src/host-instructions.js";

const EXPECTED_TOOLS = [
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel", "goal_pause", "goal_resume", "goal_list",
  "get_capabilities",
];
const FORBIDDEN_MODEL_KEYS = new Set([
  "approvalGranted",
  "requestApproval",
  "sandboxExtraReadPaths",
  "sandboxExtraWritePaths",
  "goalSessionId",
  "agentStep",
  "verifyCompletion",
  "goalSessionStore",
  "sandboxAdapter",
  "networkSandboxAdapter",
]);

function inspectSchema(schema, pathLabel, { topLevel = false } = {}) {
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${pathLabel} must be an object schema`);
  if (schema.type === "object") {
    if (topLevel) {
      assert.equal(schema.additionalProperties, false, `${pathLabel} must fail closed with additionalProperties=false`);
    } else {
      assert.notEqual(schema.additionalProperties, true, `${pathLabel} must not explicitly allow arbitrary untyped properties`);
    }
    for (const key of Object.keys(schema.properties ?? {})) {
      assert.equal(FORBIDDEN_MODEL_KEYS.has(key), false, `${pathLabel} exposes trusted host field '${key}'`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [property, child] of Object.entries(value)) inspectSchema(child, `${pathLabel}.properties.${property}`);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        if (child && typeof child === "object") inspectSchema(child, `${pathLabel}.${key}[${index}]`);
      });
      continue;
    }
    if (value && typeof value === "object") inspectSchema(value, `${pathLabel}.${key}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-contract-"));
try {
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Contract fixture instructions.\n", "utf8");
  const tools = createCoreTools({ workspace, goalVerificationTasks: [] });
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOLS, "public MCP tool catalog drifted");
  assert.equal(new Set(tools.map((tool) => tool.name)).size, EXPECTED_TOOLS.length, "tool names must be unique");

  for (const tool of tools) {
    assert.equal(typeof tool.description, "string", `${tool.name} must have a description`);
    assert.ok(tool.description.length >= 8, `${tool.name} description is too short`);
    assert.equal(typeof tool.invoke, "function", `${tool.name} must expose invoke()`);
    inspectSchema(tool.inputSchema, `${tool.name}.inputSchema`, { topLevel: true });
  }

  const capabilities = tools.find((tool) => tool.name === "get_capabilities").invoke({});
  assert.equal(capabilities.version, packageJson.version, "package and capability versions must match");
  assert.deepEqual(capabilities.tools, EXPECTED_TOOLS, "capability tool catalog must match registration order");
  assert.equal(capabilities.guarantees.modelCannotSelfApprove, true);
  assert.equal(capabilities.workspaceInspection.boundedReadFile, true);
  assert.equal(capabilities.workspaceInspection.executableContinuationHints, true);
  assert.match(goalModeHostInstructions, /mustContinue=true/);
  assert.match(goalModeHostInstructions, /goal_pause/);
  assert.match(goalModeHostInstructions, /goal_resume/);
  assert.match(goalModeHostInstructions, /@macmini/);
  assert.match(goalModeHostInstructions, /read_file/);
  assert.match(goalModeHostInstructions, /Do not bypass Goal Mode budgets/);

  console.log(JSON.stringify({
    ok: true,
    version: packageJson.version,
    toolCount: tools.length,
    tools: EXPECTED_TOOLS,
  }, null, 2));
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
