import path from "node:path";
import { resolveWorkspaceCwd, resolveWorkspacePath } from "./workspace.js";

function workspaceRelative(root, absolutePath) {
  return path.relative(root, absolutePath) || ".";
}

function resolveGoalRoot(workspace, goalCwd) {
  const { root, cwd } = resolveWorkspaceCwd(workspace, goalCwd);
  return { workspaceRoot: root, goalRoot: cwd };
}

function scopeCwd(workspace, goalCwd, requestedCwd = ".") {
  const { workspaceRoot, goalRoot } = resolveGoalRoot(workspace, goalCwd);
  const { cwd } = resolveWorkspaceCwd(goalRoot, requestedCwd);
  return workspaceRelative(workspaceRoot, cwd);
}

function scopeFile(workspace, goalCwd, requestedPath, { allowMissing = false } = {}) {
  const { workspaceRoot, goalRoot } = resolveGoalRoot(workspace, goalCwd);
  const resolved = resolveWorkspacePath(goalRoot, requestedPath, { allowMissing });
  return workspaceRelative(workspaceRoot, resolved.path);
}

function assertSafeGitPathspec(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Git pathspecs in goal mode must be non-empty strings without NUL bytes");
  }
  if (path.isAbsolute(value)) {
    throw new Error("absolute Git pathspecs are not allowed in goal mode");
  }
  if (value.startsWith(":")) {
    throw new Error("Git pathspec magic is not allowed in goal mode");
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Git pathspec escapes the goal cwd");
  }
  return value;
}

export function validateGoalCwd(workspace, goalCwd) {
  return scopeCwd(workspace, goalCwd, ".");
}

export function scopeGoalToolInput({ workspace, goalCwd, toolName, input } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("goal tool input must be an object");
  }

  switch (toolName) {
    case "run_command":
    case "run_project_task":
    case "dependency_sync":
    case "github":
    case "process_start":
    case "search_files":
      return {
        ...input,
        cwd: scopeCwd(workspace, goalCwd, input.cwd ?? "."),
      };

    case "read_file":
      return {
        ...input,
        path: scopeFile(workspace, goalCwd, input.path),
      };

    case "list_dir":
    case "search_text":
      return {
        ...input,
        path: scopeFile(workspace, goalCwd, input.path ?? "."),
      };

    case "git":
      return {
        ...input,
        cwd: scopeCwd(workspace, goalCwd, input.cwd ?? "."),
        ...(Array.isArray(input.paths)
          ? { paths: input.paths.map((entry) => assertSafeGitPathspec(entry)) }
          : {}),
      };

    case "apply_patch":
      return {
        ...input,
        changes: Array.isArray(input.changes)
          ? input.changes.map((change) => ({
              ...change,
              path: scopeFile(workspace, goalCwd, change.path, {
                allowMissing: change.type === "add",
              }),
            }))
          : input.changes,
      };

    case "delete_file":
      return {
        ...input,
        path: scopeFile(workspace, goalCwd, input.path),
      };

    case "move_file":
      return {
        ...input,
        from: scopeFile(workspace, goalCwd, input.from),
        to: scopeFile(workspace, goalCwd, input.to, { allowMissing: true }),
      };

    default:
      return { ...input };
  }
}
