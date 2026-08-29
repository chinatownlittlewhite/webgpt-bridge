const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { STATES, createLocalFileTransactionManager } = require("../src/local-file-transaction-manager.cjs");

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

test("local file broker uses durable transaction manager and has no legacy in-memory rollback journal", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "local-file-broker.cjs"), "utf8");
  assert.match(source, /createLocalFileTransactionManager/);
  assert.match(source, /transactionManager\.recoverPendingTransactions\(\)/);
  assert.match(source, /transactionManager\.commit\(\{\s*batchId,\s*changes:\s*batch\.changes\s*\}\)/s);
  assert.doesNotMatch(source, /function\s+applyAtomically/);
  assert.doesNotMatch(source, /const\s+journal\s*=\s*\[\]/);
});

test("Desktop owns the transaction registry path under fixed userData state", () => {
  const broker = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(broker, /transactionRegistryPath:\s*path\.join\(app\.getPath\("userData"\),\s*"local-file-transactions\.json"\)/);
  assert.doesNotMatch(broker, /settings\.transactionRegistryPath/);
});

test("transaction manager freezes exactly the four durable recovery states", () => {
  assert.deepEqual([...STATES].sort(), ["applying", "committed", "prepared", "rolling_back"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "local-file-transaction-manager.cjs"), "utf8");
  assert.match(source, /\.webgpt-bridge-txn-/);
  assert.match(source, /LOCAL_TRANSACTION_RECOVERY_REQUIRED/);
  assert.match(source, /LOCAL_TRANSACTION_CROSS_DEVICE/);
  assert.match(source, /LOCAL_TRANSACTION_REGISTRY_INVALID/);
});

test("prepared manifest carries path and hash identities but never staged contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-file-txn-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = path.join(root, "files");
  const hostState = path.join(root, "host-state");
  fs.mkdirSync(files);
  fs.mkdirSync(hostState);
  const target = path.join(files, "created.txt");
  const registryPath = path.join(hostState, "local-file-transactions.json");
  const manager = createLocalFileTransactionManager({
    registryPath,
    randomId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    faultInjector: ({ phase }) => phase === "prepared" ? "crash" : undefined,
  });
  assert.throws(
    () => manager.commit({
      batchId: "contract-batch",
      changes: [{ type: "create", path: target, content: "do not copy this body into metadata\n" }],
    }),
    (error) => error?.code === "LOCAL_TRANSACTION_SIMULATED_CRASH",
  );

  const registry = readJson(registryPath);
  assert.equal(registry.version, 1);
  assert.equal(registry.transactions.length, 1);
  const manifestPath = path.join(registry.transactions[0].directory, "transaction.json");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.state, "prepared");
  assert.equal(manifest.operations[0].path, target);
  assert.match(manifest.operations[0].newSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(manifestText, /do not copy this body into metadata/);
  assert.equal(Object.hasOwn(manifest.operations[0], "content"), false);
});

test("transaction persistence stays pure Node without SQLite or native database dependencies", () => {
  for (const relative of ["package.json", "agent-runtime/package.json"]) {
    const pkg = readJson(path.join(__dirname, "..", relative));
    const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const name of ["sqlite3", "better-sqlite3", "node-sqlite3", "@journeyapps/sqlcipher"]) {
      assert.equal(Object.hasOwn(dependencies, name), false, `${relative} must not add ${name}`);
    }
  }
});
