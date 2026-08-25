import { createCommandRunner } from "./runner.js";

function token(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.startsWith("-")) {
    throw new TypeError(`${name} must be a non-empty token that does not start with '-'`);
  }
  return value;
}

function positive(value, fallback, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) throw new RangeError(`value must be between 1 and ${max}`);
  return resolved;
}

export function buildGitHubArgv(input = {}) {
  switch (input.action) {
    case "pr_view":
      return ["gh", "pr", "view", ...(input.number ? [String(positive(input.number, 1, 1_000_000))] : []), "--json", "number,title,state,url,headRefName,baseRefName,statusCheckRollup"];
    case "pr_create": {
      if (typeof input.title !== "string" || input.title.trim().length === 0) throw new TypeError("PR title is required");
      if (typeof input.body !== "string") throw new TypeError("PR body must be a string");
      const args = ["gh", "pr", "create", "--title", input.title, "--body", input.body];
      if (input.base) args.push("--base", token(input.base, "base branch"));
      if (input.head) args.push("--head", token(input.head, "head branch"));
      return args;
    }
    case "ci_status":
      return ["gh", "run", "list", "--limit", String(positive(input.limit, 20, 100)), "--json", "databaseId,status,conclusion,name,workflowName,url,headBranch,headSha"];
    case "issue_view":
      return ["gh", "issue", "view", String(positive(input.number, 1, 1_000_000)), "--json", "number,title,state,url,body,labels,assignees"];
    case "issue_create": {
      if (typeof input.title !== "string" || input.title.trim().length === 0) throw new TypeError("issue title is required");
      if (typeof input.body !== "string") throw new TypeError("issue body must be a string");
      return ["gh", "issue", "create", "--title", input.title, "--body", input.body];
    }
    default:
      throw new TypeError(`unsupported GitHub action: ${String(input.action)}`);
  }
}

export function createGitHubRunner({ workspace, sandboxAdapter, platform = process.platform, auditLogger, timeoutMs = 120_000, githubCliPath } = {}) {
  const run = createCommandRunner({
    workspace,
    sandboxAdapter,
    platform,
    auditLogger,
    timeoutMs,
    trustedExecutablePaths: githubCliPath ? { gh: githubCliPath } : {},
  });
  return async function runGitHub(input = {}, trustedContext = {}) {
    return await run({
      argv: buildGitHubArgv(input),
      cwd: input.cwd ?? ".",
      env: { CI: "1" },
      requestApproval: trustedContext.requestApproval,
    });
  };
}
