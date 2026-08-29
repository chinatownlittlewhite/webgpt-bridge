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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-file-txn-"));
  const files = path.join(root, "files");
  const hostState = path.join(root, "host-state");
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(hostState, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    files,
    registryPath: path.join(hostState, "local-file-transactions.json"),
  };
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { version: 1, transactions: [] };
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function registeredTransaction(registryPath) {
  const registry = readRegistry(registryPath);
  assert.equal(registry.version, 1);
  assert.equal(registry.transactions.length, 1);
  return registry.transactions[0];
}

function createManager(options) {
  const { createLocalFileTransactionManager } = require("../src/local-file-transaction-manager.cjs");
  return createLocalFileTransactionManager(options);
}

function assertInjectedCrash(fn) {
  assert.throws(fn, (error) => error?.code === "LOCAL_TRANSACTION_SIMULATED_CRASH");
}

function crashOn(match) {
  return (event) => match(event) ? "crash" : undefined;
}

test("durable transaction manifest records identities and layout without staged contents", (t) => {
  const { files, registryPath } = fixture(t);
  const created = path.join(files, "created.txt");
  const updated = path.join(files, "updated.txt");
  const removed = path.join(files, "removed.txt");
  const movedFrom = path.join(files, "move-from.txt");
  const movedTo = path.join(files, "move-to.txt");
  fs.writeFileSync(updated, "before update\n");
  fs.writeFileSync(removed, "remove me\n");
  fs.writeFileSync(movedFrom, "move me\n");

  const manager = createManager({
    registryPath,
    randomId: () => "11111111-1111-4111-8111-111111111111",
    faultInjector: crashOn(({ phase }) => phase === "prepared"),
  });
  assertInjectedCrash(() => manager.commit({
    batchId: "batch-layout",
    changes: [
      { type: "create", path: created, content: "new secret-ish body\n" },
      { type: "update", path: updated, content: "after update\n", expectedSha256: sha("before update\n") },
      { type: "delete", path: removed, expectedSha256: sha("remove me\n") },
      { type: "move", from: movedFrom, path: movedTo, expectedSha256: sha("move me\n") },
    ],
  }));

  const registered = registeredTransaction(registryPath);
  assert.equal(path.basename(registered.directory), ".webgpt-bridge-txn-11111111-1111-4111-8111-111111111111");
  assert.deepEqual(fs.readdirSync(registered.directory).sort(), ["backup", "new", "transaction.json"]);
  const manifestText = fs.readFileSync(path.join(registered.directory, "transaction.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.id, registered.id);
  assert.equal(manifest.state, "prepared");
  assert.equal(manifest.batchId, "batch-layout");
  assert.deepEqual(manifest.operations.map((entry) => entry.type), ["create", "update", "delete", "move"]);
  assert.deepEqual(manifest.operations.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.equal(manifest.operations[0].path, created);
  assert.equal(manifest.operations[0].newSha256, sha("new secret-ish body\n"));
  assert.equal(manifest.operations[1].expectedSha256, sha("before update\n"));
  assert.equal(manifest.operations[3].from, movedFrom);
  assert.doesNotMatch(manifestText, /new secret-ish body/);
  assert.equal(fs.readFileSync(path.join(registered.directory, "new", "0"), "utf8"), "new secret-ish body\n");

  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.readFileSync(updated, "utf8"), "before update\n");
  assert.equal(fs.readFileSync(removed, "utf8"), "remove me\n");
  assert.equal(fs.readFileSync(movedFrom, "utf8"), "move me\n");
  assert.equal(fs.existsSync(movedTo), false);
});

test("normal commit applies create update delete and move then unregisters transaction", (t) => {
  const { files, registryPath } = fixture(t);
  const created = path.join(files, "created.txt");
  const updated = path.join(files, "updated.txt");
  const removed = path.join(files, "removed.txt");
  const movedFrom = path.join(files, "move-from.txt");
  const movedTo = path.join(files, "move-to.txt");
  fs.writeFileSync(updated, "before update\n");
  fs.writeFileSync(removed, "remove me\n");
  fs.writeFileSync(movedFrom, "move me\n");

  const manager = createManager({
    registryPath,
    randomId: () => "22222222-2222-4222-8222-222222222222",
  });
  manager.commit({
    batchId: "batch-normal",
    changes: [
      { type: "create", path: created, content: "created\n" },
      { type: "update", path: updated, content: "after update\n", expectedSha256: sha("before update\n") },
      { type: "delete", path: removed, expectedSha256: sha("remove me\n") },
      { type: "move", from: movedFrom, path: movedTo, expectedSha256: sha("move me\n") },
    ],
  });

  assert.equal(fs.readFileSync(created, "utf8"), "created\n");
  assert.equal(fs.readFileSync(updated, "utf8"), "after update\n");
  assert.equal(fs.existsSync(removed), false);
  assert.equal(fs.existsSync(movedFrom), false);
  assert.equal(fs.readFileSync(movedTo, "utf8"), "move me\n");
  assert.deepEqual(readRegistry(registryPath).transactions, []);
  assert.equal(fs.readdirSync(files).some((name) => name.startsWith(".webgpt-bridge-txn-")), false);
});

for (const scenario of [
  {
    name: "create",
    setup(files) {
      return {
        changes: [{ type: "create", path: path.join(files, "created.txt"), content: "new\n" }],
        crash: ({ phase, step }) => phase === "after-rename" && step === "create-target",
        assertRestored(files) { assert.equal(fs.existsSync(path.join(files, "created.txt")), false); },
      };
    },
  },
  {
    name: "update",
    setup(files) {
      const target = path.join(files, "updated.txt");
      fs.writeFileSync(target, "old\n");
      return {
        changes: [{ type: "update", path: target, content: "new\n", expectedSha256: sha("old\n") }],
        crash: ({ phase, step }) => phase === "after-rename" && step === "update-backup",
        assertRestored() { assert.equal(fs.readFileSync(target, "utf8"), "old\n"); },
      };
    },
  },
  {
    name: "delete",
    setup(files) {
      const target = path.join(files, "removed.txt");
      fs.writeFileSync(target, "old\n");
      return {
        changes: [{ type: "delete", path: target, expectedSha256: sha("old\n") }],
        crash: ({ phase, step }) => phase === "after-rename" && step === "delete-backup",
        assertRestored() { assert.equal(fs.readFileSync(target, "utf8"), "old\n"); },
      };
    },
  },
  {
    name: "move",
    setup(files) {
      const from = path.join(files, "from.txt");
      const to = path.join(files, "to.txt");
      fs.writeFileSync(from, "old\n");
      return {
        changes: [{ type: "move", from, path: to, expectedSha256: sha("old\n") }],
        crash: ({ phase, step }) => phase === "after-rename" && step === "move-backup",
        assertRestored() {
          assert.equal(fs.readFileSync(from, "utf8"), "old\n");
          assert.equal(fs.existsSync(to), false);
        },
      };
    },
  },
]) {
  test(`startup recovery restores pre-state after crash during ${scenario.name}`, (t) => {
    const { files, registryPath } = fixture(t);
    const configured = scenario.setup(files);
    const crashing = createManager({
      registryPath,
      randomId: () => "33333333-3333-4333-8333-333333333333",
      faultInjector: crashOn(configured.crash),
    });
    assertInjectedCrash(() => crashing.commit({ batchId: `batch-${scenario.name}`, changes: configured.changes }));
    assert.equal(readRegistry(registryPath).transactions.length, 1);

    const recovered = createManager({ registryPath });
    recovered.recoverPendingTransactions();
    configured.assertRestored(files);
    assert.deepEqual(readRegistry(registryPath).transactions, []);
  });
}

test("committed crash verifies final state then cleans registry without rolling back", (t) => {
  const { files, registryPath } = fixture(t);
  const target = path.join(files, "updated.txt");
  fs.writeFileSync(target, "old\n");
  const manager = createManager({
    registryPath,
    randomId: () => "44444444-4444-4444-8444-444444444444",
    faultInjector: crashOn(({ phase }) => phase === "committed"),
  });
  assertInjectedCrash(() => manager.commit({
    batchId: "batch-committed",
    changes: [{ type: "update", path: target, content: "new\n", expectedSha256: sha("old\n") }],
  }));
  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
  assert.equal(readRegistry(registryPath).transactions.length, 1);

  createManager({ registryPath }).recoverPendingTransactions();
  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
  assert.deepEqual(readRegistry(registryPath).transactions, []);
});

test("ambiguous applying recovery fails closed and preserves transaction evidence", (t) => {
  const { files, registryPath } = fixture(t);
  const target = path.join(files, "created.txt");
  const crashing = createManager({
    registryPath,
    randomId: () => "55555555-5555-4555-8555-555555555555",
    faultInjector: crashOn(({ phase, step }) => phase === "after-rename" && step === "create-target"),
  });
  assertInjectedCrash(() => crashing.commit({
    batchId: "batch-ambiguous",
    changes: [{ type: "create", path: target, content: "owned\n" }],
  }));
  fs.writeFileSync(target, "changed elsewhere\n");
  const registered = registeredTransaction(registryPath);

  assert.throws(
    () => createManager({ registryPath }).recoverPendingTransactions(),
    (error) => error?.code === "LOCAL_TRANSACTION_RECOVERY_REQUIRED",
  );
  assert.equal(fs.existsSync(registered.directory), true);
  assert.equal(readRegistry(registryPath).transactions.length, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "changed elsewhere\n");
});

test("prepared recovery performs cleanup without mutating user files", (t) => {
  const { files, registryPath } = fixture(t);
  const target = path.join(files, "created.txt");
  const crashing = createManager({
    registryPath,
    randomId: () => "77777777-7777-4777-8777-777777777777",
    faultInjector: crashOn(({ phase }) => phase === "prepared"),
  });
  assertInjectedCrash(() => crashing.commit({
    batchId: "batch-prepared",
    changes: [{ type: "create", path: target, content: "new\n" }],
  }));
  assert.equal(fs.existsSync(target), false);
  createManager({ registryPath }).recoverPendingTransactions();
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(readRegistry(registryPath).transactions, []);
});

test("corrupt manifest fails closed and preserves registry evidence", (t) => {
  const { files, registryPath } = fixture(t);
  const target = path.join(files, "created.txt");
  const crashing = createManager({
    registryPath,
    randomId: () => "88888888-8888-4888-8888-888888888888",
    faultInjector: crashOn(({ phase }) => phase === "prepared"),
  });
  assertInjectedCrash(() => crashing.commit({
    batchId: "batch-corrupt",
    changes: [{ type: "create", path: target, content: "new\n" }],
  }));
  const registered = registeredTransaction(registryPath);
  fs.writeFileSync(path.join(registered.directory, "transaction.json"), "{broken\n", "utf8");

  assert.throws(
    () => createManager({ registryPath }).recoverPendingTransactions(),
    (error) => error?.code === "LOCAL_TRANSACTION_RECOVERY_REQUIRED",
  );
  assert.equal(fs.existsSync(registered.directory), true);
  assert.equal(readRegistry(registryPath).transactions.length, 1);
  assert.equal(fs.existsSync(target), false);
});

test("symlinked transaction manifest fails closed without touching user files", (t) => {
  const { root, files, registryPath } = fixture(t);
  const target = path.join(files, "created.txt");
  const crashing = createManager({
    registryPath,
    randomId: () => "66666666-6666-4666-8666-666666666666",
    faultInjector: crashOn(({ phase }) => phase === "prepared"),
  });
  assertInjectedCrash(() => crashing.commit({
    batchId: "batch-symlink",
    changes: [{ type: "create", path: target, content: "new\n" }],
  }));
  const registered = registeredTransaction(registryPath);
  const manifestPath = path.join(registered.directory, "transaction.json");
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "{}\n");
  fs.rmSync(manifestPath);
  try {
    fs.symlinkSync(outside, manifestPath);
  } catch (error) {
    t.skip(`file symlinks are unavailable in this environment: ${error.message}`);
    return;
  }

  assert.throws(
    () => createManager({ registryPath }).recoverPendingTransactions(),
    (error) => error?.code === "LOCAL_TRANSACTION_RECOVERY_REQUIRED",
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(readRegistry(registryPath).transactions.length, 1);
});

test("cross-device batch is rejected before any protected rename", (t) => {
  const { files, registryPath } = fixture(t);
  const one = path.join(files, "one");
  const two = path.join(files, "two");
  fs.mkdirSync(one);
  fs.mkdirSync(two);
  const first = path.join(one, "first.txt");
  const second = path.join(two, "second.txt");
  fs.writeFileSync(first, "one\n");
  fs.writeFileSync(second, "two\n");

  const fsImpl = Object.create(fs);
  fsImpl.statSync = (target, options) => {
    const stat = fs.statSync(target, options);
    if (path.resolve(target) !== path.resolve(two)) return stat;
    return new Proxy(stat, {
      get(value, property) {
        if (property === "dev") return Number(value.dev) + 1;
        const result = Reflect.get(value, property, value);
        return typeof result === "function" ? result.bind(value) : result;
      },
    });
  };

  const manager = createManager({ registryPath, fsImpl });
  assert.throws(
    () => manager.commit({
      batchId: "batch-cross-device",
      changes: [
        { type: "update", path: first, content: "changed one\n", expectedSha256: sha("one\n") },
        { type: "update", path: second, content: "changed two\n", expectedSha256: sha("two\n") },
      ],
    }),
    (error) => error?.code === "LOCAL_TRANSACTION_CROSS_DEVICE",
  );
  assert.equal(fs.readFileSync(first, "utf8"), "one\n");
  assert.equal(fs.readFileSync(second, "utf8"), "two\n");
  assert.deepEqual(readRegistry(registryPath).transactions, []);
});
