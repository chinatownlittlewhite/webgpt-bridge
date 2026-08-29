import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 2;
const JOURNAL_VERSION = 1;
const DEFAULT_SNAPSHOT_EVERY = 32;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
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

function cloneSession(session) {
  safeSessionId(session?.id);
  return structuredClone(session);
}

function normalizeProtectedMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== "goal_tool") return null;
  if (typeof value.tool !== "string" || value.tool.length < 1 || value.tool.length > 128) return null;
  if (typeof value.inputHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.inputHash)) return null;
  if (!Number.isFinite(value.startedAt) || value.startedAt <= 0) return null;
  return Object.freeze({
    tool: value.tool,
    inputHash: value.inputHash.toLowerCase(),
    startedAt: value.startedAt,
  });
}

function checkedRecord(fields) {
  const body = {
    version: STORE_VERSION,
    journalVersion: JOURNAL_VERSION,
    ...fields,
  };
  return Object.freeze({ ...body, checksum: digest(body) });
}

function checkedSnapshot(sequence, sessions) {
  const body = {
    version: STORE_VERSION,
    sequence,
    sessions: sessions.map((session) => structuredClone(session)),
  };
  return Object.freeze({ ...body, checksum: digest(body) });
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

function durableWriteFile(target, contents, mode = 0o600) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, mode); } catch {}
    syncDirectory(path.dirname(target));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    fs.rmSync(temp, { force: true });
  }
}

function durableAppendLine(target, record) {
  const line = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(target, "a", 0o600);
  try {
    fs.writeSync(fd, line, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function durableTruncate(target) {
  const fd = fs.openSync(target, "w", 0o600);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(target));
}

function validateSnapshot(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("goal store v2 snapshot is invalid");
  const { checksum, ...body } = parsed;
  if (parsed.version !== STORE_VERSION) throw new Error("goal store v2 snapshot version is unsupported");
  if (!Number.isInteger(parsed.sequence) || parsed.sequence < 0) throw new Error("goal store v2 snapshot sequence is invalid");
  if (!Array.isArray(parsed.sessions)) throw new Error("goal store v2 snapshot sessions are invalid");
  if (typeof checksum !== "string" || checksum !== digest(body)) throw new Error("goal store v2 snapshot checksum mismatch");
  const sessions = new Map();
  for (const session of parsed.sessions) {
    const cloned = cloneSession(session);
    if (sessions.has(cloned.id)) throw new Error("goal store v2 snapshot contains duplicate session ids");
    sessions.set(cloned.id, cloned);
  }
  return { sequence: parsed.sequence, sessions };
}

function validateRecord(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("goal store v2 journal record is invalid");
  const { checksum, ...body } = parsed;
  if (parsed.version !== STORE_VERSION || parsed.journalVersion !== JOURNAL_VERSION) {
    throw new Error("goal store v2 journal version is unsupported");
  }
  if (!Number.isInteger(parsed.sequence) || parsed.sequence < 1) throw new Error("goal store v2 journal sequence is invalid");
  if (typeof parsed.mutationId !== "string" || parsed.mutationId.length < 1 || parsed.mutationId.length > 128) {
    throw new Error("goal store v2 journal mutation id is invalid");
  }
  safeSessionId(parsed.sessionId);
  if (typeof parsed.operation !== "string" || parsed.operation.length < 1 || parsed.operation.length > 128) {
    throw new Error("goal store v2 journal operation is invalid");
  }
  if (typeof parsed.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.inputHash)) {
    throw new Error("goal store v2 journal input hash is invalid");
  }
  if (typeof parsed.stateClass !== "string" || parsed.stateClass.length < 1 || parsed.stateClass.length > 128) {
    throw new Error("goal store v2 journal state class is invalid");
  }
  if (!Number.isFinite(parsed.timestamp) || parsed.timestamp <= 0) throw new Error("goal store v2 journal timestamp is invalid");
  if (typeof parsed.protectedEffect !== "boolean") throw new Error("goal store v2 journal protected-effect flag is invalid");
  if (typeof checksum !== "string" || checksum !== digest(body)) throw new Error("goal store v2 journal checksum mismatch");
  return parsed;
}

function sameMutation(left, right) {
  return left.sessionId === right.sessionId && left.operation === right.operation && left.inputHash === right.inputHash;
}

function replayJournal({ journalPath, snapshotSequence, sessions }) {
  const pendingById = new Map();
  const pendingProtectedBySession = new Map();
  let sequence = snapshotSequence;
  let committedSinceSnapshot = 0;
  const text = fs.readFileSync(journalPath, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    let record;
    try {
      record = validateRecord(JSON.parse(line));
    } catch (error) {
      throw new Error(`goal store v2 journal integrity failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (record.sequence <= snapshotSequence) continue;
    if (record.sequence !== sequence + 1) throw new Error("goal store v2 journal sequence is discontinuous");
    sequence = record.sequence;
    if (record.stateClass === "intent") {
      if (pendingById.has(record.mutationId)) throw new Error("goal store v2 journal contains duplicate mutation intent");
      pendingById.set(record.mutationId, record);
      if (record.protectedEffect) {
        if (pendingProtectedBySession.has(record.sessionId)) throw new Error("goal store v2 journal contains overlapping protected mutations");
        const session = cloneSession(record.session);
        if (!normalizeProtectedMarker(session.inFlightMutation)) throw new Error("goal store v2 protected intent is missing a valid in-flight mutation");
        pendingProtectedBySession.set(record.sessionId, record.mutationId);
        sessions.set(record.sessionId, session);
      }
      continue;
    }

    const intent = pendingById.get(record.mutationId);
    if (!intent) throw new Error("goal store v2 journal commit has no matching intent");
    if (!sameMutation(intent, record) || intent.protectedEffect !== record.protectedEffect) {
      throw new Error("goal store v2 journal commit does not match its intent");
    }
    if (record.stateClass === "removed") {
      sessions.delete(record.sessionId);
    } else {
      const session = cloneSession(record.session);
      if (session.id !== record.sessionId) throw new Error("goal store v2 journal session id does not match its record");
      sessions.set(record.sessionId, session);
    }
    pendingById.delete(record.mutationId);
    if (record.protectedEffect) pendingProtectedBySession.delete(record.sessionId);
    committedSinceSnapshot += 1;
  }
  return { sequence, pendingById, pendingProtectedBySession, committedSinceSnapshot };
}

function initializeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("goal store v2 directory must be a plain directory");
  try { fs.chmodSync(directory, 0o700); } catch {}

  const metadataPath = path.join(directory, "metadata.json");
  const snapshotPath = path.join(directory, "snapshot.json");
  const journalPath = path.join(directory, "journal.log");
  const exists = [metadataPath, snapshotPath, journalPath].map((target) => fs.existsSync(target));
  if (exists.every((value) => !value)) {
    durableWriteFile(metadataPath, `${JSON.stringify({
      version: STORE_VERSION,
      schemaVersion: STORE_VERSION,
      migrationComplete: true,
      createdAt: Date.now(),
      migratedFromV1: 0,
    }, null, 2)}\n`);
    durableWriteFile(snapshotPath, `${JSON.stringify(checkedSnapshot(0, []), null, 2)}\n`);
    durableWriteFile(journalPath, "");
  } else if (!exists.every(Boolean)) {
    throw new Error("goal store v2 directory is incomplete");
  }
  return { metadataPath, snapshotPath, journalPath };
}

function readMetadata(metadataPath) {
  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== STORE_VERSION ||
    parsed.schemaVersion !== STORE_VERSION ||
    parsed.migrationComplete !== true
  ) {
    throw new Error("goal store v2 metadata is invalid or migration is incomplete");
  }
  return parsed;
}

export function createGoalStoreV2({ directory, snapshotEvery = DEFAULT_SNAPSHOT_EVERY } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("goal store v2 directory must be an absolute path");
  if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1 || snapshotEvery > 10_000) {
    throw new RangeError("goal store v2 snapshotEvery must be between 1 and 10000");
  }

  const { metadataPath, snapshotPath, journalPath } = initializeDirectory(directory);
  readMetadata(metadataPath);
  const snapshot = validateSnapshot(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
  const sessions = snapshot.sessions;
  let {
    sequence,
    pendingById,
    pendingProtectedBySession,
    committedSinceSnapshot,
  } = replayJournal({ journalPath, snapshotSequence: snapshot.sequence, sessions });

  function append(fields) {
    const record = checkedRecord({ sequence: sequence + 1, ...fields });
    durableAppendLine(journalPath, record);
    sequence = record.sequence;
    return record;
  }

  function publishSnapshotIfNeeded() {
    if (committedSinceSnapshot < snapshotEvery || pendingProtectedBySession.size > 0) return;
    const ordered = [...sessions.values()]
      .map((session) => structuredClone(session))
      .sort((left, right) => left.id.localeCompare(right.id));
    durableWriteFile(snapshotPath, `${JSON.stringify(checkedSnapshot(sequence, ordered), null, 2)}\n`);
    durableTruncate(journalPath);
    pendingById = new Map();
    pendingProtectedBySession = new Map();
    committedSinceSnapshot = 0;
  }

  function save(session) {
    const cloned = cloneSession(session);
    const marker = normalizeProtectedMarker(cloned.inFlightMutation);
    const existingProtectedMutationId = pendingProtectedBySession.get(cloned.id);

    if (marker) {
      if (existingProtectedMutationId) throw new Error("goal store v2 already has a pending protected mutation for this session");
      const mutationId = randomUUID();
      const intent = append({
        mutationId,
        sessionId: cloned.id,
        operation: marker.tool,
        inputHash: marker.inputHash,
        stateClass: "intent",
        timestamp: Date.now(),
        protectedEffect: true,
        session: cloned,
      });
      pendingById.set(mutationId, intent);
      pendingProtectedBySession.set(cloned.id, mutationId);
      sessions.set(cloned.id, cloned);
      return;
    }

    if (existingProtectedMutationId) {
      const intent = pendingById.get(existingProtectedMutationId);
      if (!intent) throw new Error("goal store v2 protected mutation state is inconsistent");
      append({
        mutationId: intent.mutationId,
        sessionId: intent.sessionId,
        operation: intent.operation,
        inputHash: intent.inputHash,
        stateClass: typeof cloned.status === "string" && cloned.status ? cloned.status : "stored",
        timestamp: Date.now(),
        protectedEffect: true,
        session: cloned,
      });
      pendingById.delete(intent.mutationId);
      pendingProtectedBySession.delete(cloned.id);
      sessions.set(cloned.id, cloned);
      committedSinceSnapshot += 1;
      publishSnapshotIfNeeded();
      return;
    }

    const mutationId = randomUUID();
    const inputHash = digest(cloned);
    const intent = append({
      mutationId,
      sessionId: cloned.id,
      operation: "save",
      inputHash,
      stateClass: "intent",
      timestamp: Date.now(),
      protectedEffect: false,
    });
    pendingById.set(mutationId, intent);
    append({
      mutationId,
      sessionId: cloned.id,
      operation: "save",
      inputHash,
      stateClass: typeof cloned.status === "string" && cloned.status ? cloned.status : "stored",
      timestamp: Date.now(),
      protectedEffect: false,
      session: cloned,
    });
    pendingById.delete(mutationId);
    sessions.set(cloned.id, cloned);
    committedSinceSnapshot += 1;
    publishSnapshotIfNeeded();
  }

  function remove(sessionId) {
    const id = safeSessionId(sessionId);
    if (pendingProtectedBySession.has(id)) throw new Error("goal store v2 cannot remove a session with a pending protected mutation");
    const mutationId = randomUUID();
    const inputHash = digest({ sessionId: id, operation: "remove" });
    const intent = append({
      mutationId,
      sessionId: id,
      operation: "remove",
      inputHash,
      stateClass: "intent",
      timestamp: Date.now(),
      protectedEffect: false,
    });
    pendingById.set(mutationId, intent);
    append({
      mutationId,
      sessionId: id,
      operation: "remove",
      inputHash,
      stateClass: "removed",
      timestamp: Date.now(),
      protectedEffect: false,
    });
    pendingById.delete(mutationId);
    sessions.delete(id);
    committedSinceSnapshot += 1;
    publishSnapshotIfNeeded();
  }

  return Object.freeze({
    kind: "file",
    persistent: true,
    version: STORE_VERSION,
    stateDirectory: directory,
    metadataPath,
    snapshotPath,
    journalPath,
    loadAll() {
      return [...sessions.values()]
        .map((session) => structuredClone(session))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    save,
    remove,
  });
}
