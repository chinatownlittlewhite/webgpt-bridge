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
  return { root, workspace };
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

test("stages a SHA-bound batch and leaves every file untouched after a cancelled or stale confirmation", async (t) => {
  const { workspace } = fixture(t);
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  fs.writeFileSync(first, "before first\n");
  fs.writeFileSync(second, "before second\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const cancelled = createLocalFileBroker({
    policy: (target) => ({ decision: "allow", sensitive: false, path: target }),
    actionPolicy: () => ({ decision: "confirm" }),
    confirm: async () => false,
  });
  const cancelledBatch = cancelled.stage({ changes: [{ type: "update", path: first, content: "after first\n", expectedSha256: sha("before first\n") }] });
  await assert.rejects(cancelled.confirmBatch({ batchId: cancelledBatch.batchId }), /取消/);
  assert.equal(fs.readFileSync(first, "utf8"), "before first\n");

  const broker = createLocalFileBroker({
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
  const { root, workspace } = fixture(t);
  const inside = path.join(workspace, "inside.txt");
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(inside, "inside\n");
  fs.writeFileSync(outside, "outside\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  let prompts = 0;
  const broker = createLocalFileBroker({
    workspaceRoot: workspace,
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
  const { workspace } = fixture(t);
  const old = path.join(workspace, "old.txt");
  const update = path.join(workspace, "update.txt");
  const remove = path.join(workspace, "remove.txt");
  fs.writeFileSync(old, "move me\n");
  fs.writeFileSync(update, "old value\n");
  fs.writeFileSync(remove, "remove me\n");
  const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
  const broker = createLocalFileBroker({
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
