const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TRANSACTION_VERSION = 1;
const REGISTRY_VERSION = 1;
const MAX_TRANSACTIONS = 100;
const MAX_CHANGES = 20;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const TXN_NAME = /^\.webgpt-bridge-txn-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const STATES = new Set(["prepared", "applying", "committed", "rolling_back"]);
const CHANGE_TYPES = new Set(["create", "update", "delete", "move"]);

class InjectedCrashError extends Error {
  constructor() {
    super("simulated transaction crash");
    this.code = "LOCAL_TRANSACTION_SIMULATED_CRASH";
  }
}

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function checked(value) {
  return { ...value, checksum: checksum(value) };
}

function syncDirectory(directory, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(directory, "r");
    fsImpl.fsyncSync(fd);
  } catch {
    // Directory fsync is not uniformly supported on every target filesystem.
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function plainDirectory(target, label, fsImpl) {
  const stat = fsImpl.lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`);
  }
  return stat;
}

function plainFile(target, label, fsImpl) {
  const stat = fsImpl.lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain file`);
  }
  return stat;
}

function ensureAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function ensureBatchId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw new TypeError("local file transaction batchId must be a bounded string");
  }
  return value;
}

function durableWriteFile(target, contents, fsImpl, mode = 0o600) {
  const parent = path.dirname(target);
  const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fsImpl.openSync(temp, "wx", mode);
    fsImpl.writeFileSync(fd, contents);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temp, target);
    try { fsImpl.chmodSync(target, mode); } catch {}
    syncDirectory(parent, fsImpl);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    try { fsImpl.rmSync(temp, { force: true }); } catch {}
  }
}

function durableWriteJson(target, value, fsImpl) {
  durableWriteFile(target, `${JSON.stringify(checked(value), null, 2)}\n`, fsImpl, 0o600);
}

function parseCheckedJson(target, label, fsImpl) {
  plainFile(target, label, fsImpl);
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  const { checksum: storedChecksum, ...body } = parsed;
  if (typeof storedChecksum !== "string" || storedChecksum !== checksum(body)) {
    throw new Error(`${label} checksum mismatch`);
  }
  return body;
}

function registryBody(transactions = []) {
  return { version: REGISTRY_VERSION, transactions };
}

function validateRegistryEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("transaction registry entry must be an object");
  if (typeof entry.id !== "string" || !UUID.test(entry.id)) throw new Error("transaction registry id is invalid");
  ensureAbsolutePath(entry.directory, "transaction registry directory");
  const match = TXN_NAME.exec(path.basename(entry.directory));
  if (!match || match[1].toLowerCase() !== entry.id.toLowerCase()) {
    throw new Error("transaction registry directory does not match its id");
  }
  return { id: entry.id.toLowerCase(), directory: entry.directory };
}

function readRegistry(registryPath, fsImpl) {
  if (!fsImpl.existsSync(registryPath)) return registryBody();
  let body;
  try {
    body = parseCheckedJson(registryPath, "local file transaction registry", fsImpl);
  } catch (error) {
    throw codedError("LOCAL_TRANSACTION_REGISTRY_INVALID", `Local file transaction registry is invalid: ${error.message}`, error);
  }
  if (body.version !== REGISTRY_VERSION || !Array.isArray(body.transactions) || body.transactions.length > MAX_TRANSACTIONS) {
    throw codedError("LOCAL_TRANSACTION_REGISTRY_INVALID", "Local file transaction registry has an unsupported shape");
  }
  const ids = new Set();
  const directories = new Set();
  const transactions = [];
  try {
    for (const raw of body.transactions) {
      const entry = validateRegistryEntry(raw);
      if (ids.has(entry.id) || directories.has(entry.directory)) throw new Error("transaction registry contains duplicates");
      ids.add(entry.id);
      directories.add(entry.directory);
      transactions.push(entry);
    }
  } catch (error) {
    throw codedError("LOCAL_TRANSACTION_REGISTRY_INVALID", `Local file transaction registry is invalid: ${error.message}`, error);
  }
  return registryBody(transactions);
}

function writeRegistry(registryPath, transactions, fsImpl) {
  const parent = path.dirname(registryPath);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  plainDirectory(parent, "local file transaction registry parent", fsImpl);
  durableWriteJson(registryPath, registryBody(transactions), fsImpl);
}

function registerTransaction(registryPath, entry, fsImpl) {
  const registry = readRegistry(registryPath, fsImpl);
  if (registry.transactions.length >= MAX_TRANSACTIONS) {
    throw codedError("LOCAL_TRANSACTION_REGISTRY_INVALID", `Local file transaction registry exceeds ${MAX_TRANSACTIONS} entries`);
  }
  if (registry.transactions.some((item) => item.id === entry.id || item.directory === entry.directory)) {
    throw codedError("LOCAL_TRANSACTION_REGISTRY_INVALID", "Local file transaction registry already contains this transaction");
  }
  writeRegistry(registryPath, [...registry.transactions, entry], fsImpl);
}

function unregisterTransaction(registryPath, id, fsImpl) {
  const registry = readRegistry(registryPath, fsImpl);
  writeRegistry(registryPath, registry.transactions.filter((entry) => entry.id !== id), fsImpl);
}

function fileState(target, fsImpl) {
  const stat = fsImpl.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { exists: false, hash: null };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction encountered a non-plain file at ${target}`);
  }
  return { exists: true, hash: sha256(fsImpl.readFileSync(target)) };
}

function assertHash(target, expected, fsImpl) {
  const state = fileState(target, fsImpl);
  if (!state.exists || state.hash !== expected) throw new Error(`SHA-256 precondition failed for ${target}`);
}

function assertNewTarget(target, fsImpl) {
  if (fsImpl.existsSync(target)) throw new Error(`transaction target already exists: ${target}`);
  plainDirectory(path.dirname(target), "transaction target parent", fsImpl);
}

function normalizeChanges(changes, fsImpl) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) {
    throw new RangeError(`local file transaction must contain 1 to ${MAX_CHANGES} changes`);
  }
  const touched = new Set();
  return changes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !CHANGE_TYPES.has(raw.type)) {
      throw new TypeError("local file transaction contains an unsupported change");
    }
    const target = ensureAbsolutePath(raw.path, `change ${index} path`);
    const operation = { index, type: raw.type, path: target };
    if (raw.type === "create" || raw.type === "update") {
      if (typeof raw.content !== "string" || Buffer.byteLength(raw.content) > MAX_CONTENT_BYTES) {
        throw new TypeError("transaction create/update content must be bounded text");
      }
      operation.content = raw.content;
      operation.newSha256 = sha256(Buffer.from(raw.content));
    }
    if (raw.type === "update" || raw.type === "delete" || raw.type === "move") {
      if (typeof raw.expectedSha256 !== "string" || !SHA256.test(raw.expectedSha256)) {
        throw new TypeError("transaction existing-file changes require a SHA-256 precondition");
      }
      operation.expectedSha256 = raw.expectedSha256.toLowerCase();
    }
    if (raw.type === "move") operation.from = ensureAbsolutePath(raw.from, `change ${index} from`);

    if (raw.type === "create") assertNewTarget(target, fsImpl);
    else if (raw.type === "update" || raw.type === "delete") assertHash(target, operation.expectedSha256, fsImpl);
    else {
      assertHash(operation.from, operation.expectedSha256, fsImpl);
      assertNewTarget(target, fsImpl);
    }

    for (const candidate of raw.type === "move" ? [operation.from, target] : [target]) {
      if (touched.has(candidate)) throw new Error("local file transaction cannot touch the same path twice");
      touched.add(candidate);
    }
    return operation;
  });
}

function relevantParents(operations) {
  const parents = new Set();
  for (const operation of operations) {
    parents.add(path.dirname(operation.path));
    if (operation.type === "move") parents.add(path.dirname(operation.from));
  }
  return [...parents];
}

function assertSameDevice(operations, fsImpl) {
  const anchorParent = path.dirname(operations[0].type === "move" ? operations[0].from : operations[0].path);
  plainDirectory(anchorParent, "transaction anchor parent", fsImpl);
  const anchorDevice = fsImpl.statSync(anchorParent).dev;
  for (const parent of relevantParents(operations)) {
    plainDirectory(parent, "transaction participant parent", fsImpl);
    if (fsImpl.statSync(parent).dev !== anchorDevice) {
      throw codedError("LOCAL_TRANSACTION_CROSS_DEVICE", "Local file batch spans multiple filesystems; atomic rename recovery is unavailable");
    }
  }
  return { anchorParent, device: anchorDevice };
}

function manifestOperation(operation) {
  return {
    index: operation.index,
    type: operation.type,
    path: operation.path,
    ...(operation.from ? { from: operation.from } : {}),
    ...(operation.expectedSha256 ? { expectedSha256: operation.expectedSha256 } : {}),
    ...(operation.newSha256 ? { newSha256: operation.newSha256 } : {}),
  };
}

function transactionPaths(directory) {
  return {
    directory,
    manifestPath: path.join(directory, "transaction.json"),
    newDirectory: path.join(directory, "new"),
    backupDirectory: path.join(directory, "backup"),
  };
}

function stagedPath(paths, index) {
  return path.join(paths.newDirectory, String(index));
}

function backupPath(paths, index) {
  return path.join(paths.backupDirectory, String(index));
}

function writeManifest(paths, manifest, fsImpl) {
  durableWriteJson(paths.manifestPath, manifest, fsImpl);
}

function validateManifest(entry, paths, fsImpl) {
  plainDirectory(paths.directory, "local file transaction directory", fsImpl);
  plainDirectory(paths.newDirectory, "local file transaction new directory", fsImpl);
  plainDirectory(paths.backupDirectory, "local file transaction backup directory", fsImpl);
  let manifest;
  try {
    manifest = parseCheckedJson(paths.manifestPath, "local file transaction manifest", fsImpl);
  } catch (error) {
    throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction manifest is invalid: ${error.message}`, error);
  }
  try {
    if (manifest.version !== TRANSACTION_VERSION) throw new Error("unsupported transaction version");
    if (typeof manifest.id !== "string" || manifest.id.toLowerCase() !== entry.id) throw new Error("transaction id mismatch");
    if (typeof manifest.batchId !== "string" || manifest.batchId.length < 1 || manifest.batchId.length > 128) throw new Error("invalid batch id");
    if (!STATES.has(manifest.state)) throw new Error("invalid transaction state");
    if (!Number.isFinite(manifest.createdAt) || manifest.createdAt <= 0) throw new Error("invalid creation timestamp");
    ensureAbsolutePath(manifest.anchorParent, "transaction anchor parent");
    if (manifest.anchorParent !== path.dirname(paths.directory)) throw new Error("transaction anchor does not match directory location");
    if (!Number.isSafeInteger(manifest.device) || manifest.device < 0) throw new Error("invalid transaction device");
    if (!Array.isArray(manifest.operations) || manifest.operations.length < 1 || manifest.operations.length > MAX_CHANGES) throw new Error("invalid transaction operations");
    const touched = new Set();
    for (let index = 0; index < manifest.operations.length; index += 1) {
      const operation = manifest.operations[index];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("invalid transaction operation");
      if (operation.index !== index || !CHANGE_TYPES.has(operation.type)) throw new Error("invalid transaction operation order");
      ensureAbsolutePath(operation.path, `transaction operation ${index} path`);
      if ((operation.type === "create" || operation.type === "update") && !SHA256.test(operation.newSha256 ?? "")) throw new Error("invalid new-content hash");
      if ((operation.type === "update" || operation.type === "delete" || operation.type === "move") && !SHA256.test(operation.expectedSha256 ?? "")) throw new Error("invalid expected hash");
      if (operation.type === "move") ensureAbsolutePath(operation.from, `transaction operation ${index} from`);
      for (const candidate of operation.type === "move" ? [operation.from, operation.path] : [operation.path]) {
        if (touched.has(candidate)) throw new Error("transaction manifest touches a path more than once");
        touched.add(candidate);
      }
    }
    const parents = relevantParents(manifest.operations);
    plainDirectory(manifest.anchorParent, "transaction anchor parent", fsImpl);
    if (fsImpl.statSync(manifest.anchorParent).dev !== manifest.device) throw new Error("transaction filesystem identity changed");
    for (const parent of parents) {
      plainDirectory(parent, "transaction participant parent", fsImpl);
      if (fsImpl.statSync(parent).dev !== manifest.device) throw new Error("transaction participant moved to another filesystem");
    }
  } catch (error) {
    throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction manifest is unsafe: ${error.message}`, error);
  }
  return manifest;
}

function verifyFinal(manifest, paths, fsImpl) {
  for (const operation of manifest.operations) {
    const target = fileState(operation.path, fsImpl);
    if (operation.type === "create" || operation.type === "update") {
      if (!target.exists || target.hash !== operation.newSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Transaction final state is not verifiable for ${operation.path}`);
    } else if (operation.type === "delete") {
      if (target.exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Transaction delete final state is not verifiable for ${operation.path}`);
    } else {
      const source = fileState(operation.from, fsImpl);
      if (source.exists || !target.exists || target.hash !== operation.expectedSha256) {
        throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Transaction move final state is not verifiable for ${operation.path}`);
      }
    }
  }
  syncDirectory(paths.directory, fsImpl);
}

function assertStagedIdentity(operation, paths, fsImpl) {
  if (operation.type !== "create" && operation.type !== "update") return { exists: false, hash: null };
  const state = fileState(stagedPath(paths, operation.index), fsImpl);
  if (state.exists && state.hash !== operation.newSha256) {
    throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Transaction staged file identity is ambiguous for operation ${operation.index}`);
  }
  return state;
}

function rollbackCreate(operation, paths, fsImpl) {
  const target = fileState(operation.path, fsImpl);
  const staged = assertStagedIdentity(operation, paths, fsImpl);
  if (target.exists) {
    if (target.hash !== operation.newSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Create rollback is ambiguous for ${operation.path}`);
    fsImpl.rmSync(operation.path, { force: true });
    syncDirectory(path.dirname(operation.path), fsImpl);
    return;
  }
  if (!staged.exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Create rollback cannot determine whether ${operation.path} was externally removed`);
}

function rollbackUpdate(operation, paths, fsImpl) {
  const target = fileState(operation.path, fsImpl);
  const backup = fileState(backupPath(paths, operation.index), fsImpl);
  assertStagedIdentity(operation, paths, fsImpl);
  if (backup.exists) {
    if (backup.hash !== operation.expectedSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Update backup identity is invalid for ${operation.path}`);
    if (target.exists) {
      if (target.hash !== operation.newSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Update rollback is ambiguous for ${operation.path}`);
      fsImpl.rmSync(operation.path, { force: true });
    }
    fsImpl.renameSync(backupPath(paths, operation.index), operation.path);
    syncDirectory(path.dirname(operation.path), fsImpl);
    syncDirectory(paths.backupDirectory, fsImpl);
    return;
  }
  if (!target.exists || target.hash !== operation.expectedSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Update rollback cannot prove pre-state for ${operation.path}`);
}

function rollbackDelete(operation, paths, fsImpl) {
  const target = fileState(operation.path, fsImpl);
  const backup = fileState(backupPath(paths, operation.index), fsImpl);
  if (backup.exists) {
    if (backup.hash !== operation.expectedSha256 || target.exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Delete rollback is ambiguous for ${operation.path}`);
    fsImpl.renameSync(backupPath(paths, operation.index), operation.path);
    syncDirectory(path.dirname(operation.path), fsImpl);
    syncDirectory(paths.backupDirectory, fsImpl);
    return;
  }
  if (!target.exists || target.hash !== operation.expectedSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Delete rollback cannot prove pre-state for ${operation.path}`);
}

function rollbackMove(operation, paths, fsImpl) {
  const source = fileState(operation.from, fsImpl);
  const target = fileState(operation.path, fsImpl);
  const backup = fileState(backupPath(paths, operation.index), fsImpl);
  if (backup.exists) {
    if (backup.hash !== operation.expectedSha256 || source.exists || target.exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Move rollback is ambiguous for ${operation.from}`);
    fsImpl.renameSync(backupPath(paths, operation.index), operation.from);
    syncDirectory(path.dirname(operation.from), fsImpl);
    syncDirectory(paths.backupDirectory, fsImpl);
    return;
  }
  if (source.exists && source.hash === operation.expectedSha256 && !target.exists) return;
  if (!source.exists && target.exists && target.hash === operation.expectedSha256) {
    fsImpl.renameSync(operation.path, operation.from);
    syncDirectory(path.dirname(operation.path), fsImpl);
    syncDirectory(path.dirname(operation.from), fsImpl);
    return;
  }
  throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Move rollback cannot prove pre-state for ${operation.from}`);
}

function verifyPreState(manifest, fsImpl) {
  for (const operation of manifest.operations) {
    if (operation.type === "create") {
      if (fileState(operation.path, fsImpl).exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Create pre-state is not restored for ${operation.path}`);
    } else if (operation.type === "update" || operation.type === "delete") {
      const target = fileState(operation.path, fsImpl);
      if (!target.exists || target.hash !== operation.expectedSha256) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Pre-state is not restored for ${operation.path}`);
    } else {
      const source = fileState(operation.from, fsImpl);
      const target = fileState(operation.path, fsImpl);
      if (!source.exists || source.hash !== operation.expectedSha256 || target.exists) throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Move pre-state is not restored for ${operation.from}`);
    }
  }
}

function rollbackManifest(manifest, paths, fsImpl) {
  for (const operation of [...manifest.operations].reverse()) {
    if (operation.type === "create") rollbackCreate(operation, paths, fsImpl);
    else if (operation.type === "update") rollbackUpdate(operation, paths, fsImpl);
    else if (operation.type === "delete") rollbackDelete(operation, paths, fsImpl);
    else rollbackMove(operation, paths, fsImpl);
  }
  verifyPreState(manifest, fsImpl);
}

function cleanupDirectory(directory, fsImpl) {
  try { fsImpl.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function createLocalFileTransactionManager({ registryPath, fsImpl = fs, randomId = crypto.randomUUID, now = Date.now, faultInjector } = {}) {
  ensureAbsolutePath(registryPath, "local file transaction registryPath");
  if (typeof randomId !== "function" || typeof now !== "function") throw new TypeError("local file transaction manager requires function providers");
  if (faultInjector !== undefined && typeof faultInjector !== "function") throw new TypeError("faultInjector must be a function when supplied");

  function maybeCrash(phase, transactionId, index, step) {
    if (!faultInjector) return;
    if (faultInjector({ phase, transactionId, index, step }) === "crash") throw new InjectedCrashError();
  }

  function recoverEntry(entry) {
    const paths = transactionPaths(entry.directory);
    const manifest = validateManifest(entry, paths, fsImpl);
    try {
      if (manifest.state === "prepared") {
        unregisterTransaction(registryPath, entry.id, fsImpl);
        cleanupDirectory(entry.directory, fsImpl);
        return;
      }
      if (manifest.state === "committed") {
        verifyFinal(manifest, paths, fsImpl);
        unregisterTransaction(registryPath, entry.id, fsImpl);
        cleanupDirectory(entry.directory, fsImpl);
        return;
      }
      const rolling = manifest.state === "rolling_back" ? manifest : { ...manifest, state: "rolling_back" };
      if (manifest.state !== "rolling_back") writeManifest(paths, rolling, fsImpl);
      rollbackManifest(rolling, paths, fsImpl);
      unregisterTransaction(registryPath, entry.id, fsImpl);
      cleanupDirectory(entry.directory, fsImpl);
    } catch (error) {
      if (error?.code === "LOCAL_TRANSACTION_RECOVERY_REQUIRED") throw error;
      throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction recovery failed for ${entry.id}: ${error.message}`, error);
    }
  }

  function recoverPendingTransactions() {
    const registry = readRegistry(registryPath, fsImpl);
    for (const entry of [...registry.transactions].sort((left, right) => left.id.localeCompare(right.id))) recoverEntry(entry);
    return { recovered: registry.transactions.length };
  }

  function commit({ batchId, changes } = {}) {
    ensureBatchId(batchId);
    const normalized = normalizeChanges(changes, fsImpl);
    const { anchorParent, device } = assertSameDevice(normalized, fsImpl);
    const id = String(randomId()).toLowerCase();
    if (!UUID.test(id)) throw new TypeError("local file transaction random id must be a UUID");
    const directory = path.join(anchorParent, `.webgpt-bridge-txn-${id}`);
    const paths = transactionPaths(directory);
    if (fsImpl.existsSync(directory)) throw new Error("local file transaction directory already exists");

    let registered = false;
    let manifest = null;
    try {
      fsImpl.mkdirSync(directory, { mode: 0o700 });
      fsImpl.mkdirSync(paths.newDirectory, { mode: 0o700 });
      fsImpl.mkdirSync(paths.backupDirectory, { mode: 0o700 });
      plainDirectory(directory, "local file transaction directory", fsImpl);
      plainDirectory(paths.newDirectory, "local file transaction new directory", fsImpl);
      plainDirectory(paths.backupDirectory, "local file transaction backup directory", fsImpl);

      for (const operation of normalized) {
        if (operation.type !== "create" && operation.type !== "update") continue;
        durableWriteFile(stagedPath(paths, operation.index), Buffer.from(operation.content), fsImpl, 0o600);
      }

      manifest = {
        version: TRANSACTION_VERSION,
        id,
        batchId,
        state: "prepared",
        createdAt: Number(now()),
        anchorParent,
        device,
        operations: normalized.map(manifestOperation),
      };
      writeManifest(paths, manifest, fsImpl);
      registerTransaction(registryPath, { id, directory }, fsImpl);
      registered = true;
      maybeCrash("prepared", id);

      manifest = { ...manifest, state: "applying" };
      writeManifest(paths, manifest, fsImpl);
      maybeCrash("applying", id);

      for (const operation of manifest.operations) {
        const backup = backupPath(paths, operation.index);
        const staged = stagedPath(paths, operation.index);
        if (operation.type === "create") {
          fsImpl.renameSync(staged, operation.path);
          syncDirectory(paths.newDirectory, fsImpl);
          syncDirectory(path.dirname(operation.path), fsImpl);
          maybeCrash("after-rename", id, operation.index, "create-target");
        } else if (operation.type === "update") {
          fsImpl.renameSync(operation.path, backup);
          syncDirectory(path.dirname(operation.path), fsImpl);
          syncDirectory(paths.backupDirectory, fsImpl);
          maybeCrash("after-rename", id, operation.index, "update-backup");
          fsImpl.renameSync(staged, operation.path);
          syncDirectory(paths.newDirectory, fsImpl);
          syncDirectory(path.dirname(operation.path), fsImpl);
          maybeCrash("after-rename", id, operation.index, "update-target");
        } else if (operation.type === "delete") {
          fsImpl.renameSync(operation.path, backup);
          syncDirectory(path.dirname(operation.path), fsImpl);
          syncDirectory(paths.backupDirectory, fsImpl);
          maybeCrash("after-rename", id, operation.index, "delete-backup");
        } else {
          fsImpl.renameSync(operation.from, backup);
          syncDirectory(path.dirname(operation.from), fsImpl);
          syncDirectory(paths.backupDirectory, fsImpl);
          maybeCrash("after-rename", id, operation.index, "move-backup");
          fsImpl.renameSync(backup, operation.path);
          syncDirectory(paths.backupDirectory, fsImpl);
          syncDirectory(path.dirname(operation.path), fsImpl);
          maybeCrash("after-rename", id, operation.index, "move-target");
        }
      }

      verifyFinal(manifest, paths, fsImpl);
      manifest = { ...manifest, state: "committed" };
      writeManifest(paths, manifest, fsImpl);
      maybeCrash("committed", id);
      unregisterTransaction(registryPath, id, fsImpl);
      registered = false;
      cleanupDirectory(directory, fsImpl);
      return { transactionId: id };
    } catch (error) {
      if (error instanceof InjectedCrashError) throw error;
      if (!registered) {
        cleanupDirectory(directory, fsImpl);
        throw error;
      }
      try {
        const diskManifest = validateManifest({ id, directory }, paths, fsImpl);
        if (diskManifest.state === "committed") {
          throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction ${id} committed but cleanup did not finish`, error);
        }
        if (diskManifest.state === "prepared") {
          unregisterTransaction(registryPath, id, fsImpl);
          registered = false;
          cleanupDirectory(directory, fsImpl);
          throw error;
        }
        const rolling = diskManifest.state === "rolling_back" ? diskManifest : { ...diskManifest, state: "rolling_back" };
        if (diskManifest.state !== "rolling_back") writeManifest(paths, rolling, fsImpl);
        rollbackManifest(rolling, paths, fsImpl);
        unregisterTransaction(registryPath, id, fsImpl);
        registered = false;
        cleanupDirectory(directory, fsImpl);
      } catch (recoveryError) {
        if (recoveryError === error) throw error;
        if (recoveryError?.code === "LOCAL_TRANSACTION_RECOVERY_REQUIRED") throw recoveryError;
        throw codedError("LOCAL_TRANSACTION_RECOVERY_REQUIRED", `Local file transaction rollback failed for ${id}: ${recoveryError.message}`, recoveryError);
      }
      throw error;
    }
  }

  return Object.freeze({ recoverPendingTransactions, commit });
}

module.exports = {
  REGISTRY_VERSION,
  STATES,
  TRANSACTION_VERSION,
  createLocalFileTransactionManager,
};
