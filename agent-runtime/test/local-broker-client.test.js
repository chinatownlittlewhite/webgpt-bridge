import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  localConfirmBatchInputSchema,
  localListInputSchema,
  localReadInputSchema,
  localRequestHostAccessInputSchema,
  localRunCommandInputSchema,
  localStageChangesInputSchema,
  createHostApprovalClient,
  createLocalBrokerClient,
  createLocalBrokerTools,
} from "../src/local-broker-client.js";
import { validateJsonSchema } from "../src/schema-validate.js";
import { createCoreTools } from "../src/tool.js";

function testSocketPath(prefix) {
  if (process.platform === "win32") return `\\\\.\\pipe\\webgpt-bridge-${prefix}-${process.pid}-${Date.now()}`;
  if (process.platform === "darwin") return `/tmp/wgb-${prefix}-${process.pid}.sock`;
  return path.join(os.tmpdir(), `wgb-${prefix}-${process.pid}.sock`);
}

const LOCAL_TOOL_NAMES = [
  "local_list",
  "local_read",
  "local_request_sensitive_access",
  "local_request_host_access",
  "local_stage_changes",
  "local_confirm_batch",
  "local_run_command",
];

test("local broker schemas reject tokens, arbitrary repository controls, shells, sudo, and approval bypasses", () => {
  for (const schema of [localListInputSchema, localReadInputSchema, localRequestHostAccessInputSchema, localStageChangesInputSchema, localConfirmBatchInputSchema, localRunCommandInputSchema]) {
    assert.equal(schema.additionalProperties, false);
    for (const forbidden of ["token", "repository", "shell", "sudo", "approvalGranted", "requestApproval", "skipConfirmation"]) {
      assert.equal(Object.hasOwn(schema.properties, forbidden), false);
    }
  }
  assert.throws(() => validateJsonSchema({ path: "/tmp", token: "secret" }, localListInputSchema), /unexpected property token/);
  assert.throws(() => validateJsonSchema({ path: "/tmp/x", operation: "read", ttlMs: 999999 }, localRequestHostAccessInputSchema), /unexpected property ttlMs/);
  assert.throws(() => validateJsonSchema({ argv: ["sudo", "true"], cwd: "/tmp" }, localRunCommandInputSchema), /does not match|required/);
  assert.throws(() => validateJsonSchema({ argv: ["sh", "-c", "echo unsafe"], cwd: "/tmp" }, localRunCommandInputSchema), /does not match|required/);
  assert.throws(() => validateJsonSchema({ argv: ["npm", "test"], cwd: "/tmp", shell: "npm test" }, localRunCommandInputSchema), /unexpected property shell/);
});

test("local broker tools appear only when the App-owned bridge socket is configured", () => {
  const withoutBridge = createCoreTools({ workspace: process.cwd(), goalVerificationTasks: [] }).map((tool) => tool.name);
  assert.equal(withoutBridge.some((name) => LOCAL_TOOL_NAMES.includes(name)), false);
  const withBridge = createCoreTools({ workspace: process.cwd(), goalVerificationTasks: [], localBrokerSocket: "/tmp/webgpt-bridge-test.sock" }).map((tool) => tool.name);
  for (const name of LOCAL_TOOL_NAMES) assert.equal(withBridge.includes(name), true);
});

test("host approval client allows a human-scale response window", () => {
  const requestApproval = createHostApprovalClient({ socketPath: "/tmp/webgpt-bridge-approval-test.sock" });
  assert.equal(requestApproval.timeoutMs, 5 * 60_000);
});

test("local_run_command tells the model to prefer the sandboxed project runner", () => {
  const tools = new Map(createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-tools-test.sock" }).map((tool) => [tool.name, tool]));
  assert.match(tools.get("local_run_command").description, /prefer .*run_command/i);
  assert.match(tools.get("local_run_command").description, /host integration/i);
});

test("interactive local broker tools allow a human-scale response window", () => {
  const tools = new Map(createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-tools-test.sock" }).map((tool) => [tool.name, tool]));
  assert.equal(tools.get("local_list").timeoutMs, 20_000);
  assert.equal(tools.get("local_read").timeoutMs, 20_000);
  assert.equal(tools.get("local_stage_changes").timeoutMs, 20_000);
  assert.equal(tools.get("local_request_sensitive_access").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_request_host_access").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_confirm_batch").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_run_command").timeoutMs, 5 * 60_000);
});

test("local broker client sends one structured request over the App-owned socket", async (t) => {
  const socketPath = testSocketPath("t");
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => socket.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8"));
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { method: request.method, path: request.params.path } })}\n`);
  }));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("当前受限测试环境禁止绑定本机 IPC/TCP socket；正常桌面环境会执行该协议测试。");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  });
  const client = createLocalBrokerClient({ socketPath });
  assert.deepEqual(await client.request("local_list", { path: "/tmp" }), { method: "local_list", path: "/tmp" });
});

test("host approval client forwards generated approval metadata to the App-owned socket", async (t) => {
  const socketPath = testSocketPath("a");
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => socket.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8"));
    assert.equal(request.method, "host_approve_command");
    assert.deepEqual(request.params.request.argv, ["npm", "test"]);
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { approved: true } })}\n`);
  }));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("当前受限测试环境禁止绑定本机 IPC/TCP socket；正常桌面环境会执行该协议测试。");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  });
  const requestApproval = createHostApprovalClient({ socketPath });
  assert.equal(await requestApproval({ argv: ["npm", "test"], cwd: ".", policy: { rule: "project-check" } }), true);
});
