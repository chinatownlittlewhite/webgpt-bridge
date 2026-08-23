import path from "node:path";

const SAFE_NPM_RUN_SCRIPTS = new Set(["test", "lint", "build", "typecheck", "check"]);
const ALWAYS_DENY = new Set(["sudo", "su", "ssh", "scp", "sftp"]);
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

function classifyGit(args) {
  const subcommand = args[0] ?? "";
  const rest = args.slice(1);

  if (subcommand === "status") {
    return {
      decision: "allow",
      reason: "git status is read-only",
      rule: "git-read-only",
    };
  }

  if (["log", "show"].includes(subcommand)) {
    if (gitReadOperationNeedsApproval(rest)) {
      return {
        decision: "approval_required",
        reason: `git ${subcommand} options can write output or invoke external helpers`,
        rule: "git-path-sensitive",
      };
    }
    return {
      decision: "allow",
      reason: `git ${subcommand} is read-only with the selected options`,
      rule: "git-read-only",
    };
  }

  if (subcommand === "diff") {
    if (rest.includes("--no-index") || gitReadOperationNeedsApproval(rest)) {
      return {
        decision: "approval_required",
        reason: "git diff options can access arbitrary paths, write output, or invoke external helpers",
        rule: "git-path-sensitive",
      };
    }
    return {
      decision: "allow",
      reason: "git diff is read-only inside the repository",
      rule: "git-read-only",
    };
  }

  if (subcommand === "worktree" && rest[0] === "list") {
    return {
      decision: "allow",
      reason: "git worktree list is read-only",
      rule: "git-read-only",
    };
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
    if (readOnly) {
      return {
        decision: "allow",
        reason: "git branch invocation is read-only",
        rule: "git-read-only",
      };
    }
  }

  return {
    decision: "approval_required",
    reason: "Git mutations or path-sensitive operations require approval",
    rule: "git-mutation",
  };
}

export function executableName(argv) {
  assertArgv(argv);
  return path.basename(argv[0]).toLowerCase();
}

export function classifyCommand(argv) {
  const command = executableName(argv);
  const args = argv.slice(1);

  if (ALWAYS_DENY.has(command)) {
    return {
      decision: "deny",
      reason: `${command} is blocked by the default policy`,
      rule: "always-deny",
    };
  }

  if (command === "git") {
    return classifyGit(args);
  }

  if (["npm", "pnpm", "yarn"].includes(command)) {
    if (args[0] === "test") {
      return { decision: "allow", reason: "test command", rule: "project-check" };
    }
    if (args[0] === "run" && SAFE_NPM_RUN_SCRIPTS.has(args[1] ?? "")) {
      return { decision: "allow", reason: "known project check", rule: "project-check" };
    }
    return {
      decision: "approval_required",
      reason: "Package-manager mutations or arbitrary scripts require approval",
      rule: "package-manager",
    };
  }

  if (command === "node") {
    if (args[0] === "--test") {
      return { decision: "allow", reason: "Node test runner", rule: "project-check" };
    }
    return {
      decision: "approval_required",
      reason: "Arbitrary Node execution requires approval",
      rule: "runtime-execution",
    };
  }

  if (command === "pytest" || command === "ruff") {
    return { decision: "allow", reason: "Python project check", rule: "project-check" };
  }

  if (command === "python" || command === "python3") {
    if (args[0] === "-m" && ["pytest", "ruff"].includes(args[1] ?? "")) {
      return { decision: "allow", reason: "Python project check", rule: "project-check" };
    }
    return {
      decision: "approval_required",
      reason: "Arbitrary Python execution requires approval",
      rule: "runtime-execution",
    };
  }

  if (command === "cargo") {
    if (["test", "check"].includes(args[0] ?? "")) {
      return { decision: "allow", reason: "Rust project check", rule: "project-check" };
    }
    return {
      decision: "approval_required",
      reason: "Rust build or mutation commands require approval",
      rule: "runtime-execution",
    };
  }

  if (command === "go") {
    if (args[0] === "test") {
      return { decision: "allow", reason: "Go tests", rule: "project-check" };
    }
    return {
      decision: "approval_required",
      reason: "Go build or mutation commands require approval",
      rule: "runtime-execution",
    };
  }

  if (command === "make" && ["test", "lint", "check", "build"].includes(args[0] ?? "")) {
    return { decision: "allow", reason: "known Make target", rule: "project-check" };
  }

  if (APPROVAL_COMMANDS.has(command)) {
    return {
      decision: "approval_required",
      reason: `${command} can modify the workspace or access external resources`,
      rule: "sensitive-command",
    };
  }

  return {
    decision: "approval_required",
    reason: "Unknown commands require approval by default",
    rule: "default-ask",
  };
}
