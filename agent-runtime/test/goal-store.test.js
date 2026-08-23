import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalController } from "../src/goal-controller.js";
import {
  createFileGoalSessionStore,
  createMemoryGoalSessionStore,
} from "../src/goal-store.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-goal-store-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  return root;
}

test("memory goal store snapshots values instead of exposing mutable references", () => {
  const store = createMemoryGoalSessionStore();
  const session = { id: "session_1", status: "active", nested: { value: 1 } };
  store.save(session);
  session.nested.value = 2;
  const [loaded] = store.loadAll();
  assert.equal(loaded.nested.value, 1);
  loaded.nested.value = 3;
  assert.equal(store.loadAll()[0].nested.value, 1);
});

test("file goal store persists sessions with one file per opaque handle", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  store.save({ id: "abc_123", status: "active", goal: "persist me" });

  const loaded = store.loadAll();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "abc_123");
  assert.equal(loaded[0].goal, "persist me");
  assert.equal(fs.existsSync(path.join(store.directory, "abc_123.json")), true);

  store.remove("abc_123");
  assert.equal(store.loadAll().length, 0);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("file goal store rejects path-like session ids and escaping store directories", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  assert.throws(() => store.save({ id: "../escape", status: "active" }), /unsupported characters/);
  assert.throws(
    () => createFileGoalSessionStore({ workspace, directoryName: "../outside" }),
    /escapes the configured workspace/,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("a new goal controller restores persisted active sessions after restart", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  const first = createGoalController({
    workspace,
    tools: [],
    sessionStore: store,
    verificationTasks: [],
  });
  const started = first.start({
    goal: "Survive a connector restart",
    cwd: "project",
    acceptanceCriteria: ["Session is recoverable"],
  });
  assert.equal(started.status, "active");
  assert.equal(started.persistence.persistent, true);
  assert.equal(started.persistence.saved, true);

  const second = createGoalController({
    workspace,
    tools: [],
    sessionStore: createFileGoalSessionStore({ workspace }),
    verificationTasks: [],
  });
  const restored = second.status(started.sessionId);
  assert.equal(restored.status, "active");
  assert.equal(restored.cwd, "project");
  assert.deepEqual(restored.acceptanceCriteria, ["Session is recoverable"]);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("persisted sessions are revalidated and out-of-scope cwd state is ignored", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  store.save({
    id: "tampered",
    goal: "escape",
    cwd: "../outside",
    status: "active",
    acceptanceCriteria: [],
    maxSteps: 50,
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const controller = createGoalController({ workspace, tools: [], sessionStore: store });
  assert.deepEqual(controller.status("tampered"), {
    status: "not_found",
    mustContinue: false,
    sessionId: "tampered",
  });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("file goal store rejects a symlinked parent that escapes the workspace before creating children", (t) => {
  const workspace = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-goal-store-outside-"));
  try {
    fs.symlinkSync(outside, path.join(workspace, ".webgpt-bridge"), "dir");
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip(`directory symlinks are unavailable: ${error.message}`);
    return;
  }

  assert.throws(
    () => createFileGoalSessionStore({ workspace }),
    /symlink outside|escapes the configured workspace/,
  );
  assert.equal(fs.existsSync(path.join(outside, "goals")), false);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("persisted timestamps and history are bounded again during hydration", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  const future = Date.now() + 365 * 24 * 60 * 60_000;
  store.save({
    id: "bounded_state",
    goal: "restore safely",
    cwd: "project",
    status: "active",
    acceptanceCriteria: [],
    maxSteps: 50,
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    createdAt: future,
    updatedAt: future,
    history: [{ type: "tool_result", payload: "x".repeat(40_000) }],
    repeatedActionHash: "not-a-real-hash",
  });

  const before = Date.now();
  const controller = createGoalController({ workspace, tools: [], sessionStore: store, verificationTasks: [] });
  const restored = controller.status("bounded_state");
  const after = Date.now();
  assert.equal(restored.status, "active");
  assert.ok(restored.createdAt >= before && restored.createdAt <= after);
  assert.ok(restored.updatedAt >= before && restored.updatedAt <= after);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].truncated, true);
  assert.match(restored.history[0].sha256, /^[a-f0-9]{64}$/);
  fs.rmSync(workspace, { recursive: true, force: true });
});
