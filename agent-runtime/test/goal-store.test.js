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
import { INTERNAL_STATE_DIR } from "../src/workspace.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-goal-store-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  return root;
}

function createControlledStore({ failOnSaves = [] } = {}) {
  const values = new Map();
  const failures = new Set(failOnSaves);
  let saveCount = 0;
  return {
    kind: "controlled",
    persistent: true,
    loadAll() {
      return [...values.values()].map((value) => structuredClone(value));
    },
    save(session) {
      saveCount += 1;
      if (failures.has(saveCount)) throw new Error(`controlled save failure ${saveCount}`);
      values.set(session.id, structuredClone(session));
    },
    remove(sessionId) {
      values.delete(sessionId);
    },
    get saveCount() {
      return saveCount;
    },
  };
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

test("file goal store persists sessions in the durable v2 state directory", () => {
  const workspace = makeWorkspace();
  const store = createFileGoalSessionStore({ workspace });
  store.save({ id: "abc_123", status: "active", goal: "persist me" });

  const loaded = store.loadAll();
  assert.equal(store.kind, "file");
  assert.equal(store.persistent, true);
  assert.equal(store.version, 2);
  assert.equal(path.basename(store.stateDirectory), "state-v2");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "abc_123");
  assert.equal(loaded[0].goal, "persist me");
  for (const name of ["metadata.json", "snapshot.json", "journal.log"]) {
    assert.equal(fs.existsSync(path.join(store.stateDirectory, name)), true);
  }
  assert.equal(fs.existsSync(path.join(store.directory, "abc_123.json")), false);

  store.remove("abc_123");
  assert.equal(store.loadAll().length, 0);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("file goal store transactionally migrates valid v1 sessions once and preserves source files", () => {
  const workspace = makeWorkspace();
  const goalsDir = path.join(workspace, INTERNAL_STATE_DIR, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });
  const legacyPath = path.join(goalsDir, "legacy.json");
  fs.writeFileSync(legacyPath, `${JSON.stringify({
    version: 1,
    session: { id: "legacy", status: "active", goal: "keep me" },
  }, null, 2)}\n`, "utf8");

  const first = createFileGoalSessionStore({ workspace });
  assert.equal(first.version, 2);
  assert.deepEqual(first.loadAll().map((session) => session.id), ["legacy"]);
  assert.equal(fs.existsSync(legacyPath), true);
  const metadata = JSON.parse(fs.readFileSync(path.join(first.stateDirectory, "metadata.json"), "utf8"));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.migrationComplete, true);
  assert.equal(metadata.migratedFromV1, 1);
  assert.equal(fs.readdirSync(goalsDir).some((name) => name.startsWith(".state-v2-migrate-")), false);

  fs.writeFileSync(path.join(goalsDir, "late-legacy.json"), `${JSON.stringify({
    version: 1,
    session: { id: "late_legacy", status: "active", goal: "must not be reimported" },
  })}\n`, "utf8");
  const second = createFileGoalSessionStore({ workspace });
  assert.deepEqual(second.loadAll().map((session) => session.id), ["legacy"]);
  assert.equal(fs.existsSync(legacyPath), true);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("migration publication failure leaves valid v1 Goal state readable and writable", () => {
  const workspace = makeWorkspace();
  const goalsDir = path.join(workspace, INTERNAL_STATE_DIR, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });
  fs.writeFileSync(path.join(goalsDir, "legacy.json"), `${JSON.stringify({
    version: 1,
    session: { id: "legacy", status: "active", goal: "fallback" },
  })}\n`, "utf8");
  fs.writeFileSync(path.join(goalsDir, "state-v2"), "blocks directory publication\n", "utf8");

  const store = createFileGoalSessionStore({ workspace });
  assert.equal(store.version, 1);
  assert.equal(store.loadAll()[0].id, "legacy");
  store.save({ id: "legacy_2", status: "paused", goal: "still writable" });
  assert.equal(fs.existsSync(path.join(goalsDir, "legacy_2.json")), true);
  assert.deepEqual(store.loadAll().map((session) => session.id).sort(), ["legacy", "legacy_2"]);
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

test("restart fails closed when a side-effecting goal_step was in flight", async () => {
  const store = createControlledStore();
  let markStarted;
  let releaseInvoke;
  const startedInvoke = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseInvoke = resolve; });
  const slowTool = {
    name: "slow_side_effect",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async invoke() {
      markStarted();
      await release;
      return { status: "completed" };
    },
  };
  const first = createGoalController({ tools: [slowTool], sessionStore: store, verificationTasks: [] });
  const started = first.start({ goal: "Do not replay an interrupted side effect" });
  const stepPromise = first.step({ sessionId: started.sessionId, tool: "slow_side_effect", input: {} });
  await startedInvoke;

  try {
    const restarted = createGoalController({ tools: [slowTool], sessionStore: store, verificationTasks: [] });
    const recovered = restarted.status(started.sessionId);
    assert.equal(recovered.status, "failed");
    assert.match(recovered.lastFeedback, /interrupted.*mutation|mutation.*interrupted/i);
  } finally {
    releaseInvoke();
    await stepPromise;
  }
});

test("goal_step does not invoke a side effect when its mutation intent cannot be persisted", async () => {
  const store = createControlledStore({ failOnSaves: [2] });
  let calls = 0;
  const tool = {
    name: "side_effect",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async invoke() {
      calls += 1;
      return { status: "completed" };
    },
  };
  const controller = createGoalController({ tools: [tool], sessionStore: store, verificationTasks: [] });
  const started = controller.start({ goal: "Persist before side effects" });

  const result = await controller.step({ sessionId: started.sessionId, tool: "side_effect", input: {} });

  assert.equal(result.status, "persistence_error");
  assert.equal(result.mustContinue, false);
  assert.equal(calls, 0);
});

test("goal_step fails closed when its side-effect result cannot be persisted", async () => {
  const store = createControlledStore({ failOnSaves: [3] });
  let calls = 0;
  const tool = {
    name: "side_effect",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async invoke() {
      calls += 1;
      return { status: "completed" };
    },
  };
  const first = createGoalController({ tools: [tool], sessionStore: store, verificationTasks: [] });
  const started = first.start({ goal: "Fail closed after an uncommitted side effect" });

  const result = await first.step({ sessionId: started.sessionId, tool: "side_effect", input: {} });
  assert.equal(result.status, "persistence_error");
  assert.equal(result.mustContinue, false);
  assert.equal(calls, 1);

  const restarted = createGoalController({ tools: [tool], sessionStore: store, verificationTasks: [] });
  assert.equal(restarted.status(started.sessionId).status, "failed");
  const replay = await restarted.step({ sessionId: started.sessionId, tool: "side_effect", input: {} });
  assert.equal(replay.status, "already_terminal");
  assert.equal(calls, 1, "restart must not replay an uncertain side effect");
});
