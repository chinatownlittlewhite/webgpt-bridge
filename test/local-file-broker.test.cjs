const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-file-broker-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, transactionRegistryPath: path.join(root, "host-state", "local-file-transactions.json") };
}

function create(t, options = {}) {
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const { root } = fixture(t);
  return createLocalFileBroker({
    policy: (target) => target.includes("sensitive")
      ? { decision: "deny", sensitive: true, path: target }
      : { decision: "allow", sensitive: false, path: target },
    actionPolicy: options.actionPolicy || (() => ({ decision: "confirm" })),
    confirm: options.confirm || (async () => true),
  });
}

test("lists and reads ordinary files without following symlinks", (t) => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, "nested"));
  fs.mkdirSync(path.join(workspace, "sensitive-folder"));
  fs.writeFileSync(path.join(workspace, "nested", "note.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(workspace, ".hidden"), "hidden\n");
  fs.symlinkSync(path.join(workspace, "nested"), path.join(workspace, "alias"));
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const broker = createLocalFileBroker({
    policy: (target) => target.includes("sensitive-folder")
      ? { decision: "deny", sensitive: true, path: target }
      : { decision: "allow", sensitive: false, path: target },
  });

  const listing = broker.list({ path: workspace, depth: 2, includeHidden: false });
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.type]), [["alias", "symlink"], ["nested", "directory"], ["note.txt", "file"]]);
  const read = broker.read({ path: path.join(workspace, "nested", "note.txt"), startLine: 2, maxLines: 1 });
  assert.equal(read.text, "two");
  assert.equal(read.sha256, sha("one\ntwo\nthree\n"));
  assert.equal(broker.list({ path: workspace, depth: 1, includeHidden: true }).entries.some((entry) => entry.name === ".hidden"), true);
  assert.equal(listing.entries.some((entry) => entry.name === "sensitive-folder"), false);
});

test("generic read and list require scoped Host capabilities outside the workspace", (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, "home");
  const desktop = path.join(home, "Desktop");
  const documents = path.join(home, "Documents");
  const downloads = path.join(home, "Downloads");
  const outside = path.join(home, "Projects", "other");
  const sibling = path.join(home, "Projects", "sibling");
  const system = path.join(root, "System");
  for (const directory of [desktop, documents, downloads, outside, sibling, system]) fs.mkdirSync(directory, { recursive: true });
  const workspaceFile = path.join(workspace, "workspace.txt");
  const desktopFile = path.join(desktop, "desktop.txt");
  const documentsFile = path.join(documents, "documents.txt");
  const outsideFile = path.join(outside, "outside.txt");
  const siblingFile = path.join(sibling, "sibling.txt");
  for (const [target, value] of [[workspaceFile, "workspace\n"], [desktopFile, "desktop\n"], [documentsFile, "documents\n"], [outsideFile, "outside\n"], [siblingFile, "sibling\n"]]) fs.writeFileSync(target, value);

  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const { createHostCapabilityStore } = require("../src/host-capability-store.cjs");
  const { classifyLocalPath } = require("../src/local-policy.cjs");
  let nextId = 0;
  const capabilityStore = createHostCapabilityStore({ generation: "test", policyVersion: "v0.5-phase1", randomId: () => `cap-${++nextId}` });
  const policyOptions = { homeDir: home, workspaceRoot: workspace, knownFolderRoots: { desktop, documents, downloads }, systemRoots: [system] };
  const broker = createLocalFileBroker({
    workspaceRoot: workspace,
    capabilityStore,
    policy: (target, options) => classifyLocalPath(target, { ...policyOptions, ...options }),
  });

  assert.equal(broker.read({ path: workspaceFile }).text, "workspace\n");
  assert.throws(() => broker.read({ path: desktopFile }), (error) => error?.code === "HOST_CAPABILITY_REQUIRED");
  assert.throws(() => broker.read({ path: outsideFile }), (error) => error?.code === "HOST_CAPABILITY_REQUIRED");

  const desktopGrant = capabilityStore.issue({ root: desktop, operations: ["read"], ttlMs: 60_000, maxUses: 4, className: "known-folder-read" });
  assert.equal(broker.read({ path: desktopFile, accessId: desktopGrant.accessId }).text, "desktop\n");
  assert.throws(() => broker.read({ path: documentsFile, accessId: desktopGrant.accessId }), (error) => error?.code === "HOST_CAPABILITY_SCOPE_MISMATCH");
  assert.throws(() => broker.list({ path: desktop, accessId: desktopGrant.accessId }), (error) => error?.code === "HOST_CAPABILITY_SCOPE_MISMATCH");
  assert.throws(() => broker.read({ path: siblingFile, accessId: desktopGrant.accessId }), (error) => error?.code === "HOST_CAPABILITY_SCOPE_MISMATCH");
});

test("Host and sensitive authorization issue only scoped read or list capabilities after the correct consent path", async (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, "home");
  const desktop = path.join(home, "Desktop");
  const documents = path.join(home, "Documents");
  const downloads = path.join(home, "Downloads");
  const outside = path.join(home, "Projects", "other");
  const ssh = path.join(home, ".ssh");
  const system = path.join(root, "System");
  for (const directory of [desktop, documents, downloads, outside, ssh, system]) fs.mkdirSync(directory, { recursive: true });
  const outsideFile = path.join(outside, "note.txt");
  const sensitiveFile = path.join(ssh, "config");
  fs.writeFileSync(outsideFile, "host\n");
  fs.writeFileSync(sensitiveFile, "secret\n");

  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const { createHostCapabilityStore } = require("../src/host-capability-store.cjs");
  const { classifyLocalPath } = require("../src/local-policy.cjs");
  let nextId = 0;
  const capabilityStore = createHostCapabilityStore({ generation: "test", policyVersion: "v0.5-phase1", randomId: () => `issued-${++nextId}` });
  const policyOptions = { homeDir: home, workspaceRoot: workspace, knownFolderRoots: { desktop, documents, downloads }, systemRoots: [system] };
  const prompts = [];
  const broker = createLocalFileBroker({
    workspaceRoot: workspace,
    capabilityStore,
    policy: (target, options) => classifyLocalPath(target, { ...policyOptions, ...options }),
    confirm: async (request) => { prompts.push(request); return true; },
  });

  const hostGrant = await broker.requestHostAccess({ path: outsideFile, operation: "read" });
  assert.equal(hostGrant.path, outsideFile);
  assert.equal(broker.read({ path: outsideFile, accessId: hostGrant.accessId }).text, "host\n");
  assert.equal(prompts[0].kind, "host-path-access");
  await assert.rejects(broker.requestHostAccess({ path: desktop, operation: "list" }), /known-folder|desktop|专用/i);
  await assert.rejects(broker.requestHostAccess({ path: system, operation: "list" }), /系统|system/i);

  const sensitiveGrant = await broker.requestSensitiveAccess({ path: sensitiveFile, operation: "read" });
  assert.equal(prompts.at(-1).kind, "sensitive-access");
  assert.equal(broker.read({ path: sensitiveFile, accessId: sensitiveGrant.accessId }).text, "secret\n");
  assert.throws(() => broker.read({ path: sensitiveFile, accessId: sensitiveGrant.accessId }), (error) => error?.code === "HOST_CAPABILITY_REQUIRED");
});

test("stages a SHA-bound batch and leaves every file untouched after a cancelled or stale confirmation", async (t) => {
  const { workspace, transactionRegistryPath } = fixture(t);
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  fs.writeFileSync(first, "before first\n");
  fs.writeFileSync(second, "before second\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const cancelled = createLocalFileBroker({
    transactionRegistryPath,
    policy: (target) => ({ decision: "allow", sensitive: false, path: target }),
    actionPolicy: () => ({ decision: "confirm" }),
    confirm: async () => false,
  });
  const cancelledBatch = cancelled.stage({ changes: [{ type: "update", path: first, content: "after first\n", expectedSha256: sha("before first\n") }] });
  await assert.rejects(cancelled.confirmBatch({ batchId: cancelledBatch.batchId }), /取消/);
  assert.equal(fs.readFileSync(first, "utf8"), "before first\n");

  const broker = createLocalFileBroker({
    transactionRegistryPath,
    policy: (target) => ({ decision: "allow", sensitive: false, path: target }),
    actionPolicy: () => ({ decision: "confirm" }),
    confirm: async () => true,
  });
  const batch = broker.stage({ changes: [
    { type: "update", path: first, content: "after first\n", expectedSha256: sha("before first\n") },
    { type: "update", path: second, content: "after second\n", expectedSha256: sha("before second\n") },
  ] });
  fs.writeFileSync(second, "changed elsewhere\n");
  await assert.rejects(broker.confirmBatch({ batchId: batch.batchId }), /SHA/);
  assert.equal(fs.readFileSync(first, "utf8"), "before first\n");
  assert.equal(fs.readFileSync(second, "utf8"), "changed elsewhere\n");
});

test("development mode skips confirmation for destructive batches only inside the configured workspace", async (t) => {
  const { root, workspace, transactionRegistryPath } = fixture(t);
  const inside = path.join(workspace, "inside.txt");
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(inside, "inside\n");
  fs.writeFileSync(outside, "outside\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  let prompts = 0;
  const broker = createLocalFileBroker({
    workspaceRoot: workspace,
    transactionRegistryPath,
    policy: (target) => ({ decision: "allow", sensitive: false, path: target }),
    actionPolicy: ({ kind, withinWorkspace }) => ({ decision: ["delete", "move"].includes(kind) && !withinWorkspace ? "confirm" : "allow" }),
    confirm: async () => { prompts += 1; return true; },
  });

  const insideBatch = broker.stage({ changes: [{ type: "delete", path: inside, expectedSha256: sha("inside\n") }] });
  await broker.confirmBatch({ batchId: insideBatch.batchId });
  assert.equal(prompts, 0);

  const outsideBatch = broker.stage({ changes: [{ type: "delete", path: outside, expectedSha256: sha("outside\n") }] });
  await broker.confirmBatch({ batchId: outsideBatch.batchId });
  assert.equal(prompts, 1);
});

test("applies bounded create, update, move, and delete batches only after confirmation", async (t) => {
  const { workspace, transactionRegistryPath } = fixture(t);
  const old = path.join(workspace, "old.txt");
  const update = path.join(workspace, "update.txt");
  const remove = path.join(workspace, "remove.txt");
  fs.writeFileSync(old, "move me\n");
  fs.writeFileSync(update, "old value\n");
  fs.writeFileSync(remove, "remove me\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const broker = createLocalFileBroker({
    transactionRegistryPath,
    policy: (target) => ({ decision: "allow", sensitive: false, path: target }),
    actionPolicy: () => ({ decision: "confirm" }),
    confirm: async ({ changes }) => {
      assert.equal(changes.length, 4);
      return true;
    },
  });
  const result = await broker.confirmBatch({ batchId: broker.stage({ changes: [
    { type: "create", path: path.join(workspace, "new.txt"), content: "new value\n" },
    { type: "update", path: update, content: "updated\n", expectedSha256: sha("old value\n") },
    { type: "move", from: old, path: path.join(workspace, "moved.txt"), expectedSha256: sha("move me\n") },
    { type: "delete", path: remove, expectedSha256: sha("remove me\n") },
  ] }).batchId });
  assert.equal(result.applied, 4);
  assert.equal(fs.readFileSync(path.join(workspace, "new.txt"), "utf8"), "new value\n");
  assert.equal(fs.readFileSync(update, "utf8"), "updated\n");
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(path.join(workspace, "moved.txt"), "utf8"), "move me\n");
  assert.equal(fs.existsSync(remove), false);

  assert.throws(() => broker.stage({ changes: Array.from({ length: 21 }, (_, index) => ({ type: "create", path: path.join(workspace, `overflow-${index}.txt`), content: "x" })) }), /20/);
});

test("confirmed mutation refuses to run without a durable transaction registry", async (t) => {
  const { workspace } = fixture(t);
  const target = path.join(workspace, "update.txt");
  fs.writeFileSync(target, "before\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const broker = createLocalFileBroker({
    policy: (value) => ({ decision: "allow", sensitive: false, path: value }),
    actionPolicy: () => ({ decision: "allow" }),
  });
  const batch = broker.stage({ changes: [{ type: "update", path: target, content: "after\n", expectedSha256: sha("before\n") }] });

  await assert.rejects(
    broker.confirmBatch({ batchId: batch.batchId }),
    (error) => error?.code === "LOCAL_TRANSACTION_REGISTRY_REQUIRED",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});

test("broker initialization recovers an interrupted registered transaction before serving requests", (t) => {
  const { workspace, transactionRegistryPath } = fixture(t);
  const target = path.join(workspace, "update.txt");
  fs.writeFileSync(target, "before\n");
  const { createLocalFileTransactionManager } = require("../src/local-file-transaction-manager.cjs");
  const interrupted = createLocalFileTransactionManager({
    registryPath: transactionRegistryPath,
    randomId: () => "99999999-9999-4999-8999-999999999999",
    faultInjector: ({ phase, step }) => phase === "after-rename" && step === "update-backup" ? "crash" : undefined,
  });
  assert.throws(
    () => interrupted.commit({
      batchId: "broker-recovery",
      changes: [{ type: "update", path: target, content: "after\n", expectedSha256: sha("before\n") }],
    }),
    (error) => error?.code === "LOCAL_TRANSACTION_SIMULATED_CRASH",
  );
  assert.equal(fs.existsSync(target), false);

  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  createLocalFileBroker({
    workspaceRoot: workspace,
    transactionRegistryPath,
    policy: (value) => ({ decision: "allow", sensitive: false, path: value }),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});
