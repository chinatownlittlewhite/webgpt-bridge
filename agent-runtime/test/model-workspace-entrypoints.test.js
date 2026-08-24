import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverDependencySync } from "../src/dependency.js";
import { applyStructuredPatch } from "../src/filesystem.js";
import { validateGoalCwd } from "../src/goal-scope.js";
import { listWorkspaceDirectory, readWorkspaceFile, searchWorkspaceText } from "../src/inspection.js";
import { createProcessManager } from "../src/process-manager.js";
import { loadProjectContext } from "../src/project-context.js";
import { discoverProjectTask } from "../src/project-task.js";
import { createCommandRunner } from "../src/runner.js";
import { searchFiles } from "../src/search-files.js";
import { createManagedWorktreeRunner } from "../src/worktree.js";

const verifiedSandbox = Object.freeze({ name: "model-workspace-entrypoint-test", enforced: true, autoRunSafe: true, verificationId: "model-workspace-entrypoint-test", capabilities: { readIsolation: "test", writeIsolation: "test", networkIsolation: "test", processIsolation: "test" }, wrapArgv({ argv }) { return [...argv]; } });
function makeWorkspace(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-model-entrypoints-")); const privateRelative = path.join(".webgpt-bridge", "private-project"); const privateRoot = path.join(root, privateRelative); fs.mkdirSync(path.join(privateRoot, "src"), { recursive: true }); fs.writeFileSync(path.join(privateRoot, "src", "secret.txt"), "host-private\n", "utf8"); fs.writeFileSync(path.join(privateRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: {} }), "utf8"); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, privateRelative }; }

test("model-facing file, inspection, search, Goal, and project-context entrypoints reject host-private paths", (t) => {
  const { root, privateRelative } = makeWorkspace(t); const secret = path.join(privateRelative, "src", "secret.txt");
  assert.throws(() => readWorkspaceFile({ workspace: root, path: secret }), /host-private/);
  assert.throws(() => listWorkspaceDirectory({ workspace: root, path: privateRelative }), /host-private/);
  assert.throws(() => searchWorkspaceText({ workspace: root, path: privateRelative, query: "host-private" }), /host-private/);
  assert.throws(() => searchFiles({ workspace: root, cwd: privateRelative, glob: "**/*" }), /host-private/);
  assert.throws(() => validateGoalCwd(root, privateRelative), /host-private/);
  assert.throws(() => loadProjectContext({ workspace: root, cwd: privateRelative }), /host-private/);
  assert.throws(() => applyStructuredPatch({ workspace: root, changes: [{ type: "add", path: path.join(privateRelative, "new.txt"), content: "blocked\n" }] }), /host-private/);
});
test("model-facing runner, process, project-task, and dependency cwd reject host-private paths", async (t) => {
  const { root, privateRelative } = makeWorkspace(t); const runner = createCommandRunner({ workspace: root, sandboxAdapter: verifiedSandbox });
  await assert.rejects(() => runner({ argv: ["node", "-e", "process.exit(0)"], cwd: privateRelative }), /host-private/);
  const manager = createProcessManager({ workspace: root, sandboxAdapter: verifiedSandbox, maxProcesses: 2 }); t.after(async () => { await manager.close(); });
  await assert.rejects(() => manager.start({ argv: ["node", "-e", "process.exit(0)"], cwd: privateRelative }), /host-private/);
  assert.throws(() => discoverProjectTask({ workspace: root, cwd: privateRelative, task: "test" }), /host-private/);
  assert.throws(() => discoverDependencySync({ workspace: root, cwd: privateRelative }), /host-private/);
});
test("managed-worktree source cwd cannot be an arbitrary host-private directory", async (t) => {
  const { root, privateRelative } = makeWorkspace(t); const manageWorktree = createManagedWorktreeRunner({ workspace: root, sandboxAdapter: verifiedSandbox });
  await assert.rejects(() => manageWorktree({ action: "list", cwd: privateRelative }), /host-private/);
});
