export const SUPPORTED_GOAL_VERIFICATION_PROFILES = Object.freeze([
  "code-change",
  "read-only-audit",
  "system-operation",
]);

export const LEGACY_GOAL_VERIFICATION_PROFILE = "legacy-code-project";

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search_text",
  "search_files",
  "process_poll",
  "process_list",
  "local_list",
  "local_read",
  "local_list_known_folder",
  "local_read_known_folder",
  "local_probe_health",
]);

const READ_ONLY_GIT_ACTIONS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch_list",
  "worktree_list",
]);

const READ_ONLY_GITHUB_ACTIONS = new Set([
  "pr_view",
  "ci_status",
  "issue_view",
  "release_view",
]);

export function normalizeGoalVerificationProfile(value) {
  if (value === undefined) return LEGACY_GOAL_VERIFICATION_PROFILE;
  if (SUPPORTED_GOAL_VERIFICATION_PROFILES.includes(value)) return value;
  throw new TypeError(`unsupported goal verification profile: ${String(value)}`);
}

export function classifyGoalAction({ tool, input } = {}) {
  if (READ_ONLY_TOOLS.has(tool)) {
    return Object.freeze({ sideEffecting: false, rule: "read-only-tool" });
  }
  if (tool === "git" && READ_ONLY_GIT_ACTIONS.has(input?.action)) {
    return Object.freeze({ sideEffecting: false, rule: "read-only-git-action" });
  }
  if (tool === "github" && READ_ONLY_GITHUB_ACTIONS.has(input?.action)) {
    return Object.freeze({ sideEffecting: false, rule: "read-only-github-action" });
  }
  return Object.freeze({ sideEffecting: true, rule: "side-effecting-or-unknown-tool" });
}
