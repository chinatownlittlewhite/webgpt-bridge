import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCommandRunner } from "./runner.js";
import {
  INTERNAL_STATE_DIR,
  resolveModelWorkspaceCwd,
  resolveWorkspace,
  resolveWorkspacePath,
} from "./workspace.js";

function safeName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return value;
}

function simpleRef(value, label = "revision") {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("-") || value.includes("\0")) {
    throw new TypeError(`${label} must be a bounded Git ref that does not start with '-'`);
  }
  return value;
}

function repoKey(repoRoot) {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

export function createManagedWorktreeRunner({ workspace, sandboxAdapter, platform = process.platform, auditLogger, timeoutMs = 120_000 } = {}) {
  const root = resolveWorkspace(workspace);
  const run = createCommandRunner({ workspace: root, sandboxAdapter, platform, auditLogger, timeoutMs });

  function targetFor(repoRoot, name) {
    const targetRelative = path.join(INTERNAL_STATE_DIR, "worktrees", repoKey(repoRoot), safeName(name, "worktree name"));
    const { path: target } = resolveWorkspacePath(root, targetRelative, { allowMissing: true });
    return { target, targetRelative: path.relative(root, target) || "." };
  }

  return async function manageWorktree(input = {}, trustedContext = {}) {
    const { cwd: repoRoot } = resolveModelWorkspaceCwd(root, input.cwd ?? ".", { platform });
    const repoRelative = path.relative(root, repoRoot) || ".";

    if (input.action === "list") {
      return await run({ argv: ["git", "worktree", "list", "--porcelain"], cwd: repoRelative, requestApproval: trustedContext.requestApproval });
    }

    const name = safeName(input.name, "worktree name");
    const { target, targetRelative } = targetFor(repoRoot, name);
    if (input.action === "create") {
      const branch = simpleRef(input.branch, "branch");
      const revision = simpleRef(input.revision ?? "HEAD");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const argv = input.createBranch === false
        ? ["git", "worktree", "add", target, branch]
        : ["git", "worktree", "add", "-b", branch, target, revision];
      const result = await run({
        argv,
        cwd: repoRelative,
        requestApproval: trustedContext.requestApproval,
        sandboxExtraWritePaths: [path.dirname(target)],
      });
      return { ...result, worktreeName: name, worktreePath: targetRelative, branch };
    }
    if (input.action === "remove") {
      const result = await run({
        argv: ["git", "worktree", "remove", ...(input.force === true ? ["--force"] : []), target],
        cwd: repoRelative,
        requestApproval: trustedContext.requestApproval,
        sandboxExtraWritePaths: [path.dirname(target)],
      });
      return { ...result, worktreeName: name, worktreePath: targetRelative };
    }
    throw new TypeError(`unsupported worktree action: ${String(input.action)}`);
  };
}
