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

function classifyGit(args) {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);

  if (subcommand === "status") return fromCore("git-read", "git status is read-only");

  if (["log", "show"].includes(subcommand)) {
    return gitReadOperationNeedsApproval(rest)
      ? fromCore("git-path-sensitive", `git ${subcommand} options can write output or invoke external helpers`)
      : fromCore("git-read", `git ${subcommand} is read-only with the selected options`);
  }

  if (subcommand === "diff") {
    return rest.includes("--no-index") || gitReadOperationNeedsApproval(rest)
      ? fromCore("git-path-sensitive", "git diff options can access arbitrary paths, write output, or invoke external helpers")
      : fromCore("git-read", "git diff is read-only inside the repository");
  }

  if (subcommand === "worktree" && rest[0] === "list") {
    return fromCore("git-read", "git worktree list is read-only");
  }

  if (subcommand === "branch") {
    const readOnly =
      rest.length === 0 ||
      rest.every((arg) =>
        arg === "--list" ||
        arg === "--show-current" ||
        arg === "--contains" ||
        arg.startsWith("--format="),
      );
    if (readOnly) return fromCore("git-read", "git branch invocation is read-only");
  }

  return fromCore("git-mutation", "Git mutations or path-sensitive operations require approval");
}

export function executableName(argv) {
  assertArgv(argv);
  return path.basename(argv[0]).toLowerCase();
}

export function classifyCommand(argv) {
  const command = executableName(argv);
  const args = argv.slice(1);

  if (isImmutableDeniedExecutable(command, "agent")) {
    return fromCore("immutable-deny", `${command} is blocked by the default policy`);
  }
  if (command === "ssh") return fromCore("ssh", "SSH requires App-owned host validation and approval");
  if (command === "git") return classifyGit(args);

  if (["npm", "pnpm", "yarn"].includes(command)) {
    if (args[0] === "test") return fromCore("project-check", "test command");
    if (args[0] === "run" && SAFE_NPM_RUN_SCRIPTS.has(args[1] ?? "")) {
      return fromCore("project-check", "known project check");
    }
    return fromCore("package-manager", "Package-manager mutations or arbitrary scripts require approval");
  }

  if (command === "node") {
    return args[0] === "--test"
      ? fromCore("project-check", "Node test runner")
      : fromCore("runtime-execution", "Arbitrary Node execution requires approval");
  }

  if (command === "pytest" || command === "ruff") return fromCore("project-check", "Python project check");

  if (command === "python" || command === "python3") {
    return args[0] === "-m" && ["pytest", "ruff"].includes(args[1] ?? "")
      ? fromCore("project-check", "Python project check")
      : fromCore("runtime-execution", "Arbitrary Python execution requires approval");
  }

  if (command === "cargo") {
    return ["test", "check"].includes(args[0] ?? "")
      ? fromCore("project-check", "Rust project check")
      : fromCore("runtime-execution", "Rust build or mutation commands require approval");
  }

  if (command === "go") {
    return args[0] === "test"
      ? fromCore("project-check", "Go tests")
      : fromCore("runtime-execution", "Go build or mutation commands require approval");
  }

  if (command === "make" && ["test", "lint", "check", "build"].includes(args[0] ?? "")) {
    return fromCore("project-check", "known Make target");
  }

  if (APPROVAL_COMMANDS.has(command)) {
    return fromCore("sensitive-command", `${command} can modify the workspace or access external resources`);
  }

  return fromCore("default-ask", "Unknown commands require approval by default");
}
