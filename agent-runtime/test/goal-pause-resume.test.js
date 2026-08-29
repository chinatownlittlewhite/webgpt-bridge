import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoalController } from "../src/goal-controller.js";
import { createFileGoalSessionStore, createMemoryGoalSessionStore } from "../src/goal-store.js";
import { INTERNAL_STATE_DIR } from "../src/workspace.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

function makeTool(name, inputSchema, invoke) {
  return { name, inputSchema, invoke };
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
  };
}

function storedSession({ id, status = "paused", cwd = ".", updatedAt = Date.now(), goal = id }) {
  return {
    id,
    goal,
    cwd,
    status,
    acceptanceCriteria: [],
    maxSteps: 50,
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    createdAt: updatedAt - 1,
    updatedAt,
    steps: 0,
    toolCalls: 0,
    activeElapsedMs: 0,
    history: [],
    verified: false,
    lastFeedback: null,
    repeatedActionHash: null,
    repeatedActionCount: 0,
    pendingApprovalHash: null,
    ...(status === "paused" ? {
      pause: {
        summary: "checkpoint",
        nextAction: "resume explicitly",
        reason: "assistant turn boundary",
        pausedAt: updatedAt,
      },
    } : {}),
  };
}

test("active goal can pause and resume without losing identity, history, budget, cwd, criteria, or recovery metadata", async () => {
  const noop = makeTool("noop", emptyObjectSchema, async () => ({ status: "completed" }));
  const controller = createGoalController({ tools: [noop], verificationTasks: [] });
  const started = controller.start({
    goal: "Cross-turn resumable work",
    cwd: "project-a",
    acceptanceCriteria: ["resume safely"],
    maxSteps: 20,
    maxToolCalls: 30,
  });
  await controller.step({ sessionId: started.sessionId, tool: "noop", input: {} });
  const beforePause = controller.status(started.sessionId);

  const paused = await controller.pause({
    sessionId: started.sessionId,
    summary: "Finished the current assistant turn safely",
    nextAction: "Continue the implementation after an explicit @macmini request",
    reason: "assistant turn boundary",
  });

  assert.equal(paused.status, "paused");
  assert.equal(paused.mustContinue, false);
  assert.equal(paused.sessionId, started.sessionId);
  assert.equal(paused.cwd, "project-a");
  assert.deepEqual(paused.acceptanceCriteria, ["resume safely"]);
  assert.deepEqual(paused.budget, beforePause.budget, "pause must not reset or consume Goal work budget");
  assert.equal(paused.pause.summary, "Finished the current assistant turn safely");
  assert.equal(paused.pause.nextAction, "Continue the implementation after an explicit @macmini request");
  assert.equal(paused.pause.reason, "assistant turn boundary");
  assert.equal(typeof paused.pause.pausedAt, "number");
  assert.deepEqual(paused.history.slice(0, beforePause.history.length), beforePause.history);

  const resumed = await controller.resume(started.sessionId);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.mustContinue, true);
  assert.equal(resumed.sessionId, started.sessionId);
  assert.equal(resumed.goal, "Cross-turn resumable work");
  assert.equal(resumed.cwd, "project-a");
  assert.deepEqual(resumed.acceptanceCriteria, ["resume safely"]);
  assert.deepEqual(resumed.budget, beforePause.budget, "resume must preserve consumed budget");
  assert.deepEqual(resumed.pause, paused.pause, "recovery metadata remains available after resume");
  assert.ok(resumed.history.some((event) => event.type === "goal_paused"));
  assert.ok(resumed.history.some((event) => event.type === "goal_resumed"));
});

test("goal_finish cannot turn a safely paused Goal into a persistence failure", async () => {
  const store = createMemoryGoalSessionStore();
  const controller = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });
  const started = controller.start({ goal: "Pause wins over a stale finish" });
  const paused = await controller.pause({ sessionId: started.sessionId, reason: "turn boundary" });
  assert.equal(paused.status, "paused");

  const staleFinish = await controller.finish({ sessionId: started.sessionId, summary: "stale completion" });

  assert.equal(staleFinish.status, "paused");
  assert.equal(staleFinish.mustContinue, false);
  assert.equal(controller.status(started.sessionId).status, "paused");
  assert.equal(store.loadAll().find((entry) => entry.id === started.sessionId)?.status, "paused");
});

test("goal_finish preserves already-terminal semantics instead of reporting persistence_error", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  const started = controller.start({ goal: "Terminal finish stays terminal" });
  await controller.cancel(started.sessionId);

  const result = await controller.finish({ sessionId: started.sessionId, summary: "stale finish" });

  assert.equal(result.status, "already_terminal");
  assert.equal(result.mustContinue, false);
  assert.equal(result.session.status, "canceled");
});

test("goal_resume only accepts paused sessions", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  const active = controller.start({ goal: "still active" });
  const activeResume = await controller.resume(active.sessionId);
  assert.equal(activeResume.status, "not_paused");
  assert.equal(activeResume.mustContinue, true);
  assert.equal(controller.status(active.sessionId).status, "active");

  const completed = controller.start({ goal: "already complete" });
  await controller.finish({ sessionId: completed.sessionId, summary: "done" });
  const completedResume = await controller.resume(completed.sessionId);
  assert.equal(completedResume.status, "already_terminal");
  assert.equal(completedResume.mustContinue, false);

  const canceled = controller.start({ goal: "already canceled" });
  await controller.cancel(canceled.sessionId);
  const canceledResume = await controller.resume(canceled.sessionId);
  assert.equal(canceledResume.status, "already_terminal");
  assert.equal(canceledResume.mustContinue, false);
});

test("paused goal is persisted and resumes after controller restart", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-pause-restart-"));
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  try {
    const firstStore = createFileGoalSessionStore({ workspace });
    const first = createGoalController({ workspace, tools: [], sessionStore: firstStore, verificationTasks: [] });
    const started = first.start({
      goal: "Resume after agent restart",
      cwd: "project",
      acceptanceCriteria: ["persist pause"],
    });
    const paused = await first.pause({
      sessionId: started.sessionId,
      summary: "restart checkpoint",
      nextAction: "resume after reconnect",
      reason: "connector restart",
    });
    assert.equal(paused.status, "paused");
    assert.equal(firstStore.loadAll().find((entry) => entry.id === started.sessionId)?.status, "paused");

    const second = createGoalController({
      workspace,
      tools: [],
      sessionStore: createFileGoalSessionStore({ workspace }),
      verificationTasks: [],
    });
    const restored = second.status(started.sessionId);
    assert.equal(restored.status, "paused");
    assert.equal(restored.mustContinue, false);
    assert.equal(restored.pause.nextAction, "resume after reconnect");
    const resumed = await second.resume(started.sessionId);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.mustContinue, true);
    assert.equal(resumed.sessionId, started.sessionId);
    assert.equal(resumed.cwd, "project");
    assert.deepEqual(resumed.acceptanceCriteria, ["persist pause"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("goal_list returns only bounded paused sessions in deterministic newest-first order and supports exact cwd filtering", () => {
  const store = createMemoryGoalSessionStore();
  const now = Date.now();
  store.save(storedSession({ id: "paused_old", cwd: "project-a", updatedAt: now - 3000, goal: "old goal" }));
  store.save(storedSession({ id: "paused_new_b", cwd: "project-b", updatedAt: now - 1000, goal: "new goal B" }));
  store.save(storedSession({ id: "paused_new_a", cwd: "project-a", updatedAt: now - 1000, goal: "new goal A" }));
  store.save(storedSession({ id: "active_hidden", status: "active", cwd: "project-a", updatedAt: now, goal: "active goal" }));
  const controller = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });

  const listed = controller.list({ limit: 2 });
  assert.equal(listed.status, "completed");
  assert.equal(listed.sessions.length, 2);
  assert.deepEqual(listed.sessions.map((entry) => entry.sessionId), ["paused_new_a", "paused_new_b"]);
  assert.deepEqual(Object.keys(listed.sessions[0]).sort(), ["cwd", "goal", "sessionId", "status", "updatedAt"]);
  assert.equal(listed.hasMore, true);

  const filtered = controller.list({ cwd: "project-a", limit: 10 });
  assert.deepEqual(filtered.sessions.map((entry) => entry.sessionId), ["paused_new_a", "paused_old"]);
  assert.ok(filtered.sessions.every((entry) => entry.cwd === "project-a" && entry.status === "paused"));
});

test("goal_pause reclaims running processes owned by that Goal and never targets another Goal", async () => {
  const inventories = new Map();
  const kills = [];
  const processList = makeTool("process_list", emptyObjectSchema, async (_input, trustedContext = {}) => ({
    processes: inventories.get(trustedContext.goalSessionId) ?? [],
  }));
  const processKill = makeTool("process_kill", {
    type: "object",
    additionalProperties: false,
    required: ["processId"],
    properties: { processId: { type: "string", minLength: 1 }, force: { type: "boolean" } },
  }, async (input, trustedContext = {}) => {
    kills.push({ ...input, goalSessionId: trustedContext.goalSessionId });
    return { status: "kill_requested", processId: input.processId };
  });
  const controller = createGoalController({ tools: [processList, processKill], verificationTasks: [] });
  const goalA = controller.start({ goal: "owner A" });
  const goalB = controller.start({ goal: "owner B" });
  inventories.set(goalA.sessionId, [
    { processId: "a-running", status: "running" },
    { processId: "a-done", status: "exited" },
  ]);
  inventories.set(goalB.sessionId, [{ processId: "b-running", status: "running" }]);

  const paused = await controller.pause({ sessionId: goalA.sessionId, reason: "turn boundary" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.mustContinue, false);
  assert.deepEqual(kills, [{ processId: "a-running", force: true, goalSessionId: goalA.sessionId }]);
  assert.deepEqual(paused.processCleanup, {
    status: "completed",
    runningFound: 1,
    attempted: 1,
    killed: 1,
    failed: 0,
    failures: [],
  });
  assert.equal(controller.status(goalB.sessionId).status, "active");
});

test("new controller still hydrates legacy v1-style sessions that have no pause metadata", () => {
  const store = createMemoryGoalSessionStore();
  const now = Date.now();
  store.save(storedSession({ id: "legacy_active", status: "active", updatedAt: now, goal: "legacy active" }));
  const controller = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });
  const restored = controller.status("legacy_active");
  assert.equal(restored.status, "active");
  assert.equal(restored.mustContinue, true);
  assert.equal(restored.goal, "legacy active");
  assert.equal(restored.pause, null);
});

test("legacy version-1 persisted Goal files remain readable after paused-state support is added", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-legacy-v1-"));
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  try {
    const goalsDir = path.join(workspace, INTERNAL_STATE_DIR, "goals");
    fs.mkdirSync(goalsDir, { recursive: true });
    const raw = storedSession({
      id: "legacy_file_v1",
      status: "active",
      cwd: "project",
      updatedAt: Date.now(),
      goal: "legacy file goal",
    });
    fs.writeFileSync(
      path.join(goalsDir, "legacy_file_v1.json"),
      `${JSON.stringify({ version: 1, session: raw }, null, 2)}\n`,
      "utf8",
    );

    const controller = createGoalController({
      workspace,
      tools: [],
      sessionStore: createFileGoalSessionStore({ workspace }),
      verificationTasks: [],
    });
    const restored = controller.status("legacy_file_v1");
    assert.equal(restored.status, "active");
    assert.equal(restored.mustContinue, true);
    assert.equal(restored.cwd, "project");
    assert.equal(restored.pause, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("goal_pause refuses to report a safe pause when an owned process cannot be reclaimed", async () => {
  const processList = makeTool("process_list", emptyObjectSchema, async () => ({
    processes: [{ processId: "stuck", status: "running" }],
  }));
  const processKill = makeTool("process_kill", {
    type: "object",
    additionalProperties: false,
    required: ["processId"],
    properties: { processId: { type: "string", minLength: 1 }, force: { type: "boolean" } },
  }, async () => ({ status: "kill_failed", processId: "stuck" }));
  const controller = createGoalController({ tools: [processList, processKill], verificationTasks: [] });
  const started = controller.start({ goal: "Do not leak a process across pause" });

  const result = await controller.pause({ sessionId: started.sessionId, reason: "turn boundary" });

  assert.equal(result.status, "continue_required");
  assert.equal(result.mustContinue, true);
  assert.equal(result.processCleanup.status, "partial");
  const current = controller.status(started.sessionId);
  assert.equal(current.status, "active");
  assert.equal(current.mustContinue, true);
  assert.equal(current.pause, null);
});

test("goal_pause never reports paused when the resulting state cannot be durably persisted", async () => {
  const store = createControlledStore({ failOnSaves: [3] });
  const controller = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });
  const started = controller.start({ goal: "Pause only after durable persistence" });

  const result = await controller.pause({
    sessionId: started.sessionId,
    summary: "checkpoint",
    nextAction: "resume later",
    reason: "turn boundary",
  });

  assert.equal(result.status, "persistence_error");
  assert.equal(result.mustContinue, false);
  assert.notEqual(result.status, "paused");
  assert.equal(controller.status(started.sessionId).status, "failed");

  const restarted = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });
  assert.equal(restarted.status(started.sessionId).status, "failed");
});

test("goal_resume preserves terminal and blocked compatibility for non-paused stored states", async () => {
  const store = createMemoryGoalSessionStore();
  const now = Date.now();
  for (const status of ["failed", "stalled", "budget_exhausted"]) {
    store.save(storedSession({ id: `terminal_${status}`, status, updatedAt: now, goal: status }));
  }
  store.save(storedSession({ id: "blocked", status: "blocked_approval", updatedAt: now, goal: "blocked" }));
  const controller = createGoalController({ tools: [], sessionStore: store, verificationTasks: [] });

  for (const status of ["failed", "stalled", "budget_exhausted"]) {
    const result = await controller.resume(`terminal_${status}`);
    assert.equal(result.status, "already_terminal");
    assert.equal(result.mustContinue, false);
    assert.equal(controller.status(`terminal_${status}`).status, status);
  }
  const blocked = await controller.resume("blocked");
  assert.equal(blocked.status, "not_paused");
  assert.equal(blocked.mustContinue, false);
  assert.equal(controller.status("blocked").status, "blocked_approval");
});

test("cross-turn Goal views have a strict response budget even when history and project instructions are large", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-public-budget-"));
  try {
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), `# Instructions\n${"x".repeat(31_000)}\n`, "utf8");
    const noisy = makeTool("noisy", {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: { index: { type: "integer", minimum: 0 } },
    }, async () => ({
      status: "completed",
      payload: "y".repeat(15_000),
    }));
    const controller = createGoalController({ workspace, tools: [noisy], verificationTasks: [] });
    const started = controller.start({
      goal: `large recovery goal ${"g".repeat(12_000)}`,
      acceptanceCriteria: Array.from({ length: 12 }, (_, index) => `criterion-${index}-${"c".repeat(2_000)}`),
      maxSteps: 40,
      maxToolCalls: 40,
    });
    for (let index = 0; index < 20; index += 1) {
      const stepped = await controller.step({ sessionId: started.sessionId, tool: "noisy", input: { index } });
      assert.equal(stepped.status, "continue_required");
    }

    const status = controller.status(started.sessionId);
    assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 64_000, "goal_status must stay below the cross-turn response budget");
    assert.ok(status.historyOmitted >= 0);
    assert.ok(status.history.length <= 12);
    assert.ok(Buffer.byteLength(status.projectContext.instructions) <= 8_500);

    const paused = await controller.pause({
      sessionId: started.sessionId,
      summary: "s".repeat(20_000),
      nextAction: "n".repeat(8_000),
      reason: "r".repeat(8_000),
    });
    assert.equal(paused.status, "paused");
    assert.ok(Buffer.byteLength(JSON.stringify(paused)) <= 64_000, "goal_pause must stay below the cross-turn response budget");

    const resumed = await controller.resume(started.sessionId);
    assert.equal(resumed.status, "active");
    assert.ok(Buffer.byteLength(JSON.stringify(resumed)) <= 64_000, "goal_resume must stay below the cross-turn response budget");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
