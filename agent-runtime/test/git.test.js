import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGitArgv, createGitRunner } from "../src/git.js";

test("structured git diff disables external helpers and places paths after option terminator", () => {
  assert.deepEqual(
    buildGitArgv({ action: "diff", staged: true, stat: true, paths: ["--looks-like-an-option", "src/a.js"] }),
    [
      "git",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--cached",
      "--stat",
      "--",
      "--looks-like-an-option",
      "src/a.js",
    ],
  );
});

test("structured git show disables external helpers", () => {
  assert.deepEqual(buildGitArgv({ action: "show", revision: "HEAD" }), [
    "git",
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--format=fuller",
    "HEAD",
  ]);
});

test("branch and revision fields cannot be option-injected", () => {
  assert.throws(() => buildGitArgv({ action: "branch_create", name: "--help" }), /does not start/);
  assert.throws(() => buildGitArgv({ action: "show", revision: "--output=/tmp/leak" }), /does not start/);
});

test("git log limits are bounded", () => {
  assert.deepEqual(buildGitArgv({ action: "log", limit: 5 }), [
    "git",
    "log",
    "--oneline",
    "--decorate=no",
    "-n5",
  ]);
  assert.throws(() => buildGitArgv({ action: "log", limit: 201 }), /between 1 and 200/);
});

test("network Git actions are fixed to the configured origin and current branch", () => {
  assert.deepEqual(buildGitArgv({ action: "fetch" }), ["git", "fetch", "--prune", "origin"]);
  assert.deepEqual(buildGitArgv({ action: "pull" }), ["git", "pull", "--ff-only"]);
  assert.deepEqual(buildGitArgv({ action: "push" }), ["git", "push", "origin", "HEAD"]);
});

test("git mutations still require trusted-host approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-git-"));
  const runGit = createGitRunner({ workspace: root });
  const result = await runGit({ action: "branch_create", name: "feature/test" });
  assert.equal(result.status, "approval_required");
  assert.equal(result.policy.rule, "git-mutation");
  fs.rmSync(root, { recursive: true, force: true });
});
