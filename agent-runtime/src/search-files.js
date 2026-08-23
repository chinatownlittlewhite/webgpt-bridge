import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR, resolveWorkspaceCwd } from "./workspace.js";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  INTERNAL_STATE_DIR,
  LEGACY_INTERNAL_STATE_DIR,
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
]);

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  if (typeof glob !== "string" || glob.length === 0) throw new TypeError("glob must be non-empty");
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function searchFiles({
  workspace,
  cwd = ".",
  glob = "**/*",
  limit = 500,
  includeHidden = false,
  includeIgnored = false,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new RangeError("limit must be between 1 and 5000");
  }

  const { root, cwd: start } = resolveWorkspaceCwd(workspace, cwd);
  const matcher = globToRegExp(glob.replaceAll("\\", "/"));
  const matches = [];
  let truncated = false;

  function walk(directory) {
    if (truncated) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (!includeIgnored && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativeToStart = path.relative(start, full).split(path.sep).join("/");
      if (!matcher.test(relativeToStart)) continue;
      matches.push(path.relative(root, full).split(path.sep).join("/"));
      if (matches.length >= limit) {
        truncated = true;
        return;
      }
    }
  }

  walk(start);
  return { matches, truncated };
}
