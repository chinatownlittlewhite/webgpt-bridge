import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const { listBrokerToolNames } = require("../../shared/tool-registry.cjs");

function testSocketPath(prefix) {
  if (process.platform === "win32") return `\\\\.\\pipe\\webgpt-bridge-${prefix}-${process.pid}-${Date.now()}`;
  if (process.platform === "darwin") return `/tmp/wgb-${prefix}-${process.pid}.sock`;
  return path.join(os.tmpdir(), `wgb-${prefix}-${process.pid}.sock`);
}

const TEST_AUTH = Object.freeze({ protocolVersion: 1, sessionId: "test-session", secret: "test-secret", agentVersion: "0.9.3" });

function expectedProof(auth, nonce) {
  const payload = `${auth.protocolVersion}\n${auth.sessionId}\n${auth.agentVersion}\n${nonce}`;
  return crypto.createHmac("sha256", auth.secret).update(payload).digest("base64url");
}

function authenticatedServer(handler) {
  return net.createServer((socket) => {
    let buffered = "";
    let state = "hello";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (state === "hello") {
          assert.deepEqual(message, {
            type: "hello",
            protocolVersion: TEST_AUTH.protocolVersion,
            sessionId: TEST_AUTH.sessionId,
            agentVersion: TEST_AUTH.agentVersion,
          });
          socket.write(`${JSON.stringify({ type: "challenge", nonce: "nonce-1" })}\n`);
          state = "authenticate";
          continue;
        }
        if (state === "authenticate") {
          assert.equal(message.type, "authenticate");
          assert.equal(message.nonce, "nonce-1");
          assert.equal(message.proof, expectedProof(TEST_AUTH, "nonce-1"));
          assert.equal(Object.hasOwn(message, "secret"), false);
          socket.write(`${JSON.stringify({ type: "hello_ok" })}\n`);
          state = "ready";
          continue;
        }
        handler(socket, message);
      }
    });
  });
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

test("local broker tool catalog follows the canonical broker registry", () => {
  const tools = createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-tools-registry.sock", auth: TEST_AUTH });
  assert.deepEqual(tools.map((tool) => tool.name), listBrokerToolNames({ brokerEnabled: true }));
});

test("broker method literals are resolved through the canonical registry", () => {
  const clientSource = fs.readFileSync(new URL("../src/local-broker-client.js", import.meta.url), "utf8");
  const toolSource = fs.readFileSync(new URL("../src/tool.js", import.meta.url), "utf8");
  const worktreeSource = fs.readFileSync(new URL("../src/worktree.js", import.meta.url), "utf8");
  assert.equal(clientSource.includes('client.request("host_approve_command"'), false);
  assert.equal(toolSource.includes('.request("local_run_command"'), false);
  assert.equal(worktreeSource.includes('.request("local_run_command"'), false);
  assert.match(clientSource, /findBrokerMethodByImplementation|brokerMethodForImplementation/);
});

test("local broker tools appear only when the App-owned bridge socket is configured", () => {
  const withoutBridge = createCoreTools({ workspace: process.cwd(), goalVerificationTasks: [] }).map((tool) => tool.name);
  assert.equal(withoutBridge.some((name) => LOCAL_TOOL_NAMES.includes(name)), false);
  const withBridge = createCoreTools({ workspace: process.cwd(), goalVerificationTasks: [], localBrokerSocket: "/tmp/webgpt-bridge-test.sock", localBrokerAuth: TEST_AUTH }).map((tool) => tool.name);
  for (const name of LOCAL_TOOL_NAMES) assert.equal(withBridge.includes(name), true);
});

test("host approval client allows a human-scale response window", () => {
  const requestApproval = createHostApprovalClient({ socketPath: "/tmp/webgpt-bridge-approval-test.sock", auth: TEST_AUTH });
  assert.equal(requestApproval.timeoutMs, 5 * 60_000);
});

test("local_run_command tells the model to prefer the sandboxed project runner", () => {
  const tools = new Map(createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-tools-test.sock", auth: TEST_AUTH }).map((tool) => [tool.name, tool]));
  assert.match(tools.get("local_run_command").description, /prefer .*run_command/i);
  assert.match(tools.get("local_run_command").description, /host integration/i);
});

test("interactive local broker tools allow a human-scale response window", () => {
  const tools = new Map(createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-tools-test.sock", auth: TEST_AUTH }).map((tool) => [tool.name, tool]));
  assert.equal(tools.get("local_list").timeoutMs, 20_000);
  assert.equal(tools.get("local_read").timeoutMs, 20_000);
  assert.equal(tools.get("local_stage_changes").timeoutMs, 20_000);
  assert.equal(tools.get("local_request_sensitive_access").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_request_host_access").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_confirm_batch").timeoutMs, 5 * 60_000);
  assert.equal(tools.get("local_run_command").timeoutMs, 5 * 60_000);
});

test("local broker client authenticates before sending one structured request over the App-owned socket", async (t) => {
  const socketPath = testSocketPath("t");
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  const server = authenticatedServer((socket, request) => {
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { method: request.method, path: request.params.path } })}\n`);
  });
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
  const client = createLocalBrokerClient({ socketPath, auth: TEST_AUTH });
  assert.deepEqual(await client.request("local_list", { path: "/tmp" }), { method: "local_list", path: "/tmp" });
});

test("configured local broker fails closed without authentication metadata", () => {
  assert.throws(() => createLocalBrokerClient({ socketPath: "/tmp/webgpt-bridge-test.sock" }), /auth|authentication|broker/i);
  assert.throws(() => createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-test.sock" }), /auth|authentication|broker/i);
});

test("local broker rejects protocol mismatch before sending a method frame", async (t) => {
  const socketPath = testSocketPath("m");
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  let methodFrames = 0;
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method) methodFrames += 1;
        socket.end(`${JSON.stringify({ type: "hello_error", code: "BROKER_PROTOCOL_MISMATCH" })}\n`);
      }
    });
  });
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
  const client = createLocalBrokerClient({ socketPath, auth: TEST_AUTH });
  await assert.rejects(client.request("local_list", { path: "/tmp" }), (error) => error?.code === "BROKER_PROTOCOL_MISMATCH");
  assert.equal(methodFrames, 0);
});

test("host approval client forwards generated approval metadata to the App-owned socket", async (t) => {
  const socketPath = testSocketPath("a");
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  const server = authenticatedServer((socket, request) => {
    assert.equal(request.method, "host_approve_command");
    assert.deepEqual(request.params.request.argv, ["npm", "test"]);
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { approved: true } })}\n`);
  });
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
  const requestApproval = createHostApprovalClient({ socketPath, auth: TEST_AUTH });
  assert.equal(await requestApproval({ argv: ["npm", "test"], cwd: ".", policy: { rule: "project-check" } }), true);
});
