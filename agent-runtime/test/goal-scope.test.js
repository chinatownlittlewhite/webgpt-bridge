import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scopeGoalToolInput, validateGoalCwd } from "../src/goal-scope.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-goal-scope-"));
  fs.mkdirSync(path.join(root, "project", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "project", "packages", "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "sibling"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "src", "a.js"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "sibling", "secret.txt"), "secret\n", "utf8");
  return root;
}

test("goal cwd is normalized relative to the configured workspace", () => {
  const workspace = makeWorkspace();
  assert.equal(validateGoalCwd(workspace, "project"), "project");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("cwd-aware goal tools interpret cwd relative to the goal root", () => {
  const workspace = makeWorkspace();
  assert.deepEqual(
    scopeGoalToolInput({
      workspace,
      goalCwd: "project",
      toolName: "run_command",
      input: { argv: ["npm", "test"], cwd: "packages/a" },
    }),
    { argv: ["npm", "test"], cwd: path.join("project", "packages", "a") },
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("file mutations are translated into the goal root and cannot reach sibling projects", () => {
  const workspace = makeWorkspace();
  assert.deepEqual(
    scopeGoalToolInput({
      workspace,
      goalCwd: "project",
      toolName: "delete_file",
      input: { path: "src/a.js", expectedSha256: "a".repeat(64) },
    }),
    { path: path.join("project", "src", "a.js"), expectedSha256: "a".repeat(64) },
  );
  assert.throws(
    () =>
      scopeGoalToolInput({
        workspace,
        goalCwd: "project",
        toolName: "delete_file",
        input: { path: "../sibling/secret.txt", expectedSha256: "a".repeat(64) },
      }),
    /escapes the configured workspace/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("read/list/search inspection tools are scoped to the goal project", () => {
  const workspace = makeWorkspace();
  assert.deepEqual(
    scopeGoalToolInput({
      workspace,
      goalCwd: "project",
      toolName: "read_file",
      input: { path: "src/a.js", startLine: 1 },
    }),
    { path: path.join("project", "src", "a.js"), startLine: 1 },
  );
  assert.deepEqual(
    scopeGoalToolInput({
      workspace,
      goalCwd: "project",
      toolName: "search_text",
      input: { query: "export", path: "src" },
    }),
    { query: "export", path: path.join("project", "src") },
  );
  assert.throws(
    () => scopeGoalToolInput({
      workspace,
      goalCwd: "project",
      toolName: "list_dir",
      input: { path: "../sibling" },
    }),
    /escapes the configured workspace/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("structured patch paths are scoped to the goal project", () => {
  const workspace = makeWorkspace();
  const result = scopeGoalToolInput({
    workspace,
    goalCwd: "project",
    toolName: "apply_patch",
    input: {
      changes: [{ type: "add", path: "src/new.js", content: "export const x = 1;\n" }],
    },
  });
  assert.equal(result.changes[0].path, path.join("project", "src", "new.js"));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("Git pathspecs cannot escape the goal cwd or enable pathspec magic", () => {
  const workspace = makeWorkspace();
  assert.throws(
    () =>
      scopeGoalToolInput({
        workspace,
        goalCwd: "project",
        toolName: "git",
        input: { action: "diff", paths: ["../sibling/secret.txt"] },
      }),
    /escapes the goal cwd/,
  );
  assert.throws(
    () =>
      scopeGoalToolInput({
        workspace,
        goalCwd: "project",
        toolName: "git",
        input: { action: "diff", paths: [":(top)../sibling"] },
      }),
    /pathspec magic/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});
