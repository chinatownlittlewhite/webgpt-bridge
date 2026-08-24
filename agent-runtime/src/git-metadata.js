import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR } from "./workspace.js";

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const MANAGED_WORKTREE_KEY = /^[0-9a-f]{16}$/i;
const MANAGED_WORKTREE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const EMPTY_ACCESS = Object.freeze({ extraReadPaths: [], extraWritePaths: [] });

function plainDirectory(directory) {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function plainFile(file) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
}

function candidateWorktrees(resolved) {
  const parts = resolved.split(path.sep);
  const candidates = [];
  for (let markerIndex = 1; markerIndex < parts.length; markerIndex += 1) {
    if (
      parts[markerIndex] !== INTERNAL_STATE_DIR ||
      parts[markerIndex + 1] !== "worktrees" ||
      !MANAGED_WORKTREE_KEY.test(parts[markerIndex + 2] ?? "") ||
      !MANAGED_WORKTREE_NAME.test(parts[markerIndex + 3] ?? "")
    ) {
      continue;
    }
    const workspaceRoot = parts.slice(0, markerIndex).join(path.sep) || path.parse(resolved).root;
    const worktreeRoot = parts.slice(0, markerIndex + 4).join(path.sep) || path.parse(resolved).root;
    if (inside(worktreeRoot, resolved)) candidates.push({ workspaceRoot, worktreeRoot });
  }
  return candidates;
}

function validateCandidate({ workspaceRoot, worktreeRoot }) {
  if (!plainDirectory(worktreeRoot)) return null;
  const dotGitFile = path.join(worktreeRoot, ".git");
  if (!plainFile(dotGitFile) || fs.statSync(dotGitFile).size > 4_096) return null;

  const text = fs.readFileSync(dotGitFile, "utf8").trim();
  const match = /^gitdir:\s*(.+)$/i.exec(text);
  if (!match) return null;
  const gitDirCandidate = path.resolve(worktreeRoot, match[1]);
  if (!plainDirectory(gitDirCandidate)) return null;
  const gitDir = fs.realpathSync(gitDirCandidate);

  const commondirFile = path.join(gitDir, "commondir");
  if (!plainFile(commondirFile) || fs.statSync(commondirFile).size > 4_096) return null;
  const commondir = fs.readFileSync(commondirFile, "utf8").trim();
  if (!commondir) return null;
  const commonCandidate = path.resolve(gitDir, commondir);
  if (!plainDirectory(commonCandidate)) return null;
  const commonGitDir = fs.realpathSync(commonCandidate);
  const canonicalWorkspace = fs.realpathSync(workspaceRoot);
  if (!inside(canonicalWorkspace, commonGitDir)) return null;

  const worktreesCandidate = path.join(commonGitDir, "worktrees");
  if (!plainDirectory(worktreesCandidate)) return null;
  const worktreesRoot = fs.realpathSync(worktreesCandidate);
  if (!inside(commonGitDir, worktreesRoot) || !inside(worktreesRoot, gitDir) || gitDir === worktreesRoot) return null;

  return {
    extraReadPaths: [commonGitDir, gitDir],
    extraWritePaths: [commonGitDir, gitDir],
  };
}

export function discoverManagedWorktreeGitAccess(cwd) {
  const resolved = path.resolve(cwd);
  try {
    for (const candidate of candidateWorktrees(resolved)) {
      const access = validateCandidate(candidate);
      if (access) return access;
    }
  } catch {
    // Git metadata is repository-controlled input. Invalid state never grants host paths.
  }
  return { ...EMPTY_ACCESS, extraReadPaths: [], extraWritePaths: [] };
}
