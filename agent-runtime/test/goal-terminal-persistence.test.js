import test from "node:test";
import assert from "node:assert/strict";
import { createGoalController } from "../src/goal-controller.js";

function createStatusFailingStore(failStatuses = []) {
  const values = new Map();
  const failures = new Set(failStatuses);
  return {
    kind: "status-failing",
    persistent: true,
    loadAll() {
      return [...values.values()].map((value) => structuredClone(value));
    },
    save(session) {
      if (failures.has(session.status)) {
        throw new Error(`controlled ${session.status} persistence failure`);
      }
      values.set(session.id, structuredClone(session));
    },
    remove(sessionId) {
      values.delete(sessionId);
    },
  };
}

test("goal_finish never reports completed when the terminal state cannot be persisted", async () => {
  const store = createStatusFailingStore(["completed"]);
  let verificationCalls = 0;
  const projectTask = {
    name: "run_project_task",
    async invoke() {
      verificationCalls += 1;
      return { status: "completed", exitCode: 0 };
    },
  };
  const first = createGoalController({
    tools: [projectTask],
    sessionStore: store,
    verificationTasks: ["test"],
  });
  const started = first.start({ goal: "Persist verified completion" });

  const result = await first.finish({
    sessionId: started.sessionId,
    summary: "verified",
  });

  assert.equal(verificationCalls, 1);
  assert.equal(result.status, "persistence_error");
  assert.equal(result.mustContinue, false);

  const restarted = createGoalController({
    tools: [projectTask],
    sessionStore: store,
    verificationTasks: ["test"],
  });
  const recovered = restarted.status(started.sessionId);
  assert.equal(recovered.status, "failed");
  assert.match(recovered.lastFeedback, /interrupted|persist/i);
});

test("goal_cancel never reports canceled when the terminal state cannot be persisted", async () => {
  const store = createStatusFailingStore(["canceled"]);
  const first = createGoalController({
    tools: [],
    sessionStore: store,
    verificationTasks: [],
  });
  const started = first.start({ goal: "Persist cancellation" });

  const result = await first.cancel(started.sessionId);

  assert.equal(result.status, "persistence_error");
  assert.equal(result.mustContinue, false);

  const restarted = createGoalController({
    tools: [],
    sessionStore: store,
    verificationTasks: [],
  });
  const recovered = restarted.status(started.sessionId);
  assert.equal(recovered.status, "failed");
  assert.match(recovered.lastFeedback, /interrupted|persist/i);
});
