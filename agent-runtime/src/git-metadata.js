import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR } from "./workspace.js";

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function discoverManagedWorktreeGitAccess(cwd) {
  const resolved = path.resolve(cwd);
  const parts = resolved.split(path.sep);
  const markerIndex = Math.max(parts.lastIndexOf(INTERNAL_STATE_DIR), parts.lastIndexOf(LEGACY_INTERNAL_STATE_DIR));
  if (markerIndex < 1 || parts[markerIndex + 1] !== "worktrees" || !parts[markerIndex + 2]) {
    return { extraReadPaths: [], extraWritePaths: [] };
  }

  const worktreeRoot = parts.slice(0, markerIndex + 3).join(path.sep) || path.parse(resolved).root;
  const projectRoot = parts.slice(0, markerIndex).join(path.sep) || path.parse(resolved).root;
  const commonGitDir = path.join(projectRoot, ".git");
  const dotGitFile = path.join(worktreeRoot, ".git");
  try {
    if (!fs.statSync(commonGitDir).isDirectory() || !fs.statSync(dotGitFile).isFile()) {
      return { extraReadPaths: [], extraWritePaths: [] };
    }
    const text = fs.readFileSync(dotGitFile, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(text);
    if (!match) return { extraReadPaths: [], extraWritePaths: [] };
    const gitDir = path.resolve(worktreeRoot, match[1]);
    const expectedWorktreesRoot = path.join(commonGitDir, "worktrees");
    if (!inside(expectedWorktreesRoot, gitDir)) return { extraReadPaths: [], extraWritePaths: [] };
    return {
      extraReadPaths: [commonGitDir, gitDir],
      extraWritePaths: [commonGitDir, gitDir],
    };
  } catch {
    return { extraReadPaths: [], extraWritePaths: [] };
  }
}
