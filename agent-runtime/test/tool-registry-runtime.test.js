import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createRuntimeToolRegistry,
  goalEligibleRuntimeTools,
  orderRuntimeTools,
} from "../src/tool-registry.js";
import { createCoreTools } from "../src/tool.js";

const require = createRequire(import.meta.url);
const {
  TOOL_REGISTRY_VERSION,
  listBrokerToolNames,
  listGoalToolNames,
  listToolNames,
} = require("../../shared/tool-registry.cjs");

const schema = Object.freeze({ type: "object", additionalProperties: false, properties: {} });
const TEST_BROKER_AUTH = Object.freeze({ protocolVersion: 1, sessionId: "test-session", secret: "test-secret", agentVersion: "0.9.3" });

function fakeTool(name) {
  return { name, description: `${name} description`, inputSchema: schema, invoke() { return { status: "completed" }; } };
}

test("runtime registry binds real tool implementations onto canonical metadata", () => {
  const input = [fakeTool("apply_patch"), fakeTool("read_file")];
  const descriptors = createRuntimeToolRegistry(input);
  assert.deepEqual(descriptors.map((entry) => entry.name), ["read_file", "apply_patch"]);
  assert.equal(descriptors[0].goalEligible, true);
  assert.equal(descriptors[0].tool, input[1]);
  assert.equal(descriptors[0].invoke, input[1].invoke);
  assert.equal(descriptors[0].inputSchema, schema);
  assert.equal(Object.isFrozen(descriptors[0]), true);
  assert.deepEqual(orderRuntimeTools(input).map((tool) => tool.name), ["read_file", "apply_patch"]);
  assert.deepEqual(goalEligibleRuntimeTools(input).map((tool) => tool.name), ["read_file", "apply_patch"]);
});

test("runtime registry rejects unknown duplicate and incomplete complete catalogs", () => {
  assert.throws(() => createRuntimeToolRegistry([fakeTool("read_file"), fakeTool("read_file")]), /duplicate/i);
  assert.throws(() => createRuntimeToolRegistry([fakeTool("not_registered")]), /registry/i);
  assert.throws(() => createRuntimeToolRegistry([fakeTool("read_file")], { requireComplete: true }), /complete|missing/i);
});

test("createCoreTools uses canonical registry order and capability subsets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-runtime-registry-"));
  try {
    const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
    assert.deepEqual(tools.map((tool) => tool.name), listToolNames());
    const capabilities = tools.find((tool) => tool.name === "get_capabilities").invoke({});
    assert.deepEqual(capabilities.tools, listToolNames());
    assert.deepEqual(capabilities.goalTools, listGoalToolNames());
    assert.deepEqual(capabilities.brokerTools, []);
    assert.equal(capabilities.toolRegistry.version, TOOL_REGISTRY_VERSION);

    const brokerTools = createCoreTools({
      workspace: root,
      goalVerificationTasks: [],
      localBrokerSocket: path.join(root, "broker.sock"),
      localBrokerAuth: TEST_BROKER_AUTH,
    });
    assert.deepEqual(brokerTools.map((tool) => tool.name), listToolNames({ brokerEnabled: true }));
    const brokerCapabilities = brokerTools.find((tool) => tool.name === "get_capabilities").invoke({});
    assert.deepEqual(brokerCapabilities.goalTools, listGoalToolNames({ brokerEnabled: true }));
    assert.deepEqual(brokerCapabilities.brokerTools, listBrokerToolNames({ brokerEnabled: true }));
    assert.equal(brokerCapabilities.brokerTools.includes("host_approve_command"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
