import fs from "node:fs";
import path from "node:path";
import { INTERNAL_STATE_DIR, resolveWorkspace, resolveWorkspacePath } from "./workspace.js";

const STORE_VERSION = 1;

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length < 1 ||
    sessionId.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(sessionId)
  ) {
    throw new TypeError("goal session id contains unsupported characters");
  }
  return sessionId;
}

function createAndResolveDirectory(root, directoryName) {
  const { path: candidate } = resolveWorkspacePath(root, directoryName, { allowMissing: true });
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(candidate);
  if (!isInside(root, directory)) {
    throw new Error("goal store directory resolves through a symlink outside the configured workspace");
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms/filesystems that do not expose POSIX modes.
  }
  return directory;
}

export function createMemoryGoalSessionStore() {
  const values = new Map();
  return Object.freeze({
    kind: "memory",
    persistent: false,
    loadAll() {
      return [...values.values()].map((value) => structuredClone(value));
    },
    save(session) {
      safeSessionId(session?.id);
      values.set(session.id, structuredClone(session));
    },
    remove(sessionId) {
      values.delete(safeSessionId(sessionId));
    },
  });
}

export function createFileGoalSessionStore({ workspace, directoryName = `${INTERNAL_STATE_DIR}/goals` } = {}) {
  const root = resolveWorkspace(workspace);
  if (typeof directoryName !== "string" || directoryName.length === 0 || path.isAbsolute(directoryName)) {
    throw new TypeError("goal store directoryName must be a non-empty relative path");
  }
  const directory = createAndResolveDirectory(root, directoryName);

  function filename(sessionId) {
    return path.join(directory, `${safeSessionId(sessionId)}.json`);
  }

  function serialize(session) {
    return JSON.stringify({ version: STORE_VERSION, session }, null, 2) + "\n";
  }

  return Object.freeze({
    kind: "file",
    persistent: true,
    directory,
    loadAll() {
      const results = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const fullPath = path.join(directory, entry.name);
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          if (parsed?.version !== STORE_VERSION || !parsed.session || typeof parsed.session !== "object") {
            continue;
          }
          results.push(parsed.session);
        } catch {
          // Corrupt or partially written state fails closed by being ignored.
        }
      }
      return results;
    },
    save(session) {
      safeSessionId(session?.id);
      const target = filename(session.id);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temp, serialize(session), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, target);
        try {
          fs.chmodSync(target, 0o600);
        } catch {
          // Best effort on platforms/filesystems that do not expose POSIX modes.
        }
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },
    remove(sessionId) {
      fs.rmSync(filename(sessionId), { force: true });
    },
  });
}
