import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalStoreV2 } from "../src/goal-store-v2.js";

function makeStateDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-v2-"));
  const directory = path.join(root, "state-v2");
  fs.mkdirSync(directory, { recursive: true });
  return { root, directory };
}

function readJournal(journalPath) {
  const text = fs.readFileSync(journalPath, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function checksum(body) {
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}

function withFreshChecksum(record) {
  const { checksum: _checksum, ...body } = record;
  return { ...body, checksum: checksum(body) };
}

function inFlightSession(id = "g1") {
  return {
    id,
    status: "active",
    goal: "protected effect",
    inFlightMutation: {
      kind: "goal_tool",
      tool: "write_file",
      inputHash: "a".repeat(64),
      startedAt: 1_700_000_000_000,
    },
  };
}

test("goal store v2 journals ordinary save and remove with contiguous checksummed intent/commit pairs", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const store = createGoalStoreV2({ directory, snapshotEvery: 32 });
    store.save({ id: "g1", status: "active", goal: "ordinary" });

    const loaded = store.loadAll();
    assert.equal(store.version, 2);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "g1");
    loaded[0].goal = "mutated outside";
    assert.equal(store.loadAll()[0].goal, "ordinary");

    let records = readJournal(store.journalPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
    assert.deepEqual(records.map((record) => record.stateClass), ["intent", "active"]);
    assert.equal(records[0].mutationId, records[1].mutationId);
    assert.equal(records[0].sessionId, "g1");
    assert.equal(records[1].sessionId, "g1");
    assert.match(records[0].inputHash, /^[a-f0-9]{64}$/);
    assert.match(records[0].checksum, /^[a-f0-9]{64}$/);
    assert.match(records[1].checksum, /^[a-f0-9]{64}$/);

    store.remove("g1");
    assert.deepEqual(store.loadAll(), []);
    records = readJournal(store.journalPath);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4]);
    assert.deepEqual(records.slice(2).map((record) => record.stateClass), ["intent", "removed"]);
    assert.equal(records[2].mutationId, records[3].mutationId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected Goal intent is durable and its later result commits the same mutation id", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const store = createGoalStoreV2({ directory, snapshotEvery: 32 });
    const pending = inFlightSession();
    store.save(pending);

    let records = readJournal(store.journalPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].stateClass, "intent");
    assert.equal(records[0].protectedEffect, true);
    assert.equal(store.loadAll()[0].inFlightMutation.tool, "write_file");

    store.save({ id: "g1", status: "active", goal: "protected effect", lastFeedback: null });
    records = readJournal(store.journalPath);
    assert.equal(records.length, 2);
    assert.equal(records[1].stateClass, "active");
    assert.equal(records[1].mutationId, records[0].mutationId);
    assert.equal(records[1].inputHash, records[0].inputHash);
    assert.equal(records[1].protectedEffect, true);
    assert.equal(store.loadAll()[0].inFlightMutation, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot compaction is atomic from the store perspective and preserves sequence across reopen", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const first = createGoalStoreV2({ directory, snapshotEvery: 2 });
    first.save({ id: "a", status: "active", goal: "A" });
    first.save({ id: "b", status: "paused", goal: "B" });

    const snapshot = JSON.parse(fs.readFileSync(first.snapshotPath, "utf8"));
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.sequence, 4);
    assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshot.sessions.map((session) => session.id), ["a", "b"]);
    assert.equal(fs.readFileSync(first.journalPath, "utf8"), "");

    const second = createGoalStoreV2({ directory, snapshotEvery: 2 });
    assert.deepEqual(second.loadAll().map((session) => session.id), ["a", "b"]);
    second.save({ id: "c", status: "active", goal: "C" });
    assert.deepEqual(readJournal(second.journalPath).map((record) => record.sequence), [5, 6]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot compaction waits while a protected Goal mutation is pending", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const store = createGoalStoreV2({ directory, snapshotEvery: 1 });
    store.save(inFlightSession("pending"));
    assert.equal(readJournal(store.journalPath).length, 1);
    const snapshotBefore = JSON.parse(fs.readFileSync(store.snapshotPath, "utf8"));
    assert.equal(snapshotBefore.sequence, 0);

    store.save({ id: "pending", status: "active", goal: "protected effect" });
    const snapshotAfter = JSON.parse(fs.readFileSync(store.snapshotPath, "utf8"));
    assert.equal(snapshotAfter.sequence, 2);
    assert.equal(fs.readFileSync(store.journalPath, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("goal store v2 rejects a journal checksum mismatch instead of guessing state", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const store = createGoalStoreV2({ directory, snapshotEvery: 32 });
    store.save({ id: "g1", status: "active", goal: "trusted" });
    const records = readJournal(store.journalPath);
    records[1].session.goal = "tampered";
    fs.writeFileSync(store.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    assert.throws(
      () => createGoalStoreV2({ directory, snapshotEvery: 32 }),
      /journal integrity failure|checksum mismatch/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("goal store v2 rejects a validly-checksummed journal sequence gap", () => {
  const { root, directory } = makeStateDirectory();
  try {
    const store = createGoalStoreV2({ directory, snapshotEvery: 32 });
    store.save({ id: "g1", status: "active", goal: "trusted" });
    const records = readJournal(store.journalPath);
    records[1] = withFreshChecksum({ ...records[1], sequence: 3 });
    fs.writeFileSync(store.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    assert.throws(
      () => createGoalStoreV2({ directory, snapshotEvery: 32 }),
      /sequence is discontinuous/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
