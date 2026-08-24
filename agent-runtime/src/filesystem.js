import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createWorkspaceTemp, resolveModelWorkspacePath, resolveWorkspace } from "./workspace.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(raw, requestedPath) {
  const hasBom = raw.subarray(0, 3).equals(UTF8_BOM);
  const body = hasBom ? raw.subarray(3) : raw;
  if (body.includes(0)) throw new Error(`${requestedPath}: binary files cannot be patched as UTF-8 text`);
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error(`${requestedPath}: file is not valid UTF-8`);
  }
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  const newline = crlf > lf ? "\r\n" : "\n";
  return { hasBom, content, newline };
}

function readUtf8File(workspace, requestedPath) {
  const resolved = resolveModelWorkspacePath(workspace, requestedPath);
  const stat = fs.statSync(resolved.path);
  if (!stat.isFile()) throw new Error(`${requestedPath} is not a file`);
  const raw = fs.readFileSync(resolved.path);
  const decoded = decodeUtf8(raw, requestedPath);
  return {
    ...resolved,
    raw,
    ...decoded,
    mode: stat.mode & 0o777,
    sha256: sha256(raw),
  };
}

function normalizeReplacementNewlines(text, newline) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", newline);
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function applyReplacements(content, replacements, requestedPath, newline) {
  let next = content;
  for (const replacement of replacements ?? []) {
    if (!replacement || typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") {
      throw new TypeError(`invalid replacement for ${requestedPath}`);
    }
    const oldText = normalizeReplacementNewlines(replacement.oldText, newline);
    const newText = normalizeReplacementNewlines(replacement.newText, newline);
    const matches = countOccurrences(next, oldText);
    if (matches !== 1) {
      throw new Error(`${requestedPath}: expected oldText to occur exactly once, found ${matches}`);
    }
    next = next.replace(oldText, newText);
  }
  return next;
}

function encodeUtf8(content, hasBom) {
  const body = Buffer.from(content, "utf8");
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported uniformly on all target filesystems.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function writeDurableTemp(target, raw, mode = 0o666) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(target)}.lpc-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(fd, raw);
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, mode); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

function copyDurable(source, destination, mode) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(destination, mode); } catch {}
  const fd = fs.openSync(destination, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function assertBaseline(change) {
  if (change.type === "add") {
    if (fs.existsSync(change.target)) throw new Error(`${change.path}: PATCH_CONFLICT target now exists`);
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(change.target);
  } catch {
    throw new Error(`${change.path}: PATCH_CONFLICT target no longer exists`);
  }
  if (sha256(raw) !== change.expectedSha256) {
    throw new Error(`${change.path}: PATCH_CONFLICT baseline changed before commit`);
  }
}

function restoreBackup(item) {
  if (item.type === "add") {
    fs.rmSync(item.target, { force: true });
    fsyncDirectory(path.dirname(item.target));
    return;
  }
  const backupRaw = fs.readFileSync(item.backup);
  const temp = writeDurableTemp(item.target, backupRaw, item.mode);
  try {
    fs.renameSync(temp, item.target);
    fsyncDirectory(path.dirname(item.target));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function applyStructuredPatch({ workspace, changes } = {}) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
    throw new TypeError("changes must contain between 1 and 100 entries");
  }

  const seen = new Set();
  const prepared = changes.map((change) => {
    if (!change || typeof change.path !== "string") throw new TypeError("each change needs a path");
    if (seen.has(change.path)) throw new Error(`duplicate patch path: ${change.path}`);
    seen.add(change.path);

    if (change.type === "add") {
      if (typeof change.content !== "string") throw new TypeError(`${change.path}: add requires content`);
      const resolved = resolveModelWorkspacePath(workspace, change.path, { allowMissing: true });
      if (fs.existsSync(resolved.path)) throw new Error(`${change.path}: file already exists`);
      const nextRaw = Buffer.from(change.content, "utf8");
      return { ...change, target: resolved.path, nextRaw, nextSha256: sha256(nextRaw), mode: 0o644 };
    }

    if (change.type === "update" || change.type === "delete") {
      const current = readUtf8File(workspace, change.path);
      if (typeof change.expectedSha256 !== "string" || current.sha256 !== change.expectedSha256) {
        throw new Error(`${change.path}: SHA-256 precondition failed`);
      }
      if (change.type === "delete") {
        return {
          ...change,
          target: current.path,
          expectedSha256: current.sha256,
          mode: current.mode,
        };
      }
      const nextContent = applyReplacements(current.content, change.replacements, change.path, current.newline);
      const nextRaw = encodeUtf8(nextContent, current.hasBom);
      return {
        ...change,
        target: current.path,
        expectedSha256: current.sha256,
        mode: current.mode,
        nextRaw,
        nextSha256: sha256(nextRaw),
      };
    }

    throw new Error(`${change.path}: unsupported patch type ${change.type}`);
  });

  const root = resolveWorkspace(workspace);
  const transaction = fs.mkdtempSync(path.join(createWorkspaceTemp(root), "patch-"));
  const applied = [];
  const temps = new Set();

  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const change = prepared[index];
      assertBaseline(change);

      if (change.type === "add") {
        const temp = writeDurableTemp(change.target, change.nextRaw, change.mode);
        temps.add(temp);
        assertBaseline(change);
        fs.linkSync(temp, change.target);
        applied.push({ type: "add", target: change.target, mode: change.mode });
        fs.rmSync(temp, { force: true });
        temps.delete(temp);
        fsyncDirectory(path.dirname(change.target));
        continue;
      }

      const backup = path.join(transaction, `${index}.backup`);
      copyDurable(change.target, backup, change.mode);

      if (change.type === "delete") {
        assertBaseline(change);
        fs.rmSync(change.target);
        fsyncDirectory(path.dirname(change.target));
        applied.push({ type: "delete", target: change.target, backup, mode: change.mode });
        continue;
      }

      const temp = writeDurableTemp(change.target, change.nextRaw, change.mode);
      temps.add(temp);
      assertBaseline(change);
      fs.renameSync(temp, change.target);
      temps.delete(temp);
      fsyncDirectory(path.dirname(change.target));
      applied.push({ type: "update", target: change.target, backup, mode: change.mode });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const temp of temps) {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    for (const item of [...applied].reverse()) {
      try {
        restoreBackup(item);
      } catch (rollbackError) {
        rollbackFailures.push({
          target: item.target,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }
    if (rollbackFailures.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      const failure = new Error(`PATCH_ROLLBACK_FAILED: ${original}; recovery failures: ${JSON.stringify(rollbackFailures)}`);
      failure.cause = error;
      throw failure;
    }
    throw error;
  } finally {
    fs.rmSync(transaction, { recursive: true, force: true });
  }

  return {
    applied: prepared.map((change) => ({
      path: change.path,
      type: change.type,
      sha256: change.type === "delete" ? null : change.nextSha256,
      mode: change.mode,
    })),
    durability: {
      sameDirectoryTempFiles: true,
      fileFsync: true,
      parentDirectoryFsyncBestEffort: true,
      atomicReplace: true,
      preservesExistingMode: true,
      preservesUtf8Bom: true,
      preservesNewlineStyle: true,
      baselineRecheckedBeforeCommit: true,
    },
  };
}

export function deleteWorkspaceFile({ workspace, path: requestedPath, expectedSha256 } = {}) {
  return applyStructuredPatch({
    workspace,
    changes: [{ type: "delete", path: requestedPath, expectedSha256 }],
  });
}

export function moveWorkspaceFile({ workspace, from, to, expectedSha256 } = {}) {
  const current = readUtf8File(workspace, from);
  if (current.sha256 !== expectedSha256) throw new Error(`${from}: SHA-256 precondition failed`);
  const destination = resolveModelWorkspacePath(workspace, to, { allowMissing: true });
  if (fs.existsSync(destination.path)) throw new Error(`${to}: destination already exists`);
  fs.mkdirSync(path.dirname(destination.path), { recursive: true });

  const beforeMove = fs.readFileSync(current.path);
  if (sha256(beforeMove) !== expectedSha256) throw new Error(`${from}: PATCH_CONFLICT baseline changed before move`);
  fs.linkSync(current.path, destination.path);
  try {
    fs.unlinkSync(current.path);
  } catch (error) {
    try { fs.rmSync(destination.path, { force: true }); } catch {}
    throw error;
  }
  fsyncDirectory(path.dirname(current.path));
  if (path.dirname(destination.path) !== path.dirname(current.path)) fsyncDirectory(path.dirname(destination.path));
  return { from, to, sha256: current.sha256, mode: current.mode, atomicDestinationCreate: true };
}
