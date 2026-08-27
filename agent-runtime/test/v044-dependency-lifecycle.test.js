import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("aborting a synchronous command returns canceled instead of waiting for command timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-abort-"));
  try {
    const controller = new AbortController();
    const run = createCommandRunner({
      workspace: root,
      timeoutMs: 250,
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
    assert.ok(result.durationMs < 250, `cancel should complete before timeout, got ${result.durationMs}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(result.ecosystem, "node-npm");
    assert.equal(result.allowScripts, false);
    assert.ok(seen, "dependency_sync must call the shared process manager");
    assert.deepEqual(seen.input.argv, ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"]);
    assert.deepEqual(seen.input.env, { CI: "1" });
    assert.strictEqual(seen.trustedContext.requestApproval, requestApproval);
    assert.equal(seen.trustedContext.goalSessionId, "goal-dependency");
    assert.strictEqual(seen.executionOptions.sandboxAdapter, networkSandbox);
    assert.equal(typeof seen.executionOptions.platformRuntimeStager, "function");
    assert.equal(seen.executionOptions.kind, "dependency_sync");
    assert.deepEqual(seen.executionOptions.metadata, { ecosystem: "node-npm", allowScripts: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public process_start cannot supply internal sandbox execution options", async () => {
  const calls = [];
  const processManager = {
    start(...args) {
      calls.push(args);
      return { status: "running", processId: "public-process" };
    },
  };
  const processStart = createProcessTools(processManager).find((tool) => tool.name === "process_start");
  const trustedContext = { goalSessionId: "goal-public" };
  const result = await processStart.invoke({ argv: ["node", "--version"] }, trustedContext);
  assert.equal(result.status, "running");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2, "model-facing process_start must not receive an execution-options argument");
  assert.deepEqual(calls[0][0], { argv: ["node", "--version"] });
  assert.strictEqual(calls[0][1], trustedContext);
});

test("internal managed start can select a per-operation sandbox without changing the public default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v044-process-sandbox-"));
  let normalWraps = 0;
  let networkWraps = 0;
  const normalSandbox = Object.freeze({
    ...verifiedSandbox("normal-process"),
    wrapArgv({ argv }) {
      normalWraps += 1;
      return [...argv];
    },
  });
  const networkSandbox = Object.freeze({
    ...verifiedSandbox("network-process"),
    wrapArgv({ argv }) {
      networkWraps += 1;
      return [...argv];
    },
  });
  const manager = createProcessManager({ workspace: root, sandboxAdapter: normalSandbox, maxProcesses: 4 });
  try {
    const internal = await manager.start(
      { argv: ["node", "-e", "process.exit(0)"] },
      { requestApproval: () => true },
      { sandboxAdapter: networkSandbox, kind: "dependency_sync", metadata: { ecosystem: "node-npm", allowScripts: false } },
    );
    assert.equal(internal.kind, "dependency_sync");
    assert.deepEqual(internal.metadata, { ecosystem: "node-npm", allowScripts: false });
    assert.equal(networkWraps, 1, "internal dependency start must use the dedicated network sandbox");
    assert.equal(normalWraps, 0, "internal network start must not accidentally use the normal sandbox");

    const publicStart = await manager.start({ argv: ["node", "-e", "process.exit(0)"] }, { requestApproval: () => true });
    assert.equal(publicStart.kind, "process");
    assert.equal(normalWraps, 1, "ordinary managed process must keep using the normal sandbox");
  } finally {
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
