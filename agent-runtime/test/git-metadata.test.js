import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverManagedWorktreeGitAccess } from "../src/git-metadata.js";

function makeManagedWorktree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-git-metadata-"));
  const repoRoot = path.join(root, "repo");
  const commonGitDir = path.join(repoRoot, ".git");
  const linkedGitDir = path.join(commonGitDir, "worktrees", "agent");
  fs.mkdirSync(linkedGitDir, { recursive: true });
  fs.writeFileSync(path.join(linkedGitDir, "commondir"), "../..\n", "utf8");
  const key = crypto.createHash("sha256").update(fs.realpathSync(repoRoot)).digest("hex").slice(0, 16);
  const worktreeRoot = path.join(root, ".webgpt-bridge", "worktrees", key, "agent");
  fs.mkdirSync(path.join(worktreeRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${linkedGitDir}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repoRoot, commonGitDir, linkedGitDir, worktreeRoot };
}

test("managed worktree Git grants are derived from the real worktree .git metadata", (t) => {
  const managed = makeManagedWorktree(t);
  const access = discoverManagedWorktreeGitAccess(path.join(managed.worktreeRoot, "src"));
  assert.deepEqual(access.extraReadPaths, [fs.realpathSync(managed.commonGitDir), fs.realpathSync(managed.linkedGitDir)]);
  assert.deepEqual(access.extraWritePaths, [fs.realpathSync(managed.commonGitDir), fs.realpathSync(managed.linkedGitDir)]);
});

test("nested fake host-private paths cannot replace the outer managed worktree Git grants", (t) => {
  const managed = makeManagedWorktree(t);
  const nested = path.join(managed.worktreeRoot, "src", ".webgpt-bridge", "worktrees", "aaaaaaaaaaaaaaaa", "fake", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const access = discoverManagedWorktreeGitAccess(nested);
  assert.deepEqual(access.extraReadPaths, [fs.realpathSync(managed.commonGitDir), fs.realpathSync(managed.linkedGitDir)]);
  assert.deepEqual(access.extraWritePaths, [fs.realpathSync(managed.commonGitDir), fs.realpathSync(managed.linkedGitDir)]);
});

test("invalid linked Git metadata fails closed without sandbox grants", (t) => {
  const managed = makeManagedWorktree(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-git-metadata-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(managed.linkedGitDir, "commondir"), `${outside}\n`, "utf8");
  assert.deepEqual(discoverManagedWorktreeGitAccess(managed.worktreeRoot), { extraReadPaths: [], extraWritePaths: [] });
});
