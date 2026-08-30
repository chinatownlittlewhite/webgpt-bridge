const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHostCapabilityStore } = require("../src/host-capability-store.cjs");

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("host capability is bound to root operation expiry and use count", () => {
  let now = 1_000;
  let id = 0;
  const store = createHostCapabilityStore({
    generation: "session-a",
    policyVersion: "v0.5-phase1",
    now: () => now,
    randomId: () => `cap-${++id}`,
  });
  const root = path.resolve("/tmp/allowed");
  const child = path.join(root, "x.txt");
  const grant = store.issue({ root, operations: ["read"], ttlMs: 1_000, maxUses: 1, className: "host-read" });

  assert.equal(Object.isFrozen(grant), true);
  assert.deepEqual(grant.operations, ["read"]);
  assert.equal(grant.remainingUses, 1);
  assert.equal(store.size(), 1);

  expectCode(() => store.authorize({ accessId: "forged", path: child, operation: "read" }), "HOST_CAPABILITY_REQUIRED");
  expectCode(() => store.authorize({ accessId: grant.accessId, path: child, operation: "list" }), "HOST_CAPABILITY_SCOPE_MISMATCH");
  assert.equal(store.authorize({ accessId: grant.accessId, path: child, operation: "read" }), child);
  assert.equal(store.size(), 0);
  expectCode(() => store.authorize({ accessId: grant.accessId, path: child, operation: "read" }), "HOST_CAPABILITY_REQUIRED");

  const expiring = store.issue({ root, operations: ["read"], ttlMs: 100, maxUses: 2, className: "host-read" });
  now = 1_101;
  expectCode(() => store.authorize({ accessId: expiring.accessId, path: root, operation: "read" }), "HOST_CAPABILITY_EXPIRED");
  assert.equal(store.size(), 0);
});

test("host capability covers only its canonical subtree and clear revokes all grants", () => {
  let id = 0;
  const store = createHostCapabilityStore({
    generation: "session-b",
    policyVersion: "v0.5-phase1",
    now: () => 5_000,
    randomId: () => `cap-${++id}`,
  });
  const root = path.resolve("/tmp/allowed");
  const sibling = path.resolve("/tmp/allowed-sibling/file.txt");
  const grant = store.issue({ root, operations: ["read", "list"], ttlMs: 10_000, maxUses: 3, className: "host-browse" });

  assert.equal(store.authorize({ accessId: grant.accessId, path: path.join(root, "nested", "file.txt"), operation: "read" }), path.join(root, "nested", "file.txt"));
  expectCode(() => store.authorize({ accessId: grant.accessId, path: sibling, operation: "read" }), "HOST_CAPABILITY_SCOPE_MISMATCH");
  assert.equal(store.size(), 1, "scope mismatch must not consume the grant");

  assert.equal(store.revoke(grant.accessId), true);
  expectCode(() => store.authorize({ accessId: grant.accessId, path: root, operation: "list" }), "HOST_CAPABILITY_REQUIRED");

  const first = store.issue({ root, operations: ["read"], ttlMs: 10_000, maxUses: 2, className: "host-read" });
  const second = store.issue({ root, operations: ["list"], ttlMs: 10_000, maxUses: 2, className: "host-list" });
  assert.equal(store.size(), 2);
  store.clear();
  assert.equal(store.size(), 0);
  expectCode(() => store.authorize({ accessId: first.accessId, path: root, operation: "read" }), "HOST_CAPABILITY_REQUIRED");
  expectCode(() => store.authorize({ accessId: second.accessId, path: root, operation: "list" }), "HOST_CAPABILITY_REQUIRED");
});

test("host capability canonicalizes real path aliases before scope comparison", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-host-capability-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realRoot = path.join(root, "real");
  const aliasRoot = path.join(root, "alias");
  fs.mkdirSync(realRoot);
  const file = path.join(realRoot, "note.txt");
  fs.writeFileSync(file, "ok\n");
  try {
    fs.symlinkSync(realRoot, aliasRoot, "dir");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code || error.message}`);
    return;
  }

  const store = createHostCapabilityStore({
    generation: "session-alias",
    policyVersion: "v0.5-phase1",
    randomId: () => "cap-alias",
  });
  const grant = store.issue({ root: aliasRoot, operations: ["read"], maxUses: 2 });
  const canonicalRoot = fs.realpathSync.native(realRoot);
  const canonicalFile = fs.realpathSync.native(file);

  assert.equal(grant.root, canonicalRoot);
  assert.equal(store.authorize({ accessId: grant.accessId, path: file, operation: "read" }), canonicalFile);
  assert.equal(store.authorize({ accessId: grant.accessId, path: path.join(aliasRoot, "note.txt"), operation: "read" }), canonicalFile);
});

test("host capability validates bounded grant inputs and does not accept caller-supplied authority metadata", () => {
  const store = createHostCapabilityStore({
    generation: "session-c",
    policyVersion: "v0.5-phase1",
    now: () => 10_000,
    randomId: () => "cap-fixed",
  });
  const root = path.resolve("/tmp/allowed");

  assert.throws(() => store.issue({ root: "relative", operations: ["read"] }), /absolute/i);
  assert.throws(() => store.issue({ root, operations: [] }), /operation/i);
  assert.throws(() => store.issue({ root, operations: ["write"] }), /operation/i);
  assert.throws(() => store.issue({ root, operations: ["read"], ttlMs: 0 }), /ttl/i);
  assert.throws(() => store.issue({ root, operations: ["read"], ttlMs: 5 * 60_000 + 1 }), /ttl/i);
  assert.throws(() => store.issue({ root, operations: ["read"], maxUses: 0 }), /use count/i);
  assert.throws(() => store.issue({ root, operations: ["read"], maxUses: 101 }), /use count/i);

  const grant = store.issue({ root, operations: ["read"] });
  assert.equal(grant.expiresAt, 70_000);
  assert.equal(grant.remainingUses, 1);
  assert.equal(Object.hasOwn(grant, "generation"), false);
  assert.equal(Object.hasOwn(grant, "policyVersion"), false);

  assert.equal(
    store.authorize({
      accessId: grant.accessId,
      path: root,
      operation: "read",
      generation: "forged-session",
      policyVersion: "forged-policy",
    }),
    root,
  );
});
