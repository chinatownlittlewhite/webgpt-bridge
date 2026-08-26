import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR, resolveModelWorkspaceCwd } from "./workspace.js";

const INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const HANDOFF_NAMES = ["CONTEXT.md", "PLAN.md", "CHANGES.md", "TESTS.md", "TODO.md", "MANIFEST.json"];
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_FILE_BYTES = 32_000;
const DEFAULT_MAX_TOTAL_BYTES = 96_000;
const DEFAULT_MAX_SCAN_ENTRIES = 2_000;
const DEFAULT_MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".git", INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR, "node_modules", "dist", "build", ".venv", "venv", "__pycache__"]);

function boundedText(raw, maxBytes) {
  const buffer = Buffer.from(raw, "utf8");
  if (buffer.length <= maxBytes) return raw;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[TRUNCATED]`;
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function fileIdentity(fullPath) {
  const stat = fs.statSync(fullPath);
  return `${stat.dev}:${stat.ino}`;
}

export function loadProjectContext({
  workspace,
  cwd = ".",
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxScanEntries = DEFAULT_MAX_SCAN_ENTRIES,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const { root, cwd: projectRoot } = resolveModelWorkspaceCwd(workspace, cwd);
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  let scannedEntries = 0;
  let truncated = false;

  function addFile(full) {
    const canonical = fs.realpathSync(full);
    const identity = fileIdentity(canonical);
    if (seen.has(identity) || files.length >= maxFiles || totalBytes >= maxTotalBytes) return;
    seen.add(identity);
    const raw = fs.readFileSync(canonical, "utf8");
    const remaining = Math.max(0, Math.min(maxFileBytes, maxTotalBytes - totalBytes));
    const content = boundedText(raw, remaining);
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    files.push({
      path: relative(root, canonical),
      bytes,
      sha256: crypto.createHash("sha256").update(raw).digest("hex"),
      content,
    });
    if (Buffer.byteLength(raw) > remaining) truncated = true;
  }

  const ancestorChain = [];
  let cursor = projectRoot;
  while (true) {
    ancestorChain.push(cursor);
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !relative(root, parent) || relative(root, parent).startsWith("../")) break;
    cursor = parent;
  }
  ancestorChain.reverse();
  for (const directory of ancestorChain) {
    for (const name of INSTRUCTION_NAMES) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) addFile(candidate);
    }
  }
  const handoffDir = path.join(projectRoot, ".webgpt-handoff");
  if (fs.existsSync(handoffDir) && fs.statSync(handoffDir).isDirectory()) {
    for (const name of HANDOFF_NAMES) {
      const candidate = path.join(handoffDir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) addFile(candidate);
    }
  }

  const nested = [];
  function walk(directory, depth) {
    if (depth > maxDepth || scannedEntries >= maxScanEntries || nested.length >= maxFiles * 4) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maxScanEntries) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && INSTRUCTION_NAMES.has(entry.name)) {
        const canonical = fs.realpathSync(full);
        if (!seen.has(fileIdentity(canonical))) nested.push(relative(root, canonical));
      }
    }
  }
  walk(projectRoot, 1);

  const instructions = files.length === 0
    ? ""
    : files.map((file) => `\n### ${file.path}\n${file.content}`).join("\n").trim();

  return {
    cwd: relative(root, projectRoot),
    files: files.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
    nestedInstructionFiles: nested.slice(0, maxFiles * 4),
    instructions,
    totalBytes,
    truncated,
    scanTruncated: scannedEntries >= maxScanEntries,
  };
}

export const projectContextDefaults = Object.freeze({
  maxFiles: DEFAULT_MAX_FILES,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxScanEntries: DEFAULT_MAX_SCAN_ENTRIES,
  maxDepth: DEFAULT_MAX_DEPTH,
});
