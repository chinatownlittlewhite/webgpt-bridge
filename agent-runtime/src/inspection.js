import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { searchFiles } from "./search-files.js";
import { INTERNAL_STATE_DIR, LEGACY_INTERNAL_STATE_DIR, resolveModelWorkspacePath } from "./workspace.js";

const DEFAULT_MAX_READ_LINES = 400;
const DEFAULT_MAX_READ_BYTES = 64_000;
const DEFAULT_MAX_SEARCH_RESULTS = 200;
const DEFAULT_MAX_SEARCH_FILES = 5_000;
const DEFAULT_MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024;
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

function positiveInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function workspacePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/") || ".";
}

function decodeUtf8(buffer, requestedPath) {
  if (buffer.includes(0)) throw new Error(`${requestedPath}: binary file content is not supported`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${requestedPath}: file is not valid UTF-8`);
  }
}

export function readWorkspaceFile({
  workspace,
  path: requestedPath,
  startLine = 1,
  endLine,
  maxLines = DEFAULT_MAX_READ_LINES,
  maxBytes = DEFAULT_MAX_READ_BYTES,
} = {}) {
  positiveInteger(startLine, "startLine", 1, 10_000_000);
  if (endLine !== undefined) {
    positiveInteger(endLine, "endLine", startLine, 10_000_000);
  }
  positiveInteger(maxLines, "maxLines", 1, 5_000);
  positiveInteger(maxBytes, "maxBytes", 1_024, 1_000_000);

  const resolved = resolveModelWorkspacePath(workspace, requestedPath);
  const stat = fs.statSync(resolved.path);
  if (!stat.isFile()) throw new Error(`${requestedPath}: not a file`);

  const requestedEnd = endLine ?? Number.POSITIVE_INFINITY;
  const selected = [];
  let selectedBytes = 0;
  let actualEndLine = null;
  let totalLines = 0;
  let currentLineNumber = 1;
  let currentLine = "";
  let currentLineBytes = 0;
  let currentLineOverflow = false;
  let currentLineHasData = false;
  let pendingCr = false;
  let selectionStopped = false;
  let blockedLineNumber = null;
  let truncated = false;

  function shouldCaptureCurrentLine() {
    return !selectionStopped && currentLineNumber >= startLine && currentLineNumber <= requestedEnd;
  }

  function appendSegment(segment) {
    if (segment.length === 0) return;
    currentLineHasData = true;
    if (!shouldCaptureCurrentLine() || currentLineOverflow) return;
    const segmentBytes = Buffer.byteLength(segment);
    if (currentLineBytes + segmentBytes > maxBytes) {
      currentLineOverflow = true;
      return;
    }
    currentLine += segment;
    currentLineBytes += segmentBytes;
  }

  function finishLine() {
    totalLines += 1;
    if (shouldCaptureCurrentLine()) {
      const separatorBytes = selected.length > 0 ? 1 : 0;
      if (currentLineOverflow) {
        truncated = true;
        selectionStopped = true;
        blockedLineNumber = currentLineNumber;
      } else if (
        selected.length >= maxLines ||
        selectedBytes + separatorBytes + currentLineBytes > maxBytes
      ) {
        truncated = true;
        selectionStopped = true;
      } else {
        selected.push(currentLine);
        selectedBytes += separatorBytes + currentLineBytes;
        actualEndLine = currentLineNumber;
      }
    }
    currentLineNumber += 1;
    currentLine = "";
    currentLineBytes = 0;
    currentLineOverflow = false;
    currentLineHasData = false;
  }

  function processDecoded(text) {
    let segmentStart = 0;
    if (pendingCr) {
      finishLine();
      pendingCr = false;
      if (text.startsWith("\n")) segmentStart = 1;
    }

    for (let index = segmentStart; index < text.length; index += 1) {
      const char = text[index];
      if (char !== "\n" && char !== "\r") continue;
      appendSegment(text.slice(segmentStart, index));
      if (char === "\r" && index + 1 >= text.length) {
        pendingCr = true;
        segmentStart = index + 1;
        break;
      }
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishLine();
      segmentStart = index + 1;
    }
    if (segmentStart < text.length) appendSegment(text.slice(segmentStart));
  }

  const hash = crypto.createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(resolved.path, "r");
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) throw new Error(`${requestedPath}: binary file content is not supported`);
      hash.update(chunk);
      let decoded;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw new Error(`${requestedPath}: file is not valid UTF-8`);
      }
      processDecoded(decoded);
    }
    let tail;
    try {
      tail = decoder.decode();
    } catch {
      throw new Error(`${requestedPath}: file is not valid UTF-8`);
    }
    if (tail) processDecoded(tail);
    if (pendingCr) {
      finishLine();
      pendingCr = false;
    } else if (currentLineHasData) {
      finishLine();
    }
  } finally {
    fs.closeSync(fd);
  }

  const availableEnd = Math.min(requestedEnd, totalLines);
  if (!selectionStopped && actualEndLine !== null && actualEndLine < availableEnd) truncated = true;
  const nextStartLine = truncated && blockedLineNumber === null && actualEndLine !== null
    ? actualEndLine + 1
    : null;
  const relativePath = workspacePath(resolved.root, resolved.path);
  return {
    path: relativePath,
    content: selected.join("\n"),
    startLine,
    endLine: actualEndLine,
    totalLines,
    totalBytes: stat.size,
    returnedBytes: selectedBytes,
    sha256: hash.digest("hex"),
    truncated,
    streaming: true,
    nextAction: nextStartLine
      ? {
          tool: "read_file",
          arguments: {
            path: relativePath,
            startLine: nextStartLine,
            ...(endLine !== undefined ? { endLine } : {}),
            maxLines,
            maxBytes,
          },
        }
      : blockedLineNumber !== null
        ? { hint: `Line ${blockedLineNumber} exceeds the current maxBytes budget; increase maxBytes or inspect that content with a more targeted tool.` }
        : null,
  };
}

export function listWorkspaceDirectory({
  workspace,
  path: requestedPath = ".",
  recursive = false,
  maxDepth = 3,
  maxEntries = 500,
  includeHidden = false,
  includeIgnored = false,
} = {}) {
  positiveInteger(maxDepth, "maxDepth", 1, 12);
  positiveInteger(maxEntries, "maxEntries", 1, 5_000);
  const resolved = resolveModelWorkspacePath(workspace, requestedPath);
  if (!fs.statSync(resolved.path).isDirectory()) throw new Error(`${requestedPath}: not a directory`);

  const entries = [];
  let truncated = false;

  function walk(directory, depth) {
    if (truncated) return;
    const names = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (!includeIgnored && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const relative = workspacePath(resolved.root, full);
      let type = "other";
      if (entry.isSymbolicLink()) type = "symlink";
      else if (entry.isDirectory()) type = "directory";
      else if (entry.isFile()) type = "file";
      const item = { path: relative, type, depth };
      if (entry.isFile()) {
        try { item.bytes = fs.statSync(full).size; } catch {}
      }
      entries.push(item);
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (recursive && entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) {
        walk(full, depth + 1);
        if (truncated) return;
      }
    }
  }

  walk(resolved.path, 1);
  return {
    path: workspacePath(resolved.root, resolved.path),
    entries,
    truncated,
    limit: maxEntries,
    nextAction: truncated
      ? { hint: "Increase maxEntries or narrow path/maxDepth." }
      : null,
  };
}

function lineMatches(line, query, caseSensitive) {
  if (caseSensitive) return line.indexOf(query);
  return line.toLowerCase().indexOf(query.toLowerCase());
}

export function searchWorkspaceText({
  workspace,
  query,
  path: requestedPath = ".",
  glob = "**/*",
  caseSensitive = false,
  contextLines = 0,
  maxResults = DEFAULT_MAX_SEARCH_RESULTS,
  maxFiles = DEFAULT_MAX_SEARCH_FILES,
  maxPreviewBytes = 2_000,
  includeHidden = false,
  includeIgnored = false,
} = {}) {
  if (typeof query !== "string" || query.length === 0 || query.length > 8_192 || query.includes("\0")) {
    throw new TypeError("query must be a non-empty string up to 8192 characters without NUL bytes");
  }
  positiveInteger(contextLines, "contextLines", 0, 20);
  positiveInteger(maxResults, "maxResults", 1, 2_000);
  positiveInteger(maxFiles, "maxFiles", 1, 20_000);
  positiveInteger(maxPreviewBytes, "maxPreviewBytes", 128, 32_000);

  const rootResolved = resolveModelWorkspacePath(workspace, requestedPath);
  if (!fs.statSync(rootResolved.path).isDirectory()) throw new Error(`${requestedPath}: not a directory`);
  const relativeCwd = workspacePath(rootResolved.root, rootResolved.path);
  const files = searchFiles({
    workspace,
    cwd: relativeCwd,
    glob,
    limit: maxFiles,
    includeHidden,
    includeIgnored,
  });

  const matches = [];
  let skippedBinary = 0;
  let skippedLarge = 0;
  let scannedFiles = 0;
  let truncated = false;

  for (const file of files.matches) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    const resolved = resolveModelWorkspacePath(workspace, file);
    const stat = fs.statSync(resolved.path);
    if (stat.size > DEFAULT_MAX_SEARCH_FILE_BYTES) {
      skippedLarge += 1;
      continue;
    }
    const raw = fs.readFileSync(resolved.path);
    let text;
    try {
      text = decodeUtf8(raw, file);
    } catch {
      skippedBinary += 1;
      continue;
    }
    scannedFiles += 1;
    const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const columnIndex = lineMatches(lines[index], query, caseSensitive);
      if (columnIndex < 0) continue;
      const before = lines.slice(Math.max(0, index - contextLines), index);
      const after = lines.slice(index + 1, Math.min(lines.length, index + contextLines + 1));
      let preview = lines[index];
      if (Buffer.byteLength(preview) > maxPreviewBytes) {
        const buffer = Buffer.from(preview);
        preview = `${buffer.subarray(0, maxPreviewBytes).toString("utf8")}…`;
      }
      matches.push({
        path: file,
        line: index + 1,
        column: columnIndex + 1,
        preview,
        ...(contextLines > 0 ? { before, after } : {}),
      });
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }

  return {
    query,
    path: relativeCwd,
    matches,
    matchCount: matches.length,
    scannedFiles,
    skippedBinary,
    skippedLarge,
    truncated: truncated || files.truncated,
    nextAction: truncated || files.truncated
      ? { hint: "Narrow path/glob or increase maxResults/maxFiles within schema limits." }
      : null,
  };
}

export const inspectionDefaults = Object.freeze({
  maxReadLines: DEFAULT_MAX_READ_LINES,
  maxReadBytes: DEFAULT_MAX_READ_BYTES,
  maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
  maxSearchFiles: DEFAULT_MAX_SEARCH_FILES,
  maxSearchFileBytes: DEFAULT_MAX_SEARCH_FILE_BYTES,
});
