const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalPath, classifyLocalAction, classifyLocalPath } = require("./local-policy.cjs");
const { createLocalFileTransactionManager } = require("./local-file-transaction-manager.cjs");

const MAX_BATCH_CHANGES = 20;
const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function asPositiveInteger(value, fallback, maximum) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function summarize(change) {
  return {
    type: change.type,
    path: change.path,
    from: change.from,
    expectedSha256: change.expectedSha256,
    bytes: typeof change.content === "string" ? Buffer.byteLength(change.content) : undefined,
  };
}

function createLocalFileBroker({ policy = classifyLocalPath, actionPolicy = classifyLocalAction, confirm = async () => false, audit = () => {}, fsImpl = fs, workspaceRoot = "", capabilityStore, transactionRegistryPath = "" } = {}) {
  const batches = new Map();
  let workspace = "";
  if (typeof workspaceRoot === "string" && workspaceRoot) {
    workspace = canonicalPath(workspaceRoot, fsImpl);
  }
  const transactionManager = typeof transactionRegistryPath === "string" && transactionRegistryPath
    ? createLocalFileTransactionManager({ registryPath: transactionRegistryPath, fsImpl })
    : null;
  if (transactionManager) transactionManager.recoverPendingTransactions();

  function isInsideWorkspace(target) {
    if (!workspace || typeof target !== "string") return false;
    const relative = path.relative(workspace, canonicalPath(target, fsImpl));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  function changeIsInsideWorkspace(change) {
    const touched = change?.type === "move" ? [change.from, change.path] : [change?.path];
    return touched.every((target) => isInsideWorkspace(target));
  }

  function record(entry) {
    try { audit(entry); } catch { /* auditing must never change an authorization decision */ }
  }

  function codedPolicyError(result) {
    return Object.assign(new Error(result?.reason || "该路径不允许由本机文件代理访问。"), { code: result?.code || "LOCAL_PATH_DENIED" });
  }

  function requireCapability(accessId, target, operation) {
    if (!capabilityStore || typeof capabilityStore.authorize !== "function") {
      throw Object.assign(new Error("Host capability is required"), { code: "HOST_CAPABILITY_REQUIRED" });
    }
    return capabilityStore.authorize({ accessId, path: target, operation });
  }

  function pathScope(result) {
    if (typeof result?.scope === "string") return result.scope;
    return result?.sensitive ? "sensitive" : "";
  }

  function authorize(inputPath, operation, accessId) {
    const result = policy(inputPath, { operation });
    const target = result.path || path.resolve(inputPath);
    const scope = pathScope(result);
    const protectedRead = operation === "read" || operation === "list";
    if (scope === "system") throw codedPolicyError(result);
    if (scope === "sensitive") {
      if (!protectedRead) throw codedPolicyError(result);
      return requireCapability(accessId, target, operation);
    }
    if (protectedRead && (scope === "known-folder" || scope === "ordinary-host")) {
      return requireCapability(accessId, target, operation);
    }
    if (result.decision === "allow") return target;
    if (!protectedRead && (scope === "known-folder" || scope === "ordinary-host")) return target;
    throw codedPolicyError(result);
  }

  function requireFile(target) {
    const stat = fsImpl.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("只能操作普通文件，且不跟随符号链接。");
    return stat;
  }

  function assertSha(target, expectedSha256) {
    if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
      throw new Error("修改现有文件必须提供 SHA-256 前置条件。");
    }
    requireFile(target);
    const actual = sha256(fsImpl.readFileSync(target));
    if (actual !== expectedSha256) throw new Error(`SHA-256 不匹配：${target}`);
  }

  function assertExistingDirectory(target) {
    if (!fsImpl.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("目标父目录必须已存在；本机代理不会隐式创建目录树。");
    }
  }

  function assertNewFileTarget(target) {
    if (fsImpl.existsSync(target)) throw new Error(`目标已存在，不允许覆盖：${target}`);
    assertExistingDirectory(path.dirname(target));
  }

  function list({ path: inputPath, depth = 1, includeHidden = false, accessId } = {}) {
    const root = authorize(inputPath, "list", accessId);
    if (!fsImpl.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error("列出目录需要一个存在的目录路径。");
    const entries = [];
    const limit = asPositiveInteger(depth, 1, 4);
    function visit(directory, remaining) {
      for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const entryPath = path.join(directory, entry.name);
        const entryPolicy = policy(entryPath, { operation: "list" });
        const entryScope = pathScope(entryPolicy);
        if (entryPolicy.decision === "deny" || entryScope === "system" || entryScope === "sensitive") continue;
        const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        entries.push({ name: entry.name, path: entryPath, type });
        if (type === "directory" && remaining > 1) visit(entryPath, remaining - 1);
      }
    }
    visit(root, limit);
    return { path: root, entries, truncated: entries.length >= MAX_LIST_ENTRIES };
  }

  function read({ path: inputPath, startLine = 1, maxLines = 200, accessId } = {}) {
    const target = authorize(inputPath, "read", accessId);
    const stat = requireFile(target);
    if (stat.size > MAX_READ_BYTES) throw new Error("文件超过本机代理的安全读取上限（1 MiB）。");
    const body = fsImpl.readFileSync(target);
    if (body.includes(0)) throw new Error("本机代理只读取 UTF-8 文本文件。");
    const text = body.toString("utf8");
    const first = asPositiveInteger(startLine, 1, Number.MAX_SAFE_INTEGER);
    const lineLimit = asPositiveInteger(maxLines, 200, 500);
    return {
      path: target,
      sha256: sha256(body),
      startLine: first,
      text: text.split(/\r?\n/).slice(first - 1, first - 1 + lineLimit).join("\n"),
    };
  }

  async function requestSensitiveAccess({ path: inputPath, operation } = {}) {
    if (operation !== "list" && operation !== "read") throw new Error("敏感访问只支持单次列目录或读取文件。");
    const result = policy(inputPath, { operation });
    const scope = pathScope(result);
    if (scope === "system") throw codedPolicyError(result);
    if (scope !== "sensitive") throw new Error("该路径不属于需要单次确认的敏感位置。");
    const target = result.path || path.resolve(inputPath);
    if (operation === "read") requireFile(target);
    else if (!fsImpl.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error("列出目录需要一个存在的目录路径。");
    const approved = await confirm({ kind: "sensitive-access", path: target, operation });
    if (!approved) {
      record({ action: "sensitive-access", result: "cancelled", path: target, operation });
      throw new Error("用户取消了敏感路径访问请求。");
    }
    if (!capabilityStore || typeof capabilityStore.issue !== "function") {
      throw Object.assign(new Error("Host capability store is not configured"), { code: "HOST_CAPABILITY_REQUIRED" });
    }
    const grant = capabilityStore.issue({ root: target, operations: [operation], ttlMs: 60_000, maxUses: 1, className: `sensitive-${operation}` });
    record({ action: "sensitive-access", result: "approved", path: target, operation });
    return { accessId: grant.accessId, path: target, operation };
  }

  async function requestHostAccess({ path: inputPath, operation } = {}) {
    if (operation !== "list" && operation !== "read") throw new Error("Host access only supports list/read");
    const result = policy(inputPath, { operation });
    const scope = pathScope(result);
    const target = result.path || path.resolve(inputPath);
    if (scope === "workspace") throw new Error("workspace access does not require a Host capability");
    if (scope === "system") throw codedPolicyError(result);
    if (scope === "sensitive") throw new Error("use local_request_sensitive_access for sensitive paths");
    if (scope === "known-folder") throw new Error("known-folder paths must use the dedicated known-folder tools");
    if (scope !== "ordinary-host" || result.decision === "deny") throw codedPolicyError(result);
    if (operation === "read") requireFile(target);
    else if (!fsImpl.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error("列出目录需要一个存在的目录路径。");
    const approved = await confirm({
      kind: "host-path-access",
      path: target,
      operation,
      permissionClass: `host-path:${operation}:${target}`,
    });
    if (!approved) {
      record({ action: "host-path-access", result: "cancelled", path: target, operation });
      throw new Error("用户取消了工作区外本机路径访问请求。");
    }
    if (!capabilityStore || typeof capabilityStore.issue !== "function") {
      throw Object.assign(new Error("Host capability store is not configured"), { code: "HOST_CAPABILITY_REQUIRED" });
    }
    const grant = capabilityStore.issue({ root: target, operations: [operation], ttlMs: 5 * 60_000, maxUses: 100, className: `host-path-${operation}` });
    record({ action: "host-path-access", result: "approved", path: target, operation });
    return { accessId: grant.accessId, path: target, operation };
  }

  function normalizeChange(change, lockedPaths) {
    if (!change || typeof change !== "object") throw new Error("每个变更必须是对象。");
    if (!["create", "update", "move", "delete"].includes(change.type)) throw new Error("变更类型只能是 create、update、move 或 delete。 ");
    const target = authorize(change.path, change.type, undefined);
    const normalized = { type: change.type, path: target, expectedSha256: change.expectedSha256 };
    if (change.type === "create") {
      if (typeof change.content !== "string" || Buffer.byteLength(change.content) > MAX_CONTENT_BYTES) throw new Error("新文件内容必须是小于 1 MiB 的文本。");
      assertNewFileTarget(target);
      normalized.content = change.content;
    } else if (change.type === "update") {
      if (typeof change.content !== "string" || Buffer.byteLength(change.content) > MAX_CONTENT_BYTES) throw new Error("更新内容必须是小于 1 MiB 的文本。");
      assertSha(target, change.expectedSha256);
      normalized.content = change.content;
    } else if (change.type === "delete") {
      assertSha(target, change.expectedSha256);
    } else {
      if (typeof change.from !== "string") throw new Error("移动操作必须提供来源路径。");
      const source = authorize(change.from, "move", undefined);
      assertSha(source, change.expectedSha256);
      assertNewFileTarget(target);
      normalized.from = source;
    }
    const action = actionPolicy({
      kind: change.type === "create" ? "create" : change.type === "update" ? "update" : change.type,
      sensitive: false,
      withinWorkspace: changeIsInsideWorkspace(normalized),
    });
    if (action.decision === "deny") throw new Error(action.reason || "当前授权模式不允许该操作。");
    const touched = change.type === "move" ? [normalized.from, normalized.path] : [normalized.path];
    for (const item of touched) {
      if (lockedPaths.has(item)) throw new Error("同一批次不能多次操作同一路径。");
      lockedPaths.add(item);
    }
    return normalized;
  }

  function stage({ changes } = {}) {
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_BATCH_CHANGES) {
      throw new Error(`变更批次必须包含 1 到 ${MAX_BATCH_CHANGES} 项。`);
    }
    const lockedPaths = new Set();
    const normalized = changes.map((change) => normalizeChange(change, lockedPaths));
    const batchId = crypto.randomUUID();
    batches.set(batchId, { changes: normalized, createdAt: Date.now() });
    return { batchId, changes: normalized.map(summarize) };
  }

  function revalidate(changes) {
    for (const change of changes) {
      if (change.type === "create") assertNewFileTarget(change.path);
      if (change.type === "update" || change.type === "delete") assertSha(change.path, change.expectedSha256);
      if (change.type === "move") {
        assertSha(change.from, change.expectedSha256);
        assertNewFileTarget(change.path);
      }
    }
  }

  async function confirmBatch({ batchId } = {}) {
    const batch = batches.get(batchId);
    if (!batch) throw new Error("批次不存在、已过期或已被处理。 ");
    batches.delete(batchId);
    const summaries = batch.changes.map(summarize);
    const allInsideWorkspace = batch.changes.every((change) => changeIsInsideWorkspace(change));
    const needsConfirmation = batch.changes.some((change) => actionPolicy({
      kind: change.type === "create" ? "create" : change.type === "update" ? "update" : change.type,
      sensitive: false,
      withinWorkspace: changeIsInsideWorkspace(change),
    }).decision !== "allow");
    if (needsConfirmation && !await confirm({
      kind: "local-file-batch",
      changes: summaries,
      rememberable: false,
      scope: allInsideWorkspace ? "workspace" : "outside-workspace",
    })) {
      record({ action: "local-file-batch", result: "cancelled", changes: summaries });
      throw new Error("用户取消了本机文件变更批次。 ");
    }
    revalidate(batch.changes);
    if (!transactionManager) {
      throw Object.assign(new Error("Local file mutations require a durable transaction registry"), { code: "LOCAL_TRANSACTION_REGISTRY_REQUIRED" });
    }
    transactionManager.commit({ batchId, changes: batch.changes });
    record({ action: "local-file-batch", result: "applied", changes: summaries });
    return { batchId, applied: batch.changes.length, changes: summaries };
  }

  return { list, read, requestSensitiveAccess, requestHostAccess, stage, confirmBatch };
}

module.exports = { MAX_BATCH_CHANGES, createLocalFileBroker, sha256 };
