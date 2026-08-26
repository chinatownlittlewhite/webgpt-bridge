import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendProjectTaskFailureDiagnostic,
  discoverProjectTask,
} from "../src/project-task.js";

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

test("failed project tasks append a bounded TAP failure block after long output", () => {
  const stdout = [
    "x".repeat(6_000),
    "not ok 23 - nested Windows regression identifies the failure",
    "  ---",
    "  failureType: 'testCodeFailure'",
    "  error: 'workspace child runtime assertion failed'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    "y".repeat(6_000),
  ].join("\n");
  const result = appendProjectTaskFailureDiagnostic({
    status: "completed",
    exitCode: 1,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });

  assert.match(result.stderr, /\[project-task failure excerpt\]/);
  assert.match(result.stderr, /not ok 23 - nested Windows regression identifies the failure/);
  assert.match(result.stderr, /workspace child runtime assertion failed/);
  assert.ok(Buffer.byteLength(result.stderr) <= 4_096);
});
