import { createCommandRunner } from "./runner.js";

function assertSimpleToken(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.startsWith("-")) {
    throw new TypeError(`${name} must be a non-empty token that does not start with '-'`);
  }
  return value;
}

function assertRelativeWorktreePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new TypeError("worktree path must be a safe relative path without traversal");
  }
  return value;
}

function normalizePaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 256) {
    throw new TypeError("paths must be an array with at most 256 entries");
  }
  return paths.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new TypeError("path entries must be non-empty strings without NUL bytes");
    }
    return entry;
  });
}

export function buildGitArgv(input) {
  if (!input || typeof input !== "object") throw new TypeError("git input must be an object");

  switch (input.action) {
    case "status":
      return ["git", "status", ...(input.short === false ? [] : ["--short"])];
    case "diff": {
      const args = ["git", "diff", "--no-ext-diff", "--no-textconv"];
      if (input.staged === true) args.push("--cached");
      if (input.stat === true) args.push("--stat");
      const paths = normalizePaths(input.paths);
      if (paths.length) args.push("--", ...paths);
      return args;
    }
    case "log": {
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new RangeError("git log limit must be between 1 and 200");
      }
      return ["git", "log", "--oneline", "--decorate=no", `-n${limit}`];
    }
    case "show": {
      const revision = assertSimpleToken(input.revision ?? "HEAD", "revision");
      const args = ["git", "show", "--no-ext-diff", "--no-textconv", "--format=fuller", revision];
      const paths = normalizePaths(input.paths);
      if (paths.length) args.push("--", ...paths);
      return args;
    }
    case "branch_list":
      return ["git", "branch", "--list"];
    case "worktree_list":
      return ["git", "worktree", "list", "--porcelain"];
    case "worktree_create": {
      const worktreePath = assertRelativeWorktreePath(input.path);
      const branch = assertSimpleToken(input.name, "branch name");
      return ["git", "worktree", "add", worktreePath, branch];
    }
    case "worktree_remove": {
      const worktreePath = assertRelativeWorktreePath(input.path);
      return ["git", "worktree", "remove", ...(input.force === true ? ["--force"] : []), worktreePath];
    }
    case "branch_create":
      return ["git", "branch", assertSimpleToken(input.name, "branch name")];
    case "switch":
      return ["git", "switch", assertSimpleToken(input.name, "branch name")];
    case "add": {
      const paths = normalizePaths(input.paths);
      if (paths.length === 0) throw new TypeError("git add requires at least one path");
      return ["git", "add", "--", ...paths];
    }
    case "commit": {
      if (typeof input.message !== "string" || input.message.trim().length === 0 || input.message.includes("\0")) {
        throw new TypeError("commit message must be a non-empty string without NUL bytes");
      }
      return ["git", "commit", "-m", input.message];
    }
    case "restore": {
      const paths = normalizePaths(input.paths);
      if (paths.length === 0) throw new TypeError("git restore requires at least one path");
      return ["git", "restore", "--", ...paths];
    }
    default:
      throw new TypeError(`unsupported git action: ${String(input.action)}`);
  }
}

export function createGitRunner({ workspace, timeoutMs = 120_000, sandboxAdapter, platform = process.platform, auditLogger } = {}) {
  const run = createCommandRunner({ workspace, timeoutMs, sandboxAdapter, platform, auditLogger });
  return async function runGit(input, trustedContext = {}) {
    return await run({
      argv: buildGitArgv(input),
      cwd: input.cwd ?? ".",
      env: {},
      requestApproval:
        typeof trustedContext.requestApproval === "function"
          ? trustedContext.requestApproval
          : undefined,
    });
  };
}
