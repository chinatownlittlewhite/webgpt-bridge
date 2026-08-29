import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGoalStoreV2 } from "./goal-store-v2.js";
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

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported uniformly across platforms/filesystems.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readLegacySessions(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      if (parsed?.version !== STORE_VERSION || !parsed.session || typeof parsed.session !== "object" || Array.isArray(parsed.session)) continue;
      safeSessionId(parsed.session.id);
      results.push(structuredClone(parsed.session));
    } catch {
      // Preserve v1 behavior: corrupt individual session files are ignored, never deleted.
    }
  }
  return results;
}

function createLegacyFileGoalSessionStore(directory) {
  function filename(sessionId) {
    return path.join(directory, `${safeSessionId(sessionId)}.json`);
  }

  function serialize(session) {
    return JSON.stringify({ version: STORE_VERSION, session }, null, 2) + "\n";
  }

  return Object.freeze({
    kind: "file",
    persistent: true,
    version: STORE_VERSION,
    directory,
    loadAll() {
      return readLegacySessions(directory);
    },
    save(session) {
      safeSessionId(session?.id);
      const target = filename(session.id);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temp, serialize(session), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, target);
        try { fs.chmodSync(target, 0o600); } catch {}
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },
    remove(sessionId) {
      fs.rmSync(filename(sessionId), { force: true });
    },
  });
}

function withGoalRoot(store, directory) {
  return Object.freeze({ ...store, directory });
}

function openPublishedV2(directory, stateDirectory) {
  const stat = fs.lstatSync(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("goal store v2 state path must be a plain directory");
  return withGoalRoot(createGoalStoreV2({ directory: stateDirectory }), directory);
}

function migrateToV2(directory, stateDirectory, legacySessions) {
  const tempDirectory = path.join(directory, `.state-v2-migrate-${randomUUID()}`);
  try {
    createGoalStoreV2({
      directory: tempDirectory,
      initialSessions: legacySessions,
      migratedFromV1: legacySessions.length,
    });
    const reopened = createGoalStoreV2({ directory: tempDirectory });
    const expectedIds = legacySessions.map((session) => session.id).sort();
    const actualIds = reopened.loadAll().map((session) => session.id).sort();
    if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
      throw new Error("goal store v2 migration validation did not preserve every legacy session");
    }
    fs.renameSync(tempDirectory, stateDirectory);
    syncDirectory(directory);
    return openPublishedV2(directory, stateDirectory);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
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
  const stateDirectory = path.join(directory, "state-v2");
  const legacySessions = readLegacySessions(directory);

  if (fs.existsSync(stateDirectory)) {
    try {
      return openPublishedV2(directory, stateDirectory);
    } catch (error) {
      if (legacySessions.length > 0) return createLegacyFileGoalSessionStore(directory);
      throw error;
    }
  }

  try {
    return migrateToV2(directory, stateDirectory, legacySessions);
  } catch (error) {
    if (legacySessions.length > 0) return createLegacyFileGoalSessionStore(directory);
    throw error;
  }
}
