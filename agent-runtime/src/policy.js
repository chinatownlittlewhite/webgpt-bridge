import path from "node:path";
import securityPolicyCore from "../shared/security-policy-core.cjs";

const { authorizeSecurityOperation, isImmutableDeniedExecutable } = securityPolicyCore;
const SAFE_NPM_RUN_SCRIPTS = new Set(["test", "lint", "build", "typecheck", "check"]);
const APPROVAL_COMMANDS = new Set([
  "curl",
  "wget",
  "docker",
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
]);

function assertArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError("argv must be a non-empty array");
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length === 0 || arg.includes("\0")) {
      throw new TypeError("argv entries must be non-empty strings without NUL bytes");
    }
  }

  if (argv[0].includes("/") || argv[0].includes("\\")) {
    throw new TypeError("argv[0] must be an executable name resolved through the trusted PATH");
  }
}

function hasGitOption(args, option) {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function gitReadOperationNeedsApproval(args) {
  return (
    hasGitOption(args, "--output") ||
    args.includes("--ext-diff") ||
    args.includes("--textconv")
  );
}

function fromCore(commandClass, reason) {
  const authorization = authorizeSecurityOperation({ type: "agent-command", commandClass });
  return {
    decision: authorization.decision === "confirm" ? "approval_required" : authorization.decision,
    reason: reason || authorization.reason,
    rule: authorization.rule,
  };
}

export function classifyCommand(argv) {
  assertArgv(argv);
  const command = path.basename(argv[0]).toLowerCase();
  const args = argv.slice(1);

  if (isImmutableDeniedExecutable(command)) {
    return fromCore("immutable-deny", `${command} is blocked by policy`);
  }

  if (command === "git") {
    const subcommand = args[0] ?? "";
    if (["status", "diff", "log", "show", "branch", "worktree"].includes(subcommand)) {
      if (gitReadOperationNeedsApproval(args)) {
        return fromCore("git-read-sensitive", "Git read flags can write files or invoke external helpers");
      }
      return fromCore("git-read", "Read-only Git command");
    }
    return fromCore("git-mutation", "Git mutation or path-sensitive operation requires approval");
  }

  if (command === "npm") {
    if (args[0] === "run" && SAFE_NPM_RUN_SCRIPTS.has(args[1])) {
      return fromCore("project-check", `Known project check: npm run ${args[1]}`);
    }
    if (args[0] === "test") return fromCore("project-check", "Known project check: npm test");
    return fromCore("package-manager", "Package-manager mutations or arbitrary scripts require approval");
  }

  if (command === "node" && args[0] === "--test") {
    return fromCore("project-check", "Node test runner");
  }

  if (APPROVAL_COMMANDS.has(command)) {
    return fromCore("approval-command", `${command} may mutate state or access the network`);
  }

  return fromCore("unknown-command", "Unknown commands require approval by default");
}
