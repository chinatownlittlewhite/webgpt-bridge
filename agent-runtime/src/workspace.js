import fs from "node:fs";
import path from "node:path";

export const INTERNAL_STATE_DIR = ".webgpt-bridge";
export const LEGACY_INTERNAL_STATE_DIR = ".local-project-coding";

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertRelativeProjectPath(requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (requestedPath.includes("\0")) {
    throw new TypeError("path must not contain NUL bytes");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new Error("absolute paths are not allowed");
  }
}

export function resolveWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new TypeError("workspace must be a non-empty string");
  }
  const root = fs.realpathSync(path.resolve(workspace));
  const current = path.join(root, INTERNAL_STATE_DIR);
  const legacy = path.join(root, LEGACY_INTERNAL_STATE_DIR);
  if (!fs.existsSync(current) && fs.existsSync(legacy) && fs.statSync(legacy).isDirectory() && !fs.lstatSync(legacy).isSymbolicLink()) {
    fs.renameSync(legacy, current);
  }
  return root;
}

export function resolveWorkspacePath(workspace, requestedPath, { allowMissing = false } = {}) {
  assertRelativeProjectPath(requestedPath);
  const root = resolveWorkspace(workspace);
  const candidate = path.resolve(root, requestedPath);

  if (!isInside(root, candidate)) {
    throw new Error("path escapes the configured workspace");
  }

  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(root, realCandidate)) {
      throw new Error("path resolves through a symlink outside the configured workspace");
    }
    return { root, path: realCandidate };
  }

  if (!allowMissing) {
    throw new Error("path does not exist");
  }

  let ancestor = path.dirname(candidate);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const realAncestor = fs.realpathSync(ancestor);
  if (!isInside(root, realAncestor)) {
    throw new Error("path parent resolves through a symlink outside the configured workspace");
  }

  return { root, path: candidate };
}

export function resolveWorkspaceCwd(workspace, requestedCwd = ".") {
  const resolved = resolveWorkspacePath(workspace, requestedCwd);
  if (!fs.statSync(resolved.path).isDirectory()) {
    throw new Error("cwd must be a directory");
  }
  return { root: resolved.root, cwd: resolved.path };
}

export function createWorkspaceTemp(root) {
  const dir = path.join(root, INTERNAL_STATE_DIR, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
