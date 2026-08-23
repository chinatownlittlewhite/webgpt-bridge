import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProcessManager } from "../src/process-manager.js";

const verifiedSandbox = Object.freeze({
  name: "process-test-sandbox",
  enforced: true,
  autoRunSafe: true,
  verificationId: "process-test",
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

async function waitForExit(manager, processId, trustedContext) {
  let cursor = 0;
  let text = "";
  for (let i = 0; i < 50; i += 1) {
    const polled = manager.poll({ processId, cursor }, trustedContext);
    if (polled.status === "not_found") return polled;
    for (const chunk of polled.chunks ?? []) text += chunk.text;
    cursor = polled.nextCursor ?? cursor;
    if (polled.status !== "running") return { ...polled, text };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { status: "timeout", text };
}

async function waitForOutput(manager, processId, expected, trustedContext) {
  for (let i = 0; i < 50; i += 1) {
    const polled = manager.poll({ processId, cursor: 0 }, trustedContext);
    const text = (polled.chunks ?? []).map((chunk) => chunk.text).join("");
    if (expected.test(text)) return true;
    if (polled.status !== "running") return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("managed process output is bounded and Goal ownership hides sibling processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-process-manager-"));
  const manager = createProcessManager({ workspace: root, sandboxAdapter: verifiedSandbox, maxProcesses: 4 });
  const owner = { goalSessionId: "goal-a", requestApproval: () => true };
  const other = { goalSessionId: "goal-b" };
  const started = await manager.start({
    argv: ["node", "-e", "process.stdout.write('hello'); setTimeout(() => {}, 5000)"],
  }, owner);
  assert.equal(started.status, "running");
  assert.equal(started.nextAction.tool, "process_poll");
  assert.equal(started.nextAction.arguments.processId, started.processId);
  assert.equal(manager.poll({ processId: started.processId }, other).status, "not_found");
  assert.equal(manager.input({ processId: started.processId, data: "x" }, other).status, "not_found");
  assert.equal((await manager.kill({ processId: started.processId }, other)).status, "not_found");
  assert.equal(manager.list({}, other).processes.length, 0);
  assert.equal(manager.list({}, owner).processes.length, 1);
  const ownerPoll = manager.poll({ processId: started.processId, cursor: 0 }, owner);
  assert.equal(ownerPoll.nextAction.tool, "process_poll");
  assert.equal(ownerPoll.nextAction.arguments.cursor, ownerPoll.nextCursor);
  assert.equal(await waitForOutput(manager, started.processId, /hello/, owner), true);

  const killed = await manager.kill({ processId: started.processId }, owner);
  assert.equal(killed.status, "kill_requested");
  const exited = await waitForExit(manager, started.processId, owner);
  assert.notEqual(exited.status, "running");
  assert.match(exited.text ?? "", /hello/);
  await manager.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("process manager close terminates all running children", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-process-close-"));
  const manager = createProcessManager({ workspace: root, sandboxAdapter: verifiedSandbox, maxProcesses: 4 });
  const approved = { requestApproval: () => true };
  const a = await manager.start({ argv: ["node", "-e", "setTimeout(() => {}, 5000)"] }, approved);
  const b = await manager.start({ argv: ["node", "-e", "setTimeout(() => {}, 5000)"] }, approved);
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  const closed = await manager.close();
  assert.equal(closed.status, "closed");
  assert.equal(closed.processesTerminated, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
