import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverProjectTask } from "../src/project-task.js";

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-task-"));
  fs.mkdirSync(path.join(workspace, "node-project"));
  fs.writeFileSync(
    path.join(workspace, "node-project", "package.json"),
    JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
    "utf8",
  );
  fs.mkdirSync(path.join(workspace, "python-project"));
  fs.writeFileSync(path.join(workspace, "python-project", "pyproject.toml"), "[project]\nname='x'\n", "utf8");
  return workspace;
}

test("project task discovery honors a selected cwd", () => {
  const workspace = makeWorkspace();
  assert.deepEqual(discoverProjectTask({ workspace, cwd: "node-project", task: "test" }), {
    argv: ["npm", "test"],
    ecosystem: "node",
  });
  assert.deepEqual(discoverProjectTask({ workspace, cwd: "node-project", task: "lint" }), {
    argv: ["npm", "run", "lint"],
    ecosystem: "node",
  });
});

test("project task discovery supports Python checks", () => {
  const workspace = makeWorkspace();
  assert.deepEqual(discoverProjectTask({ workspace, cwd: "python-project", task: "test" }), {
    argv: ["python3", "-m", "pytest"],
    ecosystem: "python",
  });
});

test("project task discovery rejects unsupported task names", () => {
  const workspace = makeWorkspace();
  assert.throws(
    () => discoverProjectTask({ workspace, cwd: "node-project", task: "deploy" }),
    /unsupported project task/,
  );
});
