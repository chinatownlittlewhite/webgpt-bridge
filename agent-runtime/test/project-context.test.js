import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectContext } from "../src/project-context.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lpc-context-"));
}

test("project context injects ancestor/root instructions and only indexes nested files", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules\n", "utf8");
  fs.mkdirSync(path.join(root, "project", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "CLAUDE.md"), "project rules\n", "utf8");
  fs.writeFileSync(path.join(root, "project", "sub", "AGENTS.md"), "nested rules\n", "utf8");

  const context = loadProjectContext({ workspace: root, cwd: "project" });
  assert.deepEqual(context.files.map((entry) => entry.path), ["AGENTS.md", "project/CLAUDE.md"]);
  assert.match(context.instructions, /root rules/);
  assert.match(context.instructions, /project rules/);
  assert.doesNotMatch(context.instructions, /nested rules/);
  assert.deepEqual(context.nestedInstructionFiles, ["project/sub/AGENTS.md"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("project context is bounded by total bytes", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(20_000), "utf8");
  const context = loadProjectContext({ workspace: root, cwd: ".", maxFileBytes: 1_000, maxTotalBytes: 1_000 });
  assert.equal(context.truncated, true);
  assert.ok(context.totalBytes <= 1_100);
  assert.match(context.instructions, /TRUNCATED/);
  fs.rmSync(root, { recursive: true, force: true });
});
