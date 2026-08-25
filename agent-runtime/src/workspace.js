import fs from "node:fs";
import path from "node:path";

export const INTERNAL_STATE_DIR = ".webgpt-bridge";
export const LEGACY_INTERNAL_STATE_DIR = ".local-project-coding";

const MODEL_PRIVATE_DIRS = new Set([INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR]);
const MANAGED_WORKTREE_KEY = /^[0-9a-f]{16}$/i;
const MANAGED_WORKTREE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

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

function segmentEquals(left, right, platform) {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isModelPrivateSegment(segment, platform) {
  if (platform === "win32") {
    const normalized = segment.toLowerCase();
    return [...MODEL_PRIVATE_DIRS].some((entry) => entry.toLowerCase() === normalized);
  }
  return MODEL_PRIVATE_DIRS.has(segment);
}

function pathSegments(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "") return [];
  return relative.split(path.sep).filter(Boolean);
}

function canonicalMissingTarget(candidate) {
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  const suffix = [];
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  return path.resolve(realAncestor, ...suffix);
}

function assertPlainDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed worktree metadata is invalid: ${label} must be a plain directory`);
  }
}

function assertPlainFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`managed worktree metadata is invalid: ${label} must be a plain file`);
  }
}

function validateManagedWorktree(root, key, name) {
  const canonicalRoot = fs.realpathSync(root);
  const stateRoot = path.join(root, INTERNAL_STATE_DIR);
  const worktreesRoot = path.join(stateRoot, "worktrees");
  const keyedRoot = path.join(worktreesRoot, key);
  const worktreeRoot = path.join(keyedRoot, name);

  try {
    assertPlainDirectory(stateRoot, INTERNAL_STATE_DIR);
    assertPlainDirectory(worktreesRoot, "worktrees root");
    assertPlainDirectory(keyedRoot, "repo-key root");
    assertPlainDirectory(worktreeRoot, "worktree root");

    const dotGit = path.join(worktreeRoot, ".git");
    assertPlainFile(dotGit, "worktree .git");
    if (fs.statSync(dotGit).size > 4_096) {
      throw new Error("managed worktree metadata is invalid: worktree .git is too large");
    }
    const dotGitText = fs.readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGitText);
    if (!match) throw new Error("managed worktree metadata is invalid: worktree .git has no gitdir");

    const linkedCandidate = path.resolve(worktreeRoot, match[1]);
    assertPlainDirectory(linkedCandidate, "linked gitdir");
    const linkedGitDir = fs.realpathSync(linkedCandidate);

    const commondirFile = path.join(linkedGitDir, "commondir");
    assertPlainFile(commondirFile, "commondir");
    if (fs.statSync(commondirFile).size > 4_096) {
      throw new Error("managed worktree metadata is invalid: commondir is too large");
    }
    const commondirText = fs.readFileSync(commondirFile, "utf8").trim();
    if (!commondirText) throw new Error("managed worktree metadata is invalid: commondir is empty");
    const commonCandidate = path.resolve(linkedGitDir, commondirText);
    assertPlainDirectory(commonCandidate, "common Git directory");
    const commonGitDir = fs.realpathSync(commonCandidate);
    if (!isInside(canonicalRoot, commonGitDir)) {
      throw new Error("managed worktree metadata is invalid: common Git directory escapes workspace");
    }

    const expectedWorktreesRoot = path.join(commonGitDir, "worktrees");
    if (!isInside(expectedWorktreesRoot, linkedGitDir) || linkedGitDir === expectedWorktreesRoot) {
      throw new Error("managed worktree metadata is invalid: linked gitdir is outside common worktrees metadata");
    }
    return worktreeRoot;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("managed worktree metadata is invalid:")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`managed worktree metadata is invalid: ${message}`);
  }
}

function validateModelPrivatePath(root, candidate, platform) {
  const segments = pathSegments(root, candidate);
  const privateIndexes = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (isModelPrivateSegment(segments[index], platform)) privateIndexes.push(index);
  }
  if (privateIndexes.length === 0) return null;

  const validPrefix =
    privateIndexes[0] === 0 &&
    segments[0] === INTERNAL_STATE_DIR &&
    segments[1] === "worktrees" &&
    MANAGED_WORKTREE_KEY.test(segments[2] ?? "") &&
    MANAGED_WORKTREE_NAME.test(segments[3] ?? "");
  if (!validPrefix) {
    throw new Error("model access to host-private namespace is not allowed");
  }
  if (privateIndexes.some((index) => index >= 4)) {
    throw new Error("model access to nested host-private namespace is not allowed");
  }
  if (segments[4] && segmentEquals(segments[4], ".git", platform)) {
    throw new Error("managed worktree Git metadata is host-private");
  }

  const worktreeRoot = validateManagedWorktree(root, segments[2], segments[3]);
  return { worktreeRoot, segments };
}

function validateManagedWorktreeWorkspaceRoot(root) {
  const parts = root.split(path.sep);
  for (let markerIndex = 1; markerIndex < parts.length; markerIndex += 1) {
    if (
      markerIndex + 4 !== parts.length ||
      parts[markerIndex] !== INTERNAL_STATE_DIR ||
      parts[markerIndex + 1] !== "worktrees" ||
      !MANAGED_WORKTREE_KEY.test(parts[markerIndex + 2] ?? "") ||
      !MANAGED_WORKTREE_NAME.test(parts[markerIndex + 3] ?? "")
    ) {
      continue;
    }
    const hostWorkspace = parts.slice(0, markerIndex).join(path.sep) || path.parse(root).root;
    const worktreeRoot = validateManagedWorktree(hostWorkspace, parts[markerIndex + 2], parts[markerIndex + 3]);
    if (fs.realpathSync(worktreeRoot) !== root) {
      throw new Error("managed worktree metadata is invalid");
    }
    return true;
  }
  return false;
}

function assertManagedWorktreeRootGitPrivate(root, candidate, platform, managedWorkspaceRoot) {
  if (!managedWorkspaceRoot) return;
  const segments = pathSegments(root, candidate);
  if (segments[0] && segmentEquals(segments[0], ".git", platform)) {
    throw new Error("managed worktree Git metadata is host-private");
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

export function resolveModelWorkspacePath(
  workspace,
  requestedPath,
  { allowMissing = false, platform = process.platform } = {},
) {
  assertRelativeProjectPath(requestedPath);
  const root = resolveWorkspace(workspace);
  const candidate = path.resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("path escapes the configured workspace");
  }

  const managedWorkspaceRoot = validateManagedWorktreeWorkspaceRoot(root);
  assertManagedWorktreeRootGitPrivate(root, candidate, platform, managedWorkspaceRoot);
  const lexicalPrivate = validateModelPrivatePath(root, candidate, platform);
  const resolved = resolveWorkspacePath(root, requestedPath, { allowMissing });
  const canonical = canonicalMissingTarget(candidate);
  assertManagedWorktreeRootGitPrivate(root, canonical, platform, managedWorkspaceRoot);
  const canonicalPrivate = validateModelPrivatePath(root, canonical, platform);
  if (!lexicalPrivate && canonicalPrivate) {
    throw new Error("model access through a symlink into host-private namespace is not allowed");
  }
  return resolved;
}

export function resolveModelWorkspaceCwd(workspace, requestedCwd = ".", options = {}) {
  const resolved = resolveModelWorkspacePath(workspace, requestedCwd, options);
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
