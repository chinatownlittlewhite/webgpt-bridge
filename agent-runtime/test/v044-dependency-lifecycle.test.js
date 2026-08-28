import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNestedMacOSManagedRunner } from "../scripts/run-tests.mjs";
import { createCommandRunner } from "../src/runner.js";
import { createProcessManager } from "../src/process-manager.js";
import { createDependencySyncTool, createProcessTools } from "../src/tool.js";
import * as serverModule from "../src/server.js";

function verifiedSandbox(name = "verified-test") {
  return Object.freeze({
    name,
    enforced: true,
    autoRunSafe: true,
    verificationId: `${name}-verification`,
    capabilities: {
      readIsolation: "test",
      writeIsolation: "test",
      networkIsolation: "test",
      processIsolation: "test",
    },
    wrapArgv({ argv }) {
      return [...argv];
    },
  });
}

test("MCP v2 request cancellation is converted into trusted tool context", () => {
  assert.equal(typeof serverModule.trustedContextFromMcp, "function", "server must expose the trusted-context adapter used by MCP handlers");
  const controller = new AbortController();
  const approve = () => true;
  const trusted = serverModule.trustedContextFromMcp({ mcpReq: { signal: controller.signal } }, approve);
  assert.strictEqual(trusted.signal, controller.signal);
  assert.strictEqual(trusted.requestApproval, approve);
  assert.equal(Object.hasOwn(trusted, "mcpReq"), false);
});

test(
  "aborting a synchronous command returns canceled instead of waiting for command timeout",
  {
    skip: isNestedMacOSManagedRunner()
      ? "top-level macOS acceptance covers process cancellation; nested Seatbelt verification cannot signal descendants"
      : false,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-abort-"));
    try {
      const controller = new AbortController();
      const timeoutMs = 1_000;
      const run = createCommandRunner({
        workspace: root,
        timeoutMs,
        sandboxAdapter: verifiedSandbox("abort-sandbox"),
      });
      const pending = run({
        argv: ["node", "-e", "setTimeout(() => {}, 5000)"],
        requestApproval: () => true,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      assert.equal(result.status, "canceled");
      assert.notEqual(result.status, "timed_out");
      assert.ok(result.durationMs < timeoutMs, `cancel should complete before timeout, got ${result.durationMs}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("dependency_sync delegates to the shared process manager and returns a managed running operation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-dependency-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }), "utf8");
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }), "utf8");
    const networkSandbox = verifiedSandbox("dependency-network");
    let seen = null;
    const processManager = {
      async start(input, trustedContext, executionOptions) {
        seen = { input, trustedContext, executionOptions };
        return {
          status: "running",
          processId: "dependency-process-1",
          pid: 1234,
          kind: executionOptions?.kind,
          metadata: executionOptions?.metadata,
          nextAction: { tool: "process_poll", arguments: { processId: "dependency-process-1", cursor: 0, maxChunks: 100 } },
        };
      },
    };
    const requestApproval = () => false;
    const tool = createDependencySyncTool({
      workspace: root,
      networkSandboxAdapter: networkSandbox,
      processManager,
      platform: process.platform,
    });
    const result = await tool.invoke({ cwd: ".", allowScripts: false }, { requestApproval, goalSessionId: "goal-dependency" });
    assert.equal(result.status, "running");
    assert.equal(result.processId, "dependency-process-1");
    assert.equal(result.kind, "dependency-sync");
    assert.equal(result.metadata.manager, "npm");
    assert.deepEqual(result.nextAction, { tool: "process_poll", arguments: { processId: "dependency-process-1", cursor: 0, maxChunks: 100 } });
    assert.ok(seen);
    assert.equal(seen.input.argv[0], "npm");
    assert.equal(seen.trustedContext.requestApproval, requestApproval);
    assert.equal(seen.trustedContext.goalSessionId, "goal-dependency");
    assert.strictEqual(seen.executionOptions.sandboxAdapter, networkSandbox);
    assert.equal(seen.executionOptions.kind, "dependency-sync");
    assert.equal(seen.executionOptions.metadata.manager, "npm");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public process_start cannot supply internal sandbox execution options", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-process-public-"));
  try {
    const processManager = createProcessManager({ workspace: root, sandboxAdapter: verifiedSandbox("default-sandbox") });
    const tools = createProcessTools({ workspace: root, processManager });
    const schema = tools.find((tool) => tool.name === "process_start")?.inputSchema;
    assert.ok(schema);
    assert.equal(Object.hasOwn(schema.properties, "sandboxAdapter"), false);
    assert.equal(Object.hasOwn(schema.properties, "kind"), false);
    assert.equal(Object.hasOwn(schema.properties, "metadata"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("internal managed start can select a per-operation sandbox without changing the public default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-process-internal-"));
  try {
    const defaultSandbox = verifiedSandbox("default-sandbox");
    const networkSandbox = verifiedSandbox("network-sandbox");
    const processManager = createProcessManager({ workspace: root, sandboxAdapter: defaultSandbox });
    const process = await processManager.start(
      { argv: ["node", "-e", "setTimeout(() => {}, 2000)"] },
      { requestApproval: () => true, goalSessionId: "goal-process" },
      { sandboxAdapter: networkSandbox, kind: "dependency-sync", metadata: { manager: "npm" } },
    );
    try {
      assert.equal(process.status, "running");
      assert.equal(process.kind, "dependency-sync");
      assert.deepEqual(process.metadata, { manager: "npm" });
      const status = processManager.poll({ processId: process.processId, cursor: 0, maxChunks: 10 }, { goalSessionId: "goal-process" });
      assert.equal(status.kind, "dependency-sync");
      assert.deepEqual(status.metadata, { manager: "npm" });
    } finally {
      await processManager.kill({ processId: process.processId }, { goalSessionId: "goal-process" });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
